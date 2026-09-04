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
      `SELECT r.*, g.code AS group_code, g.zone_id,
        (SELECT COUNT(*)::int FROM customers c WHERE c.route_id = r.id AND c.status = 'active') AS customer_count
       FROM routes r JOIN groups g ON r.group_id = g.id
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
      `SELECT r.*, g.code AS group_code, g.zone_id FROM routes r JOIN groups g ON r.group_id = g.id WHERE r.id = $1`,
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
  return { errors, data: out };
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
    const dup = await pool.query('SELECT id FROM routes WHERE group_id = $1 AND code = $2', [data.group_id, data.code]);
    if (dup.rows.length) return res.status(409).json({ error: { message: `Route code "${data.code}" is already in use in this group.`, code: 'DUPLICATE' } });

    const result = await pool.query(
      `INSERT INTO routes (group_id, code, name, status, created_by) VALUES ($1,$2,$3,COALESCE($4,'active'),$5) RETURNING *`,
      [data.group_id, data.code, data.name ?? null, data.status ?? null, req.user.id]
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
