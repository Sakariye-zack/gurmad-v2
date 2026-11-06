const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getExpiringDocuments } = require('../lib/fleetCalculations');
const {
  annotateFuelRows, fuelTotals, getNextMaintenance, currentRate, toUsd, round, gpsKmPerLiter, dateStr,
} = require('../lib/fleetInsights');
const { getTimezone, localParts, shiftDate } = require('../lib/autoBilling');
const { activeWorkWhere, ACTIVE_WORK_FROM } = require('../lib/locationHistory');
const { toCsv } = require('../lib/csvImportExport');
const uploads = require('../lib/fleetUploads');

const router = express.Router();

// Master Functional Completion Program — Phase 2: Fleet Management.
// Same zone-scope pattern as trucks.js (reused verbatim, not
// reinvented) — current access always resolves against trucks.zone_id
// live, never zone_snapshot_id (Spec §7).
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const VIEW_ROLES = ['admin', 'cashier', 'collector', 'gudoomiye', 'zone_accountant'];
const CREATE_ROLES = ['admin', 'gudoomiye'];
const CURRENCIES = ['USD', 'SLSH'];
const MAINT_STATUSES = ['scheduled', 'in_progress', 'completed'];
const MAINT_TRANSITIONS = { scheduled: ['in_progress', 'completed'], in_progress: ['completed'], completed: [] };
const RECEIPT_KINDS = 'JPEG, PNG, WEBP or PDF';

function parseStrictId(raw) {
  if (!/^\d+$/.test(String(raw ?? ''))) return null;
  return parseInt(raw, 10);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const bad = (res, message, status = 400, code = 'VALIDATION') => res.status(status).json({ error: { message, code } });

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
  // Company-wide (no-zone) trucks are visible to zone-scoped roles, same as
  // GET /trucks and the overview.
  if (myZoneId !== null && truck.zone_id !== null && truck.zone_id !== myZoneId) {
    return { error: { status: 403, message: 'You do not have access to this truck.', code: 'FORBIDDEN' } };
  }
  return { truck };
}

// Live status (last seen) is Map-level information: same roles as routes/map.js.
const LIVE_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'];

function optInt(body, key, errors, { min = 0 } = {}) {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) { errors.push(`${key} must be an integer >= ${min}.`); return undefined; }
  return n;
}

function parseParts(raw, errors) {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 50) { errors.push('parts must be an array of at most 50 items.'); return undefined; }
  const out = [];
  for (const p of raw) {
    const name = typeof p?.name === 'string' ? p.name.trim().slice(0, 100) : '';
    const qty = Number(p?.qty);
    const unitCost = Number(p?.unit_cost ?? 0);
    if (!name || !(qty > 0) || !(unitCost >= 0)) { errors.push('Each part needs a name, qty > 0 and unit_cost >= 0.'); return undefined; }
    out.push({ name, qty, unit_cost: unitCost });
  }
  return out;
}
const partsTotal = (parts) => round(parts.reduce((s, p) => s + p.qty * p.unit_cost, 0));

// Optional maintenance fields shared by create and status change.
function parseMaintenanceExtras(body) {
  const errors = [];
  const data = {};
  for (const k of ['next_service_date', 'scheduled_date']) {
    if (body[k] !== undefined) {
      if (body[k] === null || body[k] === '') data[k] = null;
      else if (!isValidDate(body[k])) errors.push(`${k} must be YYYY-MM-DD or null.`);
      else data[k] = body[k];
    }
  }
  for (const [k, min] of [['odometer_at_service', 0], ['next_service_km', 0], ['interval_km', 1], ['interval_days', 1]]) {
    const v = optInt(body, k, errors, { min });
    if (v !== undefined) data[k] = v;
  }
  const parts = parseParts(body.parts, errors);
  if (parts !== undefined) data.parts = parts;
  if (body.currency !== undefined) {
    if (!CURRENCIES.includes(body.currency)) errors.push('currency must be USD or SLSH.');
    else data.currency = body.currency;
  }
  if (body.provider !== undefined) data.provider = body.provider ? String(body.provider).trim().slice(0, 255) : null;
  if (body.cost !== undefined && body.cost !== null && body.cost !== '') {
    const c = parseFloat(body.cost);
    if (Number.isNaN(c) || c < 0) errors.push('cost must be a non-negative number.');
    else data.cost = c;
  }
  return { errors, data };
}

// next_service_* derived from the intervals when a job completes and the
// caller did not give them explicitly.
function applyIntervals(rec, today) {
  if (rec.next_service_date == null && rec.interval_days) rec.next_service_date = shiftDate(today, rec.interval_days);
  if (rec.next_service_km == null && rec.interval_km && rec.odometer_at_service != null) rec.next_service_km = rec.odometer_at_service + rec.interval_km;
}

const MAINT_SELECT = `m.*, t.plate_number,
  CASE WHEN m.started_at IS NOT NULL AND m.completed_at IS NOT NULL
       THEN ROUND((EXTRACT(EPOCH FROM (m.completed_at - m.started_at)) / 86400.0)::numeric, 1) END AS downtime_days`;

function presentMaintenance(row, next) {
  const { receipt_storage_path: receiptPath, ...rest } = row;
  const n = next && next.get(row.truck_id);
  return { ...rest, has_receipt: !!receiptPath, is_due: !!(n && n.record_id === row.id && n.due), due_reasons: n && n.record_id === row.id ? n.due_reasons : [] };
}

// Moves the truck's lifecycle status as a side effect of a maintenance job
// (inside the caller's transaction).
//  start: only an 'active' truck goes to 'maintenance'; the previous status
//         is remembered on the job (truck_status_before).
//  finish: when no other job is still in progress and the truck is still in
//         'maintenance', restore the status a job remembered.
// Retired / inactive trucks are never moved.
async function syncTruckStatus(client, truckId, phase, recordId) {
  const t = (await client.query('SELECT id, status FROM trucks WHERE id = $1 FOR UPDATE', [truckId])).rows[0];
  if (!t) return null;
  if (phase === 'start') {
    if (t.status !== 'active') return null;
    await client.query('UPDATE truck_maintenance_records SET truck_status_before = $1 WHERE id = $2', [t.status, recordId]);
    await client.query(`UPDATE trucks SET status = 'maintenance', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [truckId]);
    return { before: t.status, after: 'maintenance' };
  }
  if (t.status !== 'maintenance') return null;
  const other = await client.query(
    `SELECT 1 FROM truck_maintenance_records WHERE truck_id = $1 AND status = 'in_progress' AND id <> $2 LIMIT 1`, [truckId, recordId]);
  if (other.rows.length) return null;
  const prev = await client.query(
    `SELECT truck_status_before FROM truck_maintenance_records
     WHERE truck_id = $1 AND truck_status_before IS NOT NULL
       AND (id = $2 OR completed_at >= (SELECT started_at FROM truck_maintenance_records WHERE id = $2))
     ORDER BY (id = $2) DESC, started_at DESC NULLS LAST, id DESC LIMIT 1`, [truckId, recordId]);
  const restore = prev.rows[0]?.truck_status_before;
  if (!restore || restore === 'maintenance' || restore === 'retired') return null;
  await client.query('UPDATE trucks SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [restore, truckId]);
  return { before: 'maintenance', after: restore };
}

async function auditTruckStatus(change, truckId, req, recordId) {
  if (!change) return;
  await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'truck.status_change', entityType: 'truck', entityId: truckId,
    before: { status: change.before }, after: { status: change.after, via_maintenance_record: recordId } });
}

// ---------- Overview (dashboard) ----------

router.get('/overview', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const tz = await getTimezone();
    const lp = localParts(new Date(), tz);
    const today = lp.date;
    const monthStart = `${lp.period}-01`;
    const nextMonth = lp.month === 12 ? `${lp.year + 1}-01-01` : `${lp.year}-${String(lp.month + 1).padStart(2, '0')}-01`;

    // Same visibility as GET /trucks: own zone + company-wide trucks.
    const params = [];
    let zoneSql = '';
    if (myZoneId !== null) { params.push(myZoneId); zoneSql = `AND (t.zone_id = $1 OR t.zone_id IS NULL)`; }
    const trucksRes = await pool.query(
      `SELECT t.id, t.plate_number, t.model, t.status, t.zone_id, z.name AS zone_name,
              t.collector_id, c.name AS collector_name, t.driver_id, d.name AS driver_name,
              (t.photo_storage_path IS NOT NULL) AS has_photo,
              t.insurance_expiry, t.registration_expiry, t.road_tax_expiry
       FROM trucks t
       LEFT JOIN zones z ON z.id = t.zone_id
       LEFT JOIN employees c ON c.id = t.collector_id
       LEFT JOIN employees d ON d.id = t.driver_id
       WHERE t.status <> 'retired' ${zoneSql}
       ORDER BY t.plate_number ASC`,
      params
    );
    const trucks = trucksRes.rows;
    const ids = trucks.map((t) => t.id);
    const rate = await currentRate();
    const canSeeLive = LIVE_ROLES.includes((req.user.role || '').toLowerCase());

    const [fuelRes, maintRes, distRes, liveRes, next] = await Promise.all([
      pool.query(
        `SELECT id, truck_id, liters, cost, currency, price_per_liter, odometer_reading, record_date, created_at, receipt_storage_path
         FROM truck_fuel_records WHERE truck_id = ANY($1::int[]) AND record_date >= $2::date AND record_date < $3::date`,
        [ids, monthStart, nextMonth]),
      pool.query(
        `SELECT truck_id, currency, SUM(cost) AS total FROM truck_maintenance_records
         WHERE truck_id = ANY($1::int[]) AND status = 'completed'
           AND COALESCE(completed_at, created_at) >= $2::date AND COALESCE(completed_at, created_at) < $3::date
         GROUP BY truck_id, currency`,
        [ids, monthStart, nextMonth]),
      pool.query(
        `SELECT truck_id, day, km::float AS km FROM truck_daily_distance
         WHERE truck_id = ANY($1::int[]) AND day >= $2::date AND day < $3::date`,
        [ids, monthStart, nextMonth]),
      // Live status (map logic): the truck's collector/driver, or the
      // collector working a task with this truck today; freshest ping wins.
      // Only for the Map roles — everyone else gets live: null.
      !canSeeLive ? Promise.resolve({ rows: [] }) : pool.query(
        `WITH cand AS (
           SELECT id AS truck_id, collector_id AS emp FROM trucks WHERE id = ANY($1::int[]) AND collector_id IS NOT NULL
           UNION SELECT id, driver_id FROM trucks WHERE id = ANY($1::int[]) AND driver_id IS NOT NULL
           UNION SELECT trt.resource_id, trc.resource_id
             FROM ${ACTIVE_WORK_FROM}
             JOIN task_resources trt ON trt.task_id = trc.task_id AND trt.resource_type = 'truck'
             WHERE ${activeWorkWhere('trc.resource_id', '$2::date')} AND trt.resource_id = ANY($1::int[])
         )
         SELECT c.truck_id, MAX(cl.recorded_at) AS last_seen_at,
                MIN(GREATEST(0, EXTRACT(EPOCH FROM (LOCALTIMESTAMP - cl.recorded_at))))::int AS seconds_ago
         FROM cand c JOIN collector_locations cl ON cl.employee_id = c.emp
         GROUP BY c.truck_id`,
        [ids, today]),
      getNextMaintenance({ truckIds: ids, today }),
    ]);

    const fuelRows = await annotateFuelRows(fuelRes.rows, pool, { rate });
    const group = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.truck_id)) m.set(r.truck_id, []); m.get(r.truck_id).push(r); } return m; };
    const fuelBy = group(fuelRows);
    const maintBy = group(maintRes.rows);
    const distBy = group(distRes.rows);
    const liveBy = new Map(liveRes.rows.map((r) => [r.truck_id, r]));

    const kpis = {
      trucks: { active: 0, maintenance: 0, inactive: 0, total: trucks.length },
      fuel_cost_month_usd: 0, maintenance_cost_month_usd: 0, unconverted_records: 0,
      documents_expiring_30: 0, documents_expired: 0, maintenance_due: 0, km_month: 0,
    };
    const cards = trucks.map((t) => {
      if (kpis.trucks[t.status] !== undefined) kpis.trucks[t.status] += 1;
      const fuel = fuelBy.get(t.id) || [];
      const ft = fuelTotals(fuel);
      let maintUsd = 0;
      for (const m of maintBy.get(t.id) || []) {
        const u = toUsd(m.total, m.currency, rate);
        if (u === null) kpis.unconverted_records += 1; else maintUsd += u;
      }
      kpis.unconverted_records += ft.unconverted;
      const daily = new Map((distBy.get(t.id) || []).map((d) => [dateStr(d.day), d.km]));
      const kmMonth = round([...daily.values()].reduce((s, k) => s + k, 0));
      const gps = gpsKmPerLiter(fuel, daily);
      const docs = [['insurance', t.insurance_expiry], ['registration', t.registration_expiry], ['road_tax', t.road_tax_expiry]]
        .filter(([, d]) => d)
        .map(([type, d]) => ({ document_type: type, expiry_date: d, days_left: Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000) }))
        .sort((a, b) => a.days_left - b.days_left);
      for (const d of docs) { if (d.days_left < 0) kpis.documents_expired += 1; if (d.days_left <= 30) kpis.documents_expiring_30 += 1; }
      const nm = next.get(t.id) || null;
      if (nm && nm.due) kpis.maintenance_due += 1;
      const live = liveBy.get(t.id);
      const secs = live ? Number(live.seconds_ago) : null;
      kpis.fuel_cost_month_usd += ft.cost_usd;
      kpis.maintenance_cost_month_usd += maintUsd;
      kpis.km_month += kmMonth || 0;
      const { insurance_expiry: _i, registration_expiry: _r, road_tax_expiry: _x, ...base } = t;
      return {
        ...base,
        photo_url: t.has_photo ? `/v2/trucks/${t.id}/photo` : null,
        fuel_cost_month_usd: ft.cost_usd,
        fuel_cost_month_by_currency: ft.cost_by_currency,
        fuel_liters_month: ft.liters,
        maintenance_cost_month_usd: round(maintUsd),
        km_month: kmMonth,
        odometer_km_month: ft.km,
        km_per_liter: ft.km_per_liter,
        gps_km_per_liter: gps ? gps.km_per_liter : null,
        cost_per_km_usd: ft.cost_per_km_usd,
        fuel_flags: [...new Set(fuel.flatMap((f) => f.flags))],
        next_maintenance: nm && { record_id: nm.record_id, description: nm.description, next_service_date: nm.next_service_date, next_service_km: nm.next_service_km,
          current_odometer: nm.current_odometer, days_remaining: nm.days_remaining, km_remaining: nm.km_remaining, due: nm.due, due_reasons: nm.due_reasons },
        nearest_document: docs[0] || null,
        live: !canSeeLive ? null : {
          status: secs === null ? 'no_signal' : secs < 120 ? 'live' : secs < 600 ? 'idle' : 'offline',
          seconds_ago: secs, last_seen_at: live ? live.last_seen_at : null,
        },
      };
    });
    kpis.fuel_cost_month_usd = round(kpis.fuel_cost_month_usd);
    kpis.maintenance_cost_month_usd = round(kpis.maintenance_cost_month_usd);
    kpis.km_month = round(kpis.km_month);
    res.json({ data: { period: lp.period, today, exchange_rate: rate, kpis, trucks: cards } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load fleet overview.', code: 'INTERNAL' } });
  }
});

// ---------- Maintenance ----------

router.post('/maintenance', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  const { truck_id, description, next_service_date } = req.body;
  const truckId = parseStrictId(truck_id);
  if (truckId === null) return bad(res, 'truck_id is required.');
  const desc = (description || '').trim();
  if (!desc) return bad(res, 'description is required.');
  if (desc.length > 2000) return bad(res, 'description must be 2000 characters or fewer.');
  const status = req.body.status === undefined ? 'completed' : req.body.status;
  if (!MAINT_STATUSES.includes(status)) return bad(res, `status must be one of: ${MAINT_STATUSES.join(', ')}.`);
  if (next_service_date !== undefined && next_service_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(next_service_date)) {
    return bad(res, 'next_service_date must be YYYY-MM-DD or null.');
  }
  const { errors, data } = parseMaintenanceExtras(req.body);
  if (errors.length) return bad(res, errors.join(' '));
  const parts = data.parts || [];
  let cost = data.cost;
  if (cost === undefined && parts.length) cost = partsTotal(parts);
  // A finished job keeps the original rule (cost > 0); a planned or running
  // job may carry 0 until it completes.
  if (status === 'completed') {
    if (!(cost > 0)) return bad(res, 'cost must be a positive number.');
  } else if (cost === undefined) cost = 0;

  const client = await pool.connect();
  try {
    const access = await loadTruckWithAccessCheck(req.user, truckId);
    if (access.error) return bad(res, access.error.message, access.error.status, access.error.code);
    if (access.truck.status === 'retired') return bad(res, 'This truck is Retired — no new maintenance can be logged.', 409, 'RETIRED_TERMINAL');

    const tz = await getTimezone();
    const today = localParts(new Date(), tz).date;
    const rec = { next_service_date: data.next_service_date ?? null, next_service_km: data.next_service_km ?? null,
      interval_days: data.interval_days ?? null, interval_km: data.interval_km ?? null, odometer_at_service: data.odometer_at_service ?? null };
    if (status === 'completed') applyIntervals(rec, today);

    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO truck_maintenance_records
         (truck_id, description, cost, next_service_date, provider, zone_snapshot_id, created_by,
          status, scheduled_date, started_at, completed_at, odometer_at_service, next_service_km, interval_km, interval_days, parts, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::varchar,$9,
               CASE WHEN $8::varchar = 'in_progress' THEN CURRENT_TIMESTAMP END,
               CASE WHEN $8::varchar = 'completed' THEN CURRENT_TIMESTAMP END,
               $10,$11,$12,$13,$14::jsonb,$15) RETURNING *`,
      [truckId, desc, cost, rec.next_service_date, data.provider ?? null, access.truck.zone_id, req.user.id,
       status, data.scheduled_date ?? null, rec.odometer_at_service, rec.next_service_km, rec.interval_km, rec.interval_days,
       JSON.stringify(parts), data.currency || 'USD']
    );
    const record = inserted.rows[0];
    const change = status === 'in_progress' ? await syncTruckStatus(client, truckId, 'start', record.id) : null;
    if (change) record.truck_status_before = change.before;
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'truck_maintenance_record.create', entityType: 'truck_maintenance_record', entityId: record.id, before: null, after: record });
    await auditTruckStatus(change, truckId, req, record.id);
    res.status(201).json({ data: presentMaintenance(record) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: { message: 'Failed to create maintenance record.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.get('/maintenance', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const params = [];
    const filters = [];
    if (myZoneId !== null) { params.push(myZoneId); filters.push(`(t.zone_id = $${params.length} OR t.zone_id IS NULL)`); }
    if (req.query.truck_id) {
      const tid = parseStrictId(req.query.truck_id);
      if (tid === null) return bad(res, 'Invalid truck_id.');
      params.push(tid); filters.push(`m.truck_id = $${params.length}`);
    }
    if (req.query.status) {
      if (!MAINT_STATUSES.includes(req.query.status)) return bad(res, 'Invalid status.');
      params.push(req.query.status); filters.push(`m.status = $${params.length}`);
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
      `SELECT ${MAINT_SELECT} FROM truck_maintenance_records m JOIN trucks t ON m.truck_id = t.id ${whereSql} ${orderSql}`,
      params
    );
    const truckIds = [...new Set(result.rows.map((r) => r.truck_id))];
    const next = truckIds.length ? await getNextMaintenance({ truckIds }) : new Map();
    let rows = result.rows.map((r) => presentMaintenance(r, next));
    if (req.query.due === 'true') rows = rows.filter((r) => r.is_due);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list maintenance records.', code: 'INTERNAL' } });
  }
});

async function loadMaintenanceForUser(user, id) {
  const result = await pool.query(
    `SELECT ${MAINT_SELECT}, t.zone_id AS truck_zone_id FROM truck_maintenance_records m JOIN trucks t ON m.truck_id = t.id WHERE m.id = $1`,
    [id]
  );
  if (result.rows.length === 0) return { error: { status: 404, message: 'Maintenance record not found.', code: 'NOT_FOUND' } };
  const myZoneId = await resolveUserZoneId(user);
  if (myZoneId !== null && result.rows[0].truck_zone_id !== null && result.rows[0].truck_zone_id !== myZoneId) {
    return { error: { status: 403, message: 'You do not have access to this record.', code: 'FORBIDDEN' } };
  }
  return { row: result.rows[0] };
}

router.get('/maintenance/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return bad(res, 'Invalid maintenance record id.');
  try {
    const r = await loadMaintenanceForUser(req.user, id);
    if (r.error) return bad(res, r.error.message, r.error.status, r.error.code);
    const next = await getNextMaintenance({ truckIds: [r.row.truck_id] });
    res.json({ data: presentMaintenance(r.row, next) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load maintenance record.', code: 'INTERNAL' } });
  }
});

// PUT /fleet/maintenance/:id/status — scheduled -> in_progress (truck goes
// to 'maintenance'), in_progress|scheduled -> completed (truck back to
// 'active' unless another job is still in progress). Completing a job may
// also set its final cost/parts/odometer/next service; completed needs cost > 0.
router.put('/maintenance/:id/status', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return bad(res, 'Invalid maintenance record id.');
  const status = req.body?.status;
  if (!MAINT_STATUSES.includes(status)) return bad(res, `status must be one of: ${MAINT_STATUSES.join(', ')}.`);
  const { errors, data } = parseMaintenanceExtras(req.body || {});
  if (errors.length) return bad(res, errors.join(' '));

  const pre = await loadMaintenanceForUser(req.user, id).catch(() => null);
  if (!pre) return res.status(500).json({ error: { message: 'Failed to update maintenance status.', code: 'INTERNAL' } });
  if (pre.error) return bad(res, pre.error.message, pre.error.status, pre.error.code);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT * FROM truck_maintenance_records WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!(MAINT_TRANSITIONS[cur.status] || []).includes(status)) {
      await client.query('ROLLBACK');
      return bad(res, `Cannot change a ${cur.status} job to ${status}.`, 409, 'ILLEGAL_TRANSITION');
    }
    const next = { ...cur };
    for (const k of ['scheduled_date', 'odometer_at_service', 'next_service_km', 'interval_km', 'interval_days', 'currency', 'provider', 'next_service_date']) {
      if (data[k] !== undefined) next[k] = data[k];
    }
    if (data.parts !== undefined) next.parts = data.parts;
    if (data.cost !== undefined) next.cost = data.cost;
    else if (data.parts !== undefined && data.parts.length && !(Number(cur.cost) > 0)) next.cost = partsTotal(data.parts);
    let change = null;
    if (status === 'in_progress') {
      next.started_at = new Date();
    } else {
      if (!(Number(next.cost) > 0)) { await client.query('ROLLBACK'); return bad(res, 'A completed job needs its final cost (a positive number).'); }
      next.completed_at = new Date();
      const today = localParts(new Date(), await getTimezone()).date;
      applyIntervals(next, today);
    }
    const upd = await client.query(
      `UPDATE truck_maintenance_records SET status = $1, started_at = $2, completed_at = $3, cost = $4, parts = $5::jsonb, currency = $6,
         provider = $7, scheduled_date = $8, odometer_at_service = $9, next_service_km = $10, interval_km = $11, interval_days = $12,
         next_service_date = $13, updated_at = CURRENT_TIMESTAMP
       WHERE id = $14 RETURNING *`,
      [status, next.started_at, next.completed_at || null, next.cost, JSON.stringify(next.parts || []), next.currency, next.provider,
       next.scheduled_date, next.odometer_at_service, next.next_service_km, next.interval_km, next.interval_days, next.next_service_date, id]
    );
    change = await syncTruckStatus(client, cur.truck_id, status === 'in_progress' ? 'start' : 'finish', id);
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'truck_maintenance_record.status_change', entityType: 'truck_maintenance_record', entityId: id,
      before: { status: cur.status, cost: cur.cost }, after: { status, cost: upd.rows[0].cost } });
    await auditTruckStatus(change, cur.truck_id, req, id);
    const after = await loadMaintenanceForUser(req.user, id);
    res.json({ data: { ...presentMaintenance(after.row), truck_status: change ? change.after : undefined } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: { message: 'Failed to update maintenance status.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// ---------- Receipts (fuel + maintenance) ----------

function receiptRoutes(kind, table, loader) {
  const exists = () => ({ status: 409, message: 'A receipt is already attached to this record. Receipts are evidence and cannot be replaced.', code: 'RECEIPT_EXISTS' });
  // Ownership/scope + "already has a receipt" are checked BEFORE multer
  // writes or the scanner reads anything.
  const preload = async (req, res, next) => {
    const id = parseStrictId(req.params.id);
    if (id === null) return bad(res, 'Invalid record id.');
    try {
      const r = await loader(req.user, id);
      if (r.error) return bad(res, r.error.message, r.error.status, r.error.code);
      if (r.row.receipt_storage_path) { const e = exists(); return bad(res, e.message, e.status, e.code); }
      req.fleetRecordId = id;
      next();
    } catch (err) {
      res.status(500).json({ error: { message: 'Failed to save receipt.', code: 'INTERNAL' } });
    }
  };
  router.post(`/${kind}/:id/receipt`, authenticateToken, requireRole(...CREATE_ROLES), preload, uploads.single(uploads.receiptUpload), async (req, res) => {
    const id = req.fleetRecordId;
    if (await uploads.rejectBadFile(req, res, { kindsLabel: RECEIPT_KINDS, label: `${kind}_receipt` })) return;
    try {
      // Conditional write: a concurrent upload that won the race keeps its file.
      const upd = await pool.query(
        `UPDATE ${table} SET receipt_storage_path = $1, receipt_original_filename = $2, receipt_mime_type = $3 WHERE id = $4 AND receipt_storage_path IS NULL`,
        [req.file.filename, String(req.file.originalname || '').slice(0, 255), req.file.mimetype, id]
      );
      if (upd.rowCount === 0) { uploads.discard(req); const e = exists(); return bad(res, e.message, e.status, e.code); }
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: `${table.replace(/s$/, '')}.receipt_upload`, entityType: table.replace(/s$/, ''), entityId: id,
        before: null, after: { receipt: req.file.originalname, stored_as: req.file.filename, mime: req.file.mimetype } });
      res.status(201).json({ data: { id, has_receipt: true, receipt_url: `/v2/fleet/${kind}/${id}/receipt`, receipt_mime_type: req.file.mimetype } });
    } catch (err) {
      uploads.discard(req);
      res.status(500).json({ error: { message: 'Failed to save receipt.', code: 'INTERNAL' } });
    }
  });

  router.get(`/${kind}/:id/receipt`, authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
    const id = parseStrictId(req.params.id);
    if (id === null) return bad(res, 'Invalid record id.');
    try {
      const r = await loader(req.user, id);
      if (r.error) return bad(res, r.error.message, r.error.status, r.error.code);
      if (!r.row.receipt_storage_path) return bad(res, 'No receipt attached.', 404, 'NOT_FOUND');
      return uploads.sendStored(res, { name: r.row.receipt_storage_path, mime: r.row.receipt_mime_type, filename: r.row.receipt_original_filename });
    } catch (err) {
      res.status(500).json({ error: { message: 'Failed to load receipt.', code: 'INTERNAL' } });
    }
  });
}

// ---------- Fuel ----------

router.post('/fuel', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  const { truck_id, liters, cost, odometer_reading, record_date, notes } = req.body;
  const truckId = parseStrictId(truck_id);
  if (truckId === null) return bad(res, 'truck_id is required.');
  const litersVal = parseFloat(liters);
  if (isNaN(litersVal) || litersVal <= 0) return bad(res, 'liters must be a positive number.');
  const currency = req.body.currency === undefined || req.body.currency === null || req.body.currency === '' ? 'USD' : req.body.currency;
  if (!CURRENCIES.includes(currency)) return bad(res, 'currency must be USD or SLSH.');
  let ppl = null;
  if (req.body.price_per_liter !== undefined && req.body.price_per_liter !== null && req.body.price_per_liter !== '') {
    ppl = parseFloat(req.body.price_per_liter);
    if (isNaN(ppl) || ppl <= 0) return bad(res, 'price_per_liter must be a positive number.');
  }
  let costVal = parseFloat(cost);
  if ((cost === undefined || cost === null || cost === '') && ppl !== null) costVal = round(ppl * litersVal);
  if (isNaN(costVal) || costVal <= 0) return bad(res, 'cost must be a positive number.');
  if (ppl === null) ppl = round(costVal / litersVal, 4);
  let odometerVal = null;
  if (odometer_reading !== undefined && odometer_reading !== null && odometer_reading !== '') {
    odometerVal = parseInt(odometer_reading, 10);
    if (isNaN(odometerVal) || odometerVal < 0) return bad(res, 'odometer_reading must be a non-negative integer.');
  }
  if (record_date !== undefined && record_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(record_date)) {
    return bad(res, 'record_date must be YYYY-MM-DD.');
  }
  const station = req.body.station ? String(req.body.station).trim().slice(0, 150) || null : null;

  try {
    const access = await loadTruckWithAccessCheck(req.user, truckId);
    if (access.error) return bad(res, access.error.message, access.error.status, access.error.code);

    const inserted = await pool.query(
      `INSERT INTO truck_fuel_records (truck_id, liters, cost, odometer_reading, record_date, notes, zone_snapshot_id, created_by, currency, price_per_liter, station)
       VALUES ($1,$2,$3,$4,COALESCE($5, CURRENT_DATE),$6,$7,$8,$9,$10,$11) RETURNING *`,
      [truckId, litersVal, costVal, odometerVal, record_date || null, notes || null, access.truck.zone_id, req.user.id, currency, ppl, station]
    );
    const record = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'truck_fuel_record.create', entityType: 'truck_fuel_record', entityId: record.id, before: null, after: record });
    // Odometer anomaly (needs_review) + efficiency flags — advisory only,
    // recomputed at read time, never stored (Decision 6).
    const [annotated] = await annotateFuelRows([record]);
    res.status(201).json({ data: annotated });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to create fuel record.', code: 'INTERNAL' } });
  }
});

// Shared filter set for the fuel list and its CSV export.
async function queryFuel(req) {
  const myZoneId = await resolveUserZoneId(req.user);
  const params = [];
  const filters = [];
  if (myZoneId !== null) { params.push(myZoneId); filters.push(`(t.zone_id = $${params.length} OR t.zone_id IS NULL)`); }
  if (req.query.truck_id) {
    const tid = parseStrictId(req.query.truck_id);
    if (tid === null) return { error: 'Invalid truck_id.' };
    params.push(tid); filters.push(`f.truck_id = $${params.length}`);
  }
  if (req.query.month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month)) return { error: 'month must be YYYY-MM.' };
    params.push(`${req.query.month}-01`);
    filters.push(`f.record_date >= $${params.length}::date AND f.record_date < ($${params.length}::date + INTERVAL '1 month')`);
  }
  for (const [k, op] of [['date_from', '>='], ['date_to', '<=']]) {
    if (req.query[k]) {
      if (!isValidDate(req.query[k])) return { error: `${k} must be YYYY-MM-DD.` };
      params.push(req.query[k]); filters.push(`f.record_date ${op} $${params.length}::date`);
    }
  }
  if (req.query.q) {
    const q = req.query.q.trim();
    if (q.length >= 2) { params.push(`%${q}%`); filters.push(`(f.notes ILIKE $${params.length} OR f.station ILIKE $${params.length})`); }
  }
  const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT f.*, t.plate_number FROM truck_fuel_records f JOIN trucks t ON f.truck_id = t.id ${whereSql} ORDER BY f.record_date DESC, f.created_at DESC`,
    params
  );
  let rows = await annotateFuelRows(result.rows);
  if (req.query.needs_review === 'true') rows = rows.filter((r) => r.needs_review);
  else if (req.query.needs_review === 'false') rows = rows.filter((r) => !r.needs_review);
  if (req.query.flagged === 'true') rows = rows.filter((r) => r.flags.length > 0);
  return { rows };
}

router.get('/fuel', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const r = await queryFuel(req);
    if (r.error) return bad(res, r.error);
    res.json({ data: r.rows, meta: { totals: fuelTotals(r.rows) } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list fuel records.', code: 'INTERNAL' } });
  }
});

router.get('/fuel.csv', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const r = await queryFuel(req);
    if (r.error) return bad(res, r.error);
    const columns = [
      { key: 'record_date', label: 'Date' }, { key: 'plate_number', label: 'Truck' }, { key: 'station', label: 'Station' },
      { key: 'liters', label: 'Liters' }, { key: 'currency', label: 'Currency' }, { key: 'price_per_liter', label: 'Price per liter' },
      { key: 'cost', label: 'Cost' }, { key: 'cost_usd', label: 'Cost (USD equiv.)' }, { key: 'odometer_reading', label: 'Odometer' },
      { key: 'km_since_last', label: 'Km since last fill' }, { key: 'km_per_liter', label: 'Km per liter' },
      { key: 'cost_per_km_usd', label: 'Cost per km (USD)' }, { key: 'flags_text', label: 'Flags' }, { key: 'notes', label: 'Notes' },
    ];
    const csv = toCsv(r.rows.map((x) => ({ ...x, flags_text: x.flags.join(' ') })), columns);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fuel-records.csv"');
    res.send('﻿' + csv);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to export fuel records.', code: 'INTERNAL' } });
  }
});

async function loadFuelForUser(user, id) {
  const result = await pool.query(
    `SELECT f.*, t.plate_number, t.zone_id AS truck_zone_id FROM truck_fuel_records f JOIN trucks t ON f.truck_id = t.id WHERE f.id = $1`,
    [id]
  );
  if (result.rows.length === 0) return { error: { status: 404, message: 'Fuel record not found.', code: 'NOT_FOUND' } };
  const myZoneId = await resolveUserZoneId(user);
  if (myZoneId !== null && result.rows[0].truck_zone_id !== null && result.rows[0].truck_zone_id !== myZoneId) {
    return { error: { status: 403, message: 'You do not have access to this record.', code: 'FORBIDDEN' } };
  }
  return { row: result.rows[0] };
}

router.get('/fuel/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return bad(res, 'Invalid fuel record id.');
  try {
    const r = await loadFuelForUser(req.user, id);
    if (r.error) return bad(res, r.error.message, r.error.status, r.error.code);
    const [annotated] = await annotateFuelRows([r.row]);
    res.json({ data: annotated });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load fuel record.', code: 'INTERNAL' } });
  }
});

// PUT /fleet/fuel/:id/currency — admin only, one-time confirmation of the
// currency of a legacy row (logged before currency existed). 409 once confirmed.
router.put('/fuel/:id/currency', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return bad(res, 'Invalid fuel record id.');
  const currency = req.body?.currency;
  if (!CURRENCIES.includes(currency)) return bad(res, 'currency must be USD or SLSH.');
  try {
    const cur = await pool.query('SELECT id, currency, currency_confirmed FROM truck_fuel_records WHERE id = $1', [id]);
    if (!cur.rows[0]) return bad(res, 'Fuel record not found.', 404, 'NOT_FOUND');
    const upd = await pool.query(
      `UPDATE truck_fuel_records SET currency = $1, currency_confirmed = TRUE WHERE id = $2 AND currency_confirmed = FALSE RETURNING *`,
      [currency, id]);
    if (!upd.rows[0]) return bad(res, 'This record\'s currency is already confirmed.', 409, 'CURRENCY_CONFIRMED');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'truck_fuel_record.currency_confirm', entityType: 'truck_fuel_record', entityId: id,
      before: { currency: cur.rows[0].currency, currency_confirmed: false }, after: { currency, currency_confirmed: true } });
    const [annotated] = await annotateFuelRows([upd.rows[0]]);
    res.json({ data: annotated });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to confirm currency.', code: 'INTERNAL' } });
  }
});

receiptRoutes('fuel', 'truck_fuel_records', loadFuelForUser);
receiptRoutes('maintenance', 'truck_maintenance_records', loadMaintenanceForUser);

// ---------- Expiry ----------

router.get('/expiry', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    // ?zone_id narrows WITHIN the caller's already-enforced scope only
    // — it can never widen it (Spec §6).
    let effectiveZoneId = myZoneId;
    if (myZoneId === null && req.query.zone_id) {
      const zid = parseStrictId(req.query.zone_id);
      if (zid === null) return bad(res, 'Invalid zone_id.');
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
