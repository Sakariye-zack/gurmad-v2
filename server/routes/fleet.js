const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getExpiringDocuments } = require('../lib/fleetCalculations');

const router = express.Router();

// Master Functional Completion Program — Phase 2: Fleet Management.
// Same zone-scope pattern as trucks.js (reused verbatim, not
// reinvented) — current access always resolves against trucks.zone_id
// live, never zone_snapshot_id (Spec §7).
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const VIEW_ROLES = ['admin', 'cashier', 'collector', 'gudoomiye', 'zone_accountant'];
const CREATE_ROLES = ['admin', 'gudoomiye'];

function parseStrictId(raw) {
  if (!/^\d+$/.test(String(raw ?? ''))) return null;
  return parseInt(raw, 10);
}

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

// Truck existence + current-zone access check, shared by every write
// and detail route below — mirrors trucks.js's own ordering exactly:
// existence (404) is checked before zone access (403), never the
// reverse, to avoid leaking which failure occurred.
async function loadTruckWithAccessCheck(user, truckId) {
  const r = await pool.query('SELECT id, zone_id, status FROM trucks WHERE id = $1', [truckId]);
  if (r.rows.length === 0) return { error: { status: 404, message: 'Truck not found.', code: 'NOT_FOUND' } };
  const truck = r.rows[0];
  const myZoneId = await resolveUserZoneId(user);
  if (myZoneId !== null && truck.zone_id !== myZoneId) {
    return { error: { status: 403, message: 'You do not have access to this truck.', code: 'FORBIDDEN' } };
  }
  return { truck };
}

// ---------- Maintenance ----------

router.post('/maintenance', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  const { truck_id, description, cost, next_service_date, provider } = req.body;
  const truckId = parseStrictId(truck_id);
  if (truckId === null) return res.status(400).json({ error: { message: 'truck_id is required.', code: 'VALIDATION' } });
  const desc = (description || '').trim();
  if (!desc) return res.status(400).json({ error: { message: 'description is required.', code: 'VALIDATION' } });
  const costVal = parseFloat(cost);
  if (isNaN(costVal) || costVal <= 0) return res.status(400).json({ error: { message: 'cost must be a positive number.', code: 'VALIDATION' } });
  if (next_service_date !== undefined && next_service_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(next_service_date)) {
    return res.status(400).json({ error: { message: 'next_service_date must be YYYY-MM-DD or null.', code: 'VALIDATION' } });
  }

  try {
    const access = await loadTruckWithAccessCheck(req.user, truckId);
    if (access.error) return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } });

    const inserted = await pool.query(
      `INSERT INTO truck_maintenance_records (truck_id, description, cost, next_service_date, provider, zone_snapshot_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [truckId, desc, costVal, next_service_date || null, provider || null, access.truck.zone_id, req.user.id]
    );
    const record = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'truck_maintenance_record.create', entityType: 'truck_maintenance_record', entityId: record.id, before: null, after: record });
    res.status(201).json({ data: record });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to create maintenance record.', code: 'INTERNAL' } });
  }
});

router.get('/maintenance', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const params = [];
    const filters = [];
    if (myZoneId !== null) { params.push(myZoneId); filters.push(`t.zone_id = $${params.length}`); }
    if (req.query.truck_id) {
      const tid = parseStrictId(req.query.truck_id);
      if (tid === null) return res.status(400).json({ error: { message: 'Invalid truck_id.', code: 'VALIDATION' } });
      params.push(tid); filters.push(`m.truck_id = $${params.length}`);
    }
    if (req.query.date_from) { params.push(req.query.date_from); filters.push(`m.created_at >= $${params.length}`); }
    if (req.query.date_to) { params.push(req.query.date_to); filters.push(`m.created_at <= $${params.length}`); }
    if (req.query.upcoming_service === 'true') { filters.push(`m.next_service_date >= CURRENT_DATE`); }
    if (req.query.q) {
      const q = req.query.q.trim();
      if (q.length >= 2) {
        params.push(`%${q}%`);
        const i = params.length;
        filters.push(`(m.description ILIKE $${i} OR m.provider ILIKE $${i})`);
      }
    }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const orderSql = req.query.upcoming_service === 'true' ? 'ORDER BY m.next_service_date ASC' : 'ORDER BY m.created_at DESC';
    const result = await pool.query(
      `SELECT m.*, t.plate_number FROM truck_maintenance_records m JOIN trucks t ON m.truck_id = t.id ${whereSql} ${orderSql}`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list maintenance records.', code: 'INTERNAL' } });
  }
});

router.get('/maintenance/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid maintenance record id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query(
      `SELECT m.*, t.plate_number, t.zone_id AS truck_zone_id FROM truck_maintenance_records m JOIN trucks t ON m.truck_id = t.id WHERE m.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Maintenance record not found.', code: 'NOT_FOUND' } });
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && result.rows[0].truck_zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this record.', code: 'FORBIDDEN' } });
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load maintenance record.', code: 'INTERNAL' } });
  }
});

// ---------- Fuel ----------

router.post('/fuel', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  const { truck_id, liters, cost, odometer_reading, record_date, notes } = req.body;
  const truckId = parseStrictId(truck_id);
  if (truckId === null) return res.status(400).json({ error: { message: 'truck_id is required.', code: 'VALIDATION' } });
  const litersVal = parseFloat(liters);
  if (isNaN(litersVal) || litersVal <= 0) return res.status(400).json({ error: { message: 'liters must be a positive number.', code: 'VALIDATION' } });
  const costVal = parseFloat(cost);
  if (isNaN(costVal) || costVal <= 0) return res.status(400).json({ error: { message: 'cost must be a positive number.', code: 'VALIDATION' } });
  let odometerVal = null;
  if (odometer_reading !== undefined && odometer_reading !== null && odometer_reading !== '') {
    odometerVal = parseInt(odometer_reading, 10);
    if (isNaN(odometerVal) || odometerVal < 0) return res.status(400).json({ error: { message: 'odometer_reading must be a non-negative integer.', code: 'VALIDATION' } });
  }
  if (record_date !== undefined && record_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(record_date)) {
    return res.status(400).json({ error: { message: 'record_date must be YYYY-MM-DD.', code: 'VALIDATION' } });
  }

  try {
    const access = await loadTruckWithAccessCheck(req.user, truckId);
    if (access.error) return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } });

    // Odometer anomaly check — Spec §5. Advisory only, no lock, no
    // rejection, no stored column (Decision 6).
    let needsReview = false;
    if (odometerVal !== null) {
      const prior = await pool.query(
        `SELECT odometer_reading FROM truck_fuel_records WHERE truck_id = $1 AND odometer_reading IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
        [truckId]
      );
      if (prior.rows.length > 0 && odometerVal < prior.rows[0].odometer_reading) needsReview = true;
    }

    const inserted = await pool.query(
      `INSERT INTO truck_fuel_records (truck_id, liters, cost, odometer_reading, record_date, notes, zone_snapshot_id, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5, CURRENT_DATE),$6,$7,$8) RETURNING *`,
      [truckId, litersVal, costVal, odometerVal, record_date || null, notes || null, access.truck.zone_id, req.user.id]
    );
    const record = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'truck_fuel_record.create', entityType: 'truck_fuel_record', entityId: record.id, before: null, after: record });
    res.status(201).json({ data: { ...record, needs_review: needsReview } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to create fuel record.', code: 'INTERNAL' } });
  }
});

// Computes needs_review per row for list results — recomputed at read
// time (never stored), per Decision 6.
async function annotateNeedsReview(rows) {
  const out = [];
  for (const row of rows) {
    let needsReview = false;
    if (row.odometer_reading !== null) {
      const prior = await pool.query(
        `SELECT odometer_reading FROM truck_fuel_records WHERE truck_id = $1 AND odometer_reading IS NOT NULL AND created_at < $2
         ORDER BY created_at DESC LIMIT 1`,
        [row.truck_id, row.created_at]
      );
      if (prior.rows.length > 0 && row.odometer_reading < prior.rows[0].odometer_reading) needsReview = true;
    }
    out.push({ ...row, needs_review: needsReview });
  }
  return out;
}

router.get('/fuel', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const params = [];
    const filters = [];
    if (myZoneId !== null) { params.push(myZoneId); filters.push(`t.zone_id = $${params.length}`); }
    if (req.query.truck_id) {
      const tid = parseStrictId(req.query.truck_id);
      if (tid === null) return res.status(400).json({ error: { message: 'Invalid truck_id.', code: 'VALIDATION' } });
      params.push(tid); filters.push(`f.truck_id = $${params.length}`);
    }
    if (req.query.date_from) { params.push(req.query.date_from); filters.push(`f.record_date >= $${params.length}`); }
    if (req.query.date_to) { params.push(req.query.date_to); filters.push(`f.record_date <= $${params.length}`); }
    if (req.query.q) {
      const q = req.query.q.trim();
      if (q.length >= 2) { params.push(`%${q}%`); filters.push(`f.notes ILIKE $${params.length}`); }
    }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT f.*, t.plate_number FROM truck_fuel_records f JOIN trucks t ON f.truck_id = t.id ${whereSql} ORDER BY f.created_at DESC`,
      params
    );
    let rows = await annotateNeedsReview(result.rows);
    if (req.query.needs_review === 'true') rows = rows.filter((r) => r.needs_review);
    else if (req.query.needs_review === 'false') rows = rows.filter((r) => !r.needs_review);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list fuel records.', code: 'INTERNAL' } });
  }
});

router.get('/fuel/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid fuel record id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query(
      `SELECT f.*, t.plate_number, t.zone_id AS truck_zone_id FROM truck_fuel_records f JOIN trucks t ON f.truck_id = t.id WHERE f.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Fuel record not found.', code: 'NOT_FOUND' } });
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && result.rows[0].truck_zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this record.', code: 'FORBIDDEN' } });
    }
    const [annotated] = await annotateNeedsReview([result.rows[0]]);
    res.json({ data: annotated });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load fuel record.', code: 'INTERNAL' } });
  }
});

// ---------- Expiry ----------

router.get('/expiry', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    // ?zone_id narrows WITHIN the caller's already-enforced scope only
    // — it can never widen it (Spec §6).
    let effectiveZoneId = myZoneId;
    if (myZoneId === null && req.query.zone_id) {
      const zid = parseStrictId(req.query.zone_id);
      if (zid === null) return res.status(400).json({ error: { message: 'Invalid zone_id.', code: 'VALIDATION' } });
      effectiveZoneId = zid;
    }
    let rows = await getExpiringDocuments({ zoneId: effectiveZoneId, withinDays: 30 });
    if (req.query.status === 'expired' || req.query.status === 'expiring_soon') {
      rows = rows.filter((r) => r.status === req.query.status);
    }
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load expiry data.', code: 'INTERNAL' } });
  }
});

module.exports = router;
