const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Group & Group-Based Collection — Change Request. Implementation Spec §16.
// Route is a minimal STRUCTURAL entity only (Locked Decision #10 / §3) —
// no geometry, geofencing, or path-optimization columns anywhere in this
// file. File is named routesEntity.js (not routes.js) purely to avoid
// confusion with this directory's own Express-router-file convention; it
// is mounted at /api/v2/routes.
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'collector'];
const WRITE_ROLES = ['admin', 'gudoomiye'];
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const VALID_STATUSES = ['active', 'inactive'];
const CODE_RE = /^.{1,30}$/;
// Sub Zone work days (same vocabulary/order as customers.work_days).
const WEEK_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];

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

async function assertZoneAccess(user, zoneId) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return true;
  const myZoneId = await resolveUserZoneId(user);
  return myZoneId !== null && myZoneId === zoneId;
}

// GET /api/v2/routes — optionally filtered by group_id/status.
router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const where = [];
    const params = [];
    let groupZoneId = null;
    if (req.query.group_id) {
      const gid = parseStrictId(req.query.group_id);
      if (gid === null) return res.status(400).json({ error: { message: 'Invalid group_id filter.', code: 'VALIDATION' } });
      const groupRes = await pool.query('SELECT zone_id FROM groups WHERE id = $1', [gid]);
      if (groupRes.rows.length === 0) return res.status(404).json({ error: { message: 'Group not found.', code: 'NOT_FOUND' } });
      groupZoneId = groupRes.rows[0].zone_id;
      if (!(await assertZoneAccess(req.user, groupZoneId))) {
        return res.status(403).json({ error: { message: 'You do not have access to that group.', code: 'FORBIDDEN' } });
      }
      params.push(gid);
      where.push(`r.group_id = $${params.length}`);
    } else {
      // Unscoped list — zone-restrict via the owning group for
      // gudoomiye/zone_accountant, same principle as every other V2 list.
      const myZoneId = await resolveUserZoneId(req.user);
      if (myZoneId !== null) {
        params.push(myZoneId);
        where.push(`g.zone_id = $${params.length}`);
      }
    }
    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) return res.status(400).json({ error: { message: `status must be one of: ${VALID_STATUSES.join(', ')}.`, code: 'VALIDATION' } });
      params.push(req.query.status);
      where.push(`r.status = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT r.*, g.code AS group_code, g.zone_id, gz.name AS group_zone_name, gz.code AS group_zone_code,
        u.full_name AS collector_name, u.is_active AS collector_active, tk.plate_number AS truck_plate,
        (SELECT COUNT(*)::int FROM customers c WHERE c.route_id = r.id AND c.status = 'active') AS customer_count
       FROM routes r JOIN groups g ON r.group_id = g.id
       LEFT JOIN v2_users u ON u.id = r.collector_user_id
       LEFT JOIN group_zones gz ON gz.id = r.group_zone_id
       LEFT JOIN trucks tk ON tk.id = r.truck_id
       ${whereSql} ORDER BY g.code, r.code`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list routes.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/routes/:id
router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid route id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query(
      `SELECT r.*, g.code AS group_code, g.zone_id, u.full_name AS collector_name, u.is_active AS collector_active, tk.plate_number AS truck_plate
       FROM routes r JOIN groups g ON r.group_id = g.id LEFT JOIN v2_users u ON u.id = r.collector_user_id
       LEFT JOIN trucks tk ON tk.id = r.truck_id WHERE r.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Route not found.', code: 'NOT_FOUND' } });
    const route = result.rows[0];
    if (!(await assertZoneAccess(req.user, route.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this route.', code: 'FORBIDDEN' } });
    }
    const customerCount = await pool.query(`SELECT COUNT(*)::int AS n FROM customers WHERE route_id = $1 AND status = 'active'`, [id]);
    res.json({ data: { ...route, customer_count: customerCount.rows[0].n } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load route.', code: 'INTERNAL' } });
  }
});

function validateRouteInput(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  if (!partial) {
    const groupId = parseStrictId(String(body.group_id ?? ''));
    if (groupId === null) errors.push('group_id is required and must be a valid group.');
    else out.group_id = groupId;
  }
  if (!partial || body.code !== undefined) {
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!CODE_RE.test(code)) errors.push('code is required and must be 1-30 characters.');
    else out.code = code;
  }
  if (body.name !== undefined) out.name = body.name === null ? null : String(body.name).trim().slice(0, 100) || null;
  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}.`);
    else out.status = body.status;
  }
  if (body.collector_user_id !== undefined) {
    if (body.collector_user_id === null) out.collector_user_id = null;
    else {
      const cid = parseStrictId(String(body.collector_user_id));
      if (cid === null) errors.push('collector_user_id must be a valid user id or null.');
      else out.collector_user_id = cid;
    }
  }
  if (body.work_days !== undefined) {
    if (body.work_days === null) out.work_days = null;
    else if (!Array.isArray(body.work_days) || body.work_days.some((d) => !WEEK_DAYS.includes(d))) errors.push(`work_days must be a list of: ${WEEK_DAYS.join(', ')}.`);
    else {
      const days = WEEK_DAYS.filter((d) => body.work_days.includes(d));
      out.work_days = days.length ? JSON.stringify(days) : null;
    }
  }
  if (body.truck_id !== undefined) {
    if (body.truck_id === null) out.truck_id = null;
    else {
      const tid = parseStrictId(String(body.truck_id));
      if (tid === null) errors.push('truck_id must be a valid truck id or null.');
      else out.truck_id = tid;
    }
  }
  if (body.group_zone_id !== undefined) {
    if (body.group_zone_id === null) out.group_zone_id = null;
    else {
      const zid = parseStrictId(String(body.group_zone_id));
      if (zid === null) errors.push('group_zone_id must be a valid zone id or null.');
      else out.group_zone_id = zid;
    }
  }
  return { errors, data: out };
}

// The Zone (group_zones) must belong to the route's own group.
async function groupZoneError(groupZoneId, groupId) {
  if (groupZoneId === undefined || groupZoneId === null) return null;
  const r = await pool.query('SELECT group_id, status FROM group_zones WHERE id = $1', [groupZoneId]);
  if (r.rows.length === 0) return 'group_zone_id does not reference an existing zone.';
  if (Number(r.rows[0].group_id) !== Number(groupId)) return 'The selected zone does not belong to this group.';
  if (r.rows[0].status !== 'active') return 'The selected zone is inactive.';
  return null;
}

// Default truck: must exist, not retired, and be in the Sub Zone's district
// (or a company-wide truck with no district).
async function truckError(truckId, zoneId) {
  if (truckId === undefined || truckId === null) return null;
  const r = await pool.query('SELECT zone_id, status FROM trucks WHERE id = $1', [truckId]);
  if (r.rows.length === 0) return 'truck_id does not reference an existing truck.';
  if (r.rows[0].status === 'retired') return 'That truck is retired.';
  if (r.rows[0].zone_id !== null && Number(r.rows[0].zone_id) !== Number(zoneId)) return 'That truck does not belong to this district.';
  return null;
}

const MAX_SUBZONES_PER_COLLECTOR = 10;
async function collectorCapError(collectorId, excludeRouteId) {
  if (collectorId === undefined || collectorId === null) return null;
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM routes WHERE collector_user_id = $1 AND id != $2', [collectorId, excludeRouteId ?? 0]);
  if (r.rows[0].n >= MAX_SUBZONES_PER_COLLECTOR) return `A collector can have at most ${MAX_SUBZONES_PER_COLLECTOR} Sub Zones.`;
  return null;
}

async function collectorError(collectorId, groupZoneId) {
  if (collectorId === undefined || collectorId === null) return null;
  // v2_users stores the zone by name (column "zone"), not by id.
  const r = await pool.query(
    'SELECT u.role, z.id AS zone_id FROM v2_users u LEFT JOIN zones z ON z.name = u.zone WHERE u.id = $1',
    [collectorId]
  );
  if (r.rows.length === 0 || r.rows[0].role !== 'collector') return 'collector_user_id must reference a user with the collector role.';
  if (r.rows[0].zone_id === null || Number(r.rows[0].zone_id) !== Number(groupZoneId)) return 'That collector does not work in this district.';
  return null;
}

// POST /api/v2/routes — admin, gudoomiye (own zone, resolved via the
// parent Group).
router.post('/', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const { errors, data } = validateRouteInput(req.body, { partial: false });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  try {
    const groupRes = await pool.query('SELECT zone_id, status FROM groups WHERE id = $1', [data.group_id]);
    if (groupRes.rows.length === 0) return res.status(400).json({ error: { message: 'group_id does not reference an existing group.', code: 'VALIDATION' } });
    if (!(await assertZoneAccess(req.user, groupRes.rows[0].zone_id))) {
      return res.status(403).json({ error: { message: 'You cannot create a route under a group outside your assigned zone.', code: 'FORBIDDEN' } });
    }
    const cErr = await collectorError(data.collector_user_id, groupRes.rows[0].zone_id);
    if (cErr) return res.status(400).json({ error: { message: cErr, code: 'VALIDATION' } });
    const capErr = await collectorCapError(data.collector_user_id, null);
    if (capErr) return res.status(400).json({ error: { message: capErr, code: 'VALIDATION' } });
    if (data.collector_user_id && !data.work_days) {
      return res.status(400).json({ error: { message: 'Work days are required for a Sub Zone with a collector.', code: 'VALIDATION' } });
    }
    const tErr = await truckError(data.truck_id, groupRes.rows[0].zone_id);
    if (tErr) return res.status(400).json({ error: { message: tErr, code: 'VALIDATION' } });
    const gzErr = await groupZoneError(data.group_zone_id, data.group_id);
    if (gzErr) return res.status(400).json({ error: { message: gzErr, code: 'VALIDATION' } });
    const dup = await pool.query('SELECT id FROM routes WHERE group_id = $1 AND code = $2', [data.group_id, data.code]);
    if (dup.rows.length) return res.status(409).json({ error: { message: `Route code "${data.code}" is already in use in this group.`, code: 'DUPLICATE' } });

    const result = await pool.query(
      `INSERT INTO routes (group_id, code, name, status, created_by, collector_user_id, group_zone_id, work_days, truck_id) VALUES ($1,$2,$3,COALESCE($4,'active'),$5,$6,$7,$8,$9) RETURNING *`,
      [data.group_id, data.code, data.name ?? null, data.status ?? null, req.user.id, data.collector_user_id ?? null, data.group_zone_id ?? null, data.work_days ?? null, data.truck_id ?? null]
    );
    const route = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'route.create', entityType: 'route', entityId: route.id, before: null, after: route });
    res.status(201).json({ data: route });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'Route code is already in use in this group.', code: 'DUPLICATE' } });
    if (err.code === '23503') return res.status(400).json({ error: { message: 'group_id does not reference an existing group.', code: 'VALIDATION' } });
    res.status(500).json({ error: { message: 'Failed to create route.', code: 'INTERNAL' } });
  }
});

// PUT /api/v2/routes/:id — admin, gudoomiye (own zone). group_id is
// immutable via this route — moving a Route to a different Group is a
// materially different, undecided operation, not silently allowed here.
router.put('/:id', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid route id.', code: 'VALIDATION' } });
  const { errors, data } = validateRouteInput(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  if (Object.keys(data).length === 0) return res.status(400).json({ error: { message: 'No valid fields provided to update.', code: 'VALIDATION' } });
  try {
    const existing = await pool.query('SELECT r.*, g.zone_id FROM routes r JOIN groups g ON r.group_id = g.id WHERE r.id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: { message: 'Route not found.', code: 'NOT_FOUND' } });
    const current = existing.rows[0];
    if (!(await assertZoneAccess(req.user, current.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this route.', code: 'FORBIDDEN' } });
    }
    const cErr = await collectorError(data.collector_user_id, current.zone_id);
    if (cErr) return res.status(400).json({ error: { message: cErr, code: 'VALIDATION' } });
    const capErr = data.collector_user_id !== undefined && data.collector_user_id === current.collector_user_id ? null : await collectorCapError(data.collector_user_id, id);
    if (capErr) return res.status(400).json({ error: { message: capErr, code: 'VALIDATION' } });
    const gzErr = data.group_zone_id !== undefined && data.group_zone_id === current.group_zone_id ? null : await groupZoneError(data.group_zone_id, current.group_id);
    if (gzErr) return res.status(400).json({ error: { message: gzErr, code: 'VALIDATION' } });
    const tErr = data.truck_id !== undefined && data.truck_id === current.truck_id ? null : await truckError(data.truck_id, current.zone_id);
    if (tErr) return res.status(400).json({ error: { message: tErr, code: 'VALIDATION' } });
    // A Sub Zone that has a collector after this update must have work days
    // after it too (merged current + request state).
    const nextCollector = data.collector_user_id !== undefined ? data.collector_user_id : current.collector_user_id;
    const nextDays = data.work_days !== undefined ? data.work_days : (Array.isArray(current.work_days) && current.work_days.length ? current.work_days : null);
    if (nextCollector && !nextDays) {
      return res.status(400).json({ error: { message: 'Work days are required for a Sub Zone with a collector.', code: 'VALIDATION' } });
    }
    if (data.code) {
      const dup = await pool.query('SELECT id FROM routes WHERE group_id = $1 AND code = $2 AND id != $3', [current.group_id, data.code, id]);
      if (dup.rows.length) return res.status(409).json({ error: { message: `Route code "${data.code}" is already in use in this group.`, code: 'DUPLICATE' } });
    }
    const fields = Object.keys(data);
    const setSql = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = fields.map((f) => data[f]);
    values.push(id);
    const result = await pool.query(`UPDATE routes SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`, values);
    const route = result.rows[0];
    await logAudit({
      actorId: req.user.id, actorUsername: req.user.username,
      action: data.status !== undefined && data.status !== current.status ? 'route.status_change' : 'route.update',
      entityType: 'route', entityId: route.id, before: current, after: route,
    });
    res.json({ data: route });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'Route code is already in use in this group.', code: 'DUPLICATE' } });
    res.status(500).json({ error: { message: 'Failed to update route.', code: 'INTERNAL' } });
  }
});

module.exports = router;
