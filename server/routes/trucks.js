const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

const VALID_STATUSES = ['active', 'maintenance', 'inactive', 'retired'];

// OD-4: broad operational read access (truck data isn't HR-sensitive the
// way Employees was) — but zone-scoped for gudoomiye/zone_accountant, and
// writes stay admin/gudoomiye only, same pattern as every prior module.
const VIEW_ROLES = ['admin', 'cashier', 'collector', 'gudoomiye', 'zone_accountant'];
const WRITE_ROLES = ['admin', 'gudoomiye'];
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];

function parseStrictId(raw) {
  if (!/^\d+$/.test(raw)) return null;
  return parseInt(raw, 10);
}

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

async function assertZoneWritable(user, zoneId) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return true;
  if (zoneId === null || zoneId === undefined) return true; // company-wide truck, no zone to check
  const myZoneId = await resolveUserZoneId(user);
  return myZoneId !== null && myZoneId === zoneId;
}

// OD-2: driver_id must reference an employee whose employee_type is
// 'driver'; collector_id must reference employee_type 'collector'. Resolved
// by employee ID only — never by name — per explicit instruction.
async function validateEmployeeRole(employeeId, requiredType) {
  if (employeeId === null || employeeId === undefined) return { ok: true };
  const r = await pool.query('SELECT id, employee_type, status FROM employees WHERE id = $1', [employeeId]);
  if (r.rows.length === 0) return { ok: false, error: `${requiredType}_id does not reference an existing employee.` };
  if (r.rows[0].employee_type !== requiredType) {
    return { ok: false, error: `Employee #${employeeId} is not an employee_type "${requiredType}" and cannot be assigned as ${requiredType}.` };
  }
  return { ok: true };
}

function validateTruckInput(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.plate_number !== undefined) {
    if (typeof body.plate_number !== 'string' || body.plate_number.trim().length < 1 || body.plate_number.trim().length > 50) {
      errors.push('plate_number is required and must be 1-50 characters.');
    } else {
      out.plate_number = body.plate_number.trim().toUpperCase();
    }
  }
  if (body.model !== undefined) out.model = body.model ? String(body.model).trim().slice(0, 100) : null;
  if (body.capacity !== undefined) {
    if (body.capacity !== null && (!Number.isInteger(body.capacity) || body.capacity < 0)) {
      errors.push('capacity must be a non-negative integer or null.');
    } else {
      out.capacity = body.capacity;
    }
  }
  if (body.zone_id !== undefined) {
    if (body.zone_id === null) {
      out.zone_id = null;
    } else {
      const zid = parseStrictId(String(body.zone_id));
      if (zid === null) errors.push('zone_id must be a valid zone or null.');
      else out.zone_id = zid;
    }
  }
  if (body.driver_id !== undefined) {
    if (body.driver_id === null) {
      out.driver_id = null;
    } else {
      const did = parseStrictId(String(body.driver_id));
      if (did === null) errors.push('driver_id must be a positive integer or null.');
      else out.driver_id = did;
    }
  }
  if (body.collector_id !== undefined) {
    if (body.collector_id === null) {
      out.collector_id = null;
    } else {
      const cid = parseStrictId(String(body.collector_id));
      if (cid === null) errors.push('collector_id must be a positive integer or null.');
      else out.collector_id = cid;
    }
  }
  if (body.insurance_expiry !== undefined) {
    if (body.insurance_expiry !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.insurance_expiry)) errors.push('insurance_expiry must be YYYY-MM-DD or null.');
    else out.insurance_expiry = body.insurance_expiry;
  }
  if (body.registration_expiry !== undefined) {
    if (body.registration_expiry !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.registration_expiry)) errors.push('registration_expiry must be YYYY-MM-DD or null.');
    else out.registration_expiry = body.registration_expiry;
  }
  if (body.road_tax_expiry !== undefined) {
    if (body.road_tax_expiry !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.road_tax_expiry)) errors.push('road_tax_expiry must be YYYY-MM-DD or null.');
    else out.road_tax_expiry = body.road_tax_expiry;
  }
  if (body.notes !== undefined) {
    const notes = body.notes ? String(body.notes) : '';
    if (notes.length > 2000) errors.push('notes must be 2000 characters or fewer.');
    else out.notes = notes || null;
  }
  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}.`);
    else out.status = body.status;
  }

  return { errors, data: out };
}

router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const where = [];
    const params = [];
    if (myZoneId !== null) {
      params.push(myZoneId);
      // A zone-scoped viewer sees their own zone's trucks PLUS any
      // company-wide (null-zone) truck — a strict `zone_id = $1` would
      // silently hide company-wide trucks from every zone-scoped role,
      // inconsistent with how a single truck's own detail route already
      // treats a null zone_id as visible (found during this module's own
      // QA, fixed before it shipped rather than after).
      where.push(`(trucks.zone_id = $${params.length} OR trucks.zone_id IS NULL)`);
    }
    const status = req.query.status;
    if (status === 'retired') where.push(`trucks.status = 'retired'`);
    else if (status === 'all') { /* no filter */ }
    else if (status && VALID_STATUSES.includes(status)) {
      params.push(status);
      where.push(`trucks.status = $${params.length}`);
    } else if (!status) {
      where.push(`trucks.status != 'retired'`);
    } else {
      return res.status(400).json({ error: { message: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(', ')}, or "all".`, code: 'VALIDATION' } });
    }
    if (req.query.zone_id) {
      const zid = parseStrictId(req.query.zone_id);
      if (zid === null) return res.status(400).json({ error: { message: 'Invalid zone_id filter.', code: 'VALIDATION' } });
      if (myZoneId !== null && zid !== myZoneId) {
        return res.status(403).json({ error: { message: 'You do not have access to that zone.', code: 'FORBIDDEN' } });
      }
      params.push(zid);
      where.push(`trucks.zone_id = $${params.length}`);
    }
    if (req.query.driver_id) {
      const did = parseStrictId(req.query.driver_id);
      if (did === null) return res.status(400).json({ error: { message: 'Invalid driver_id filter.', code: 'VALIDATION' } });
      params.push(did);
      where.push(`trucks.driver_id = $${params.length}`);
    }
    if (req.query.collector_id) {
      const cid = parseStrictId(req.query.collector_id);
      if (cid === null) return res.status(400).json({ error: { message: 'Invalid collector_id filter.', code: 'VALIDATION' } });
      params.push(cid);
      where.push(`trucks.collector_id = $${params.length}`);
    }
    if (req.query.q) {
      params.push(`%${req.query.q.trim()}%`);
      where.push(`trucks.plate_number ILIKE $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM trucks ${whereSql}`, params);
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT trucks.*, zones.name AS zone_name, d.name AS driver_name, c.name AS collector_name
       FROM trucks
       LEFT JOIN zones ON trucks.zone_id = zones.id
       LEFT JOIN employees d ON trucks.driver_id = d.id
       LEFT JOIN employees c ON trucks.collector_id = c.id
       ${whereSql} ORDER BY trucks.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: result.rows, meta: { total: countResult.rows[0].total, limit, offset } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list trucks.', code: 'INTERNAL' } });
  }
});

router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid truck id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query(
      `SELECT trucks.*, zones.name AS zone_name, d.name AS driver_name, c.name AS collector_name
       FROM trucks
       LEFT JOIN zones ON trucks.zone_id = zones.id
       LEFT JOIN employees d ON trucks.driver_id = d.id
       LEFT JOIN employees c ON trucks.collector_id = c.id
       WHERE trucks.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Truck not found.', code: 'NOT_FOUND' } });

    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && result.rows[0].zone_id !== null && result.rows[0].zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this truck.', code: 'FORBIDDEN' } });
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load truck.', code: 'INTERNAL' } });
  }
});

router.post('/', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const { errors, data } = validateTruckInput(req.body, { partial: false });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });

  if (!(await assertZoneWritable(req.user, data.zone_id ?? null))) {
    return res.status(403).json({ error: { message: 'You cannot create a truck outside your assigned zone.', code: 'FORBIDDEN' } });
  }

  const driverCheck = await validateEmployeeRole(data.driver_id, 'driver');
  if (!driverCheck.ok) return res.status(400).json({ error: { message: driverCheck.error, code: 'VALIDATION' } });
  const collectorCheck = await validateEmployeeRole(data.collector_id, 'collector');
  if (!collectorCheck.ok) return res.status(400).json({ error: { message: collectorCheck.error, code: 'VALIDATION' } });

  try {
    const result = await pool.query(
      `INSERT INTO trucks
        (plate_number, model, capacity, zone_id, driver_id, collector_id, status,
         insurance_expiry, registration_expiry, road_tax_expiry, notes)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'active'),$8,$9,$10,$11)
       RETURNING *`,
      [data.plate_number, data.model ?? null, data.capacity ?? null, data.zone_id ?? null,
       data.driver_id ?? null, data.collector_id ?? null, data.status ?? null,
       data.insurance_expiry ?? null, data.registration_expiry ?? null, data.road_tax_expiry ?? null, data.notes ?? null]
    );
    const truck = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'truck.create', entityType: 'truck', entityId: truck.id, before: null, after: truck });
    res.status(201).json({ data: truck });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: { message: `plate_number "${data.plate_number}" is already in use.`, code: 'DUPLICATE' } });
    }
    if (err.code === '23503') {
      return res.status(400).json({ error: { message: 'zone_id, driver_id, or collector_id does not reference an existing record.', code: 'VALIDATION' } });
    }
    res.status(500).json({ error: { message: 'Failed to create truck.', code: 'INTERNAL' } });
  }
});

router.put('/:id', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid truck id.', code: 'VALIDATION' } });

  const { errors, data } = validateTruckInput(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  if (Object.keys(data).length === 0) return res.status(400).json({ error: { message: 'No valid fields provided to update.', code: 'VALIDATION' } });

  // Status transitions belong on the dedicated /:id/status endpoint, same
  // reasoning as every prior module — kept out of the general edit route.
  if (data.status !== undefined) {
    return res.status(400).json({ error: { message: 'Use PUT /:id/status to change truck lifecycle status.', code: 'VALIDATION' } });
  }

  try {
    const existing = await pool.query('SELECT * FROM trucks WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: { message: 'Truck not found.', code: 'NOT_FOUND' } });
    const current = existing.rows[0];

    if (!(await assertZoneWritable(req.user, current.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this truck.', code: 'FORBIDDEN' } });
    }
    if (data.zone_id !== undefined && !(await assertZoneWritable(req.user, data.zone_id))) {
      return res.status(403).json({ error: { message: 'You cannot transfer a truck into a zone you do not manage.', code: 'FORBIDDEN' } });
    }

    if (data.driver_id !== undefined) {
      const driverCheck = await validateEmployeeRole(data.driver_id, 'driver');
      if (!driverCheck.ok) return res.status(400).json({ error: { message: driverCheck.error, code: 'VALIDATION' } });
    }
    if (data.collector_id !== undefined) {
      const collectorCheck = await validateEmployeeRole(data.collector_id, 'collector');
      if (!collectorCheck.ok) return res.status(400).json({ error: { message: collectorCheck.error, code: 'VALIDATION' } });
    }

    const fields = Object.keys(data);
    const setSql = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = fields.map((f) => data[f]);
    values.push(id);

    const result = await pool.query(
      `UPDATE trucks SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`,
      values
    );
    const truck = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'truck.update', entityType: 'truck', entityId: truck.id, before: current, after: truck });
    res.json({ data: truck });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: { message: `plate_number "${data.plate_number}" is already in use.`, code: 'DUPLICATE' } });
    }
    if (err.code === '23503') {
      return res.status(400).json({ error: { message: 'zone_id, driver_id, or collector_id does not reference an existing record.', code: 'VALIDATION' } });
    }
    res.status(500).json({ error: { message: 'Failed to update truck.', code: 'INTERNAL' } });
  }
});

// PUT /api/v2/trucks/:id/status — dedicated lifecycle endpoint.
//
// "Retired" is a FROZEN, permanent terminal state (confirmed business rule,
// Module 4 final review): Retired -> Active/Maintenance/Inactive are all
// explicitly disallowed. If a retired truck ever needs to return to
// service, that is a new, separate business decision to be made in the
// future — not something this endpoint permits today.
router.put('/:id/status', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid truck id.', code: 'VALIDATION' } });
  const status = req.body?.status;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: { message: `status must be one of: ${VALID_STATUSES.join(', ')}.`, code: 'VALIDATION' } });
  }
  try {
    const existing = await pool.query('SELECT * FROM trucks WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: { message: 'Truck not found.', code: 'NOT_FOUND' } });
    const current = existing.rows[0];

    if (!(await assertZoneWritable(req.user, current.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this truck.', code: 'FORBIDDEN' } });
    }
    if (current.status === 'retired' && status !== 'retired') {
      return res.status(409).json({ error: { message: 'This truck is Retired, a permanent status. Returning a retired truck to service requires a separate, future business decision — it cannot be done from here.', code: 'RETIRED_TERMINAL' } });
    }

    const result = await pool.query(
      `UPDATE trucks SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [status, id]
    );
    const truck = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'truck.status_change', entityType: 'truck', entityId: truck.id, before: { status: current.status }, after: { status: truck.status } });
    res.json({ data: truck });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update truck status.', code: 'INTERNAL' } });
  }
});

// DELETE deliberately not implemented — Retired is the terminal lifecycle
// state and already satisfies "permanently removed from active fleet
// operations, history preserved," per the approved OD-3 definitions. Same
// pattern as Zones/Customers/Employees — no module in V2 has a hard-delete
// path. No dependent tables (fuel/maintenance/collection logs) exist yet in
// the V2 database to even inspect for cascade risk — those are future
// modules — so this isn't a gap being silently deferred, it's the
// consistent, already-established V2 lifecycle pattern applied here too.

module.exports = router;
