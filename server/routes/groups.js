const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Group & Group-Based Collection — Change Request. Implementation Spec §16
// (API Specification), §17 (RBAC), §8 (Group Detail Page). No new role is
// created (Locked Decision, §17) — Admin/Gudoomiye write (own zone for
// Gudoomiye), Zone Accountant/Collector read-only, matching every other
// V2 module's existing pattern exactly.
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'collector'];
const WRITE_ROLES = ['admin', 'gudoomiye'];
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const VALID_STATUSES = ['active', 'inactive'];
const VALID_TYPE_FILTERS = ['all', 'residential', 'commercial'];
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

// ---------- Group CRUD ----------

// GET /api/v2/groups — Spec §16. Zone-scoped for gudoomiye/zone_accountant,
// same server-side re-check pattern as every other V2 list endpoint (closes
// the IDOR class of finding the same way Customers/Batches already do).
router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const where = [];
    const params = [];
    if (myZoneId !== null) {
      params.push(myZoneId);
      where.push(`g.zone_id = $${params.length}`);
    }
    if (req.query.zone_id) {
      const zid = parseStrictId(req.query.zone_id);
      if (zid === null) return res.status(400).json({ error: { message: 'Invalid zone_id filter.', code: 'VALIDATION' } });
      if (myZoneId !== null && zid !== myZoneId) return res.status(403).json({ error: { message: 'You do not have access to that zone.', code: 'FORBIDDEN' } });
      params.push(zid);
      where.push(`g.zone_id = $${params.length}`);
    }
    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) return res.status(400).json({ error: { message: `status must be one of: ${VALID_STATUSES.join(', ')}.`, code: 'VALIDATION' } });
      params.push(req.query.status);
      where.push(`g.status = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM groups g ${whereSql}`, params);
    params.push(limit, offset);
    // customer_count/route_count are ALWAYS live-derived (never a stored,
    // cacheable counter) — Spec §8's explicit instruction against
    // hardcoding, and the same reason "31+ groups, no fixed cap" holds:
    // this is a real, unbounded query, not a fixed-size lookup.
    const result = await pool.query(
      `SELECT g.*, z.name AS zone_name,
        (SELECT COUNT(*)::int FROM customers c WHERE c.group_id = g.id AND c.status = 'active') AS customer_count,
        (SELECT COUNT(*)::int FROM routes r WHERE r.group_id = g.id) AS route_count
       FROM groups g LEFT JOIN zones z ON g.zone_id = z.id
       ${whereSql} ORDER BY g.zone_id, g.code
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: result.rows, meta: { total: countResult.rows[0].total, limit, offset } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list groups.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/groups/:id — Spec §8 (Group Detail Page).
router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid group id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query(
      `SELECT g.*, z.name AS zone_name FROM groups g LEFT JOIN zones z ON g.zone_id = z.id WHERE g.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Group not found.', code: 'NOT_FOUND' } });
    const group = result.rows[0];
    if (!(await assertZoneAccess(req.user, group.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this group.', code: 'FORBIDDEN' } });
    }
    const customerCount = await pool.query(`SELECT COUNT(*)::int AS n FROM customers WHERE group_id = $1 AND status = 'active'`, [id]);
    const routeCount = await pool.query(`SELECT COUNT(*)::int AS n FROM routes WHERE group_id = $1`, [id]);
    const routes = await pool.query(`SELECT r.*, (SELECT COUNT(*)::int FROM customers c WHERE c.route_id = r.id AND c.status = 'active') AS customer_count FROM routes r WHERE r.group_id = $1 ORDER BY r.code`, [id]);
    res.json({
      data: {
        ...group,
        customer_count: customerCount.rows[0].n,
        route_count: routeCount.rows[0].n,
        routes: routes.rows,
      },
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load group.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/groups/:id/customers — paginated customer list for the Group
// Detail page (Spec §8), filterable by status/customer_type/route_id.
router.get('/:id/customers', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid group id.', code: 'VALIDATION' } });
  try {
    const groupRes = await pool.query('SELECT zone_id FROM groups WHERE id = $1', [id]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: { message: 'Group not found.', code: 'NOT_FOUND' } });
    if (!(await assertZoneAccess(req.user, groupRes.rows[0].zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this group.', code: 'FORBIDDEN' } });
    }
    const where = ['c.group_id = $1'];
    const params = [id];
    if (req.query.status) { params.push(req.query.status); where.push(`c.status = $${params.length}`); }
    else { where.push(`c.status != 'archived'`); }
    if (req.query.customer_type) { params.push(req.query.customer_type); where.push(`c.customer_type = $${params.length}`); }
    if (req.query.route_id) {
      const rid = parseStrictId(req.query.route_id);
      if (rid === null) return res.status(400).json({ error: { message: 'Invalid route_id filter.', code: 'VALIDATION' } });
      params.push(rid); where.push(`c.route_id = $${params.length}`);
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM customers c WHERE ${where.join(' AND ')}`, params);
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT c.id, c.customer_number, c.name, c.business_name, c.customer_type, c.status, c.route_id
       FROM customers c WHERE ${where.join(' AND ')} ORDER BY c.name LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: result.rows, meta: { total: countResult.rows[0].total, limit, offset } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load group customers.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/groups/:id/eligible-customers — read-only preview, no side
// effects (Spec §16). Powers the Group-based batch-creation UI's Customer
// Type filter (Locked Decision #8 / §26-5): All / Residential / Commercial.
// The filter is a selection-narrowing convenience ONLY — it does not itself
// authorize anything; DR-7 is independently re-checked at actual batch
// creation time in routes/batches.js regardless of what this preview shows.
router.get('/:id/eligible-customers', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid group id.', code: 'VALIDATION' } });
  const filter = req.query.customer_type_filter || 'all';
  if (!VALID_TYPE_FILTERS.includes(filter)) {
    return res.status(400).json({ error: { message: `customer_type_filter must be one of: ${VALID_TYPE_FILTERS.join(', ')}.`, code: 'VALIDATION' } });
  }
  try {
    const groupRes = await pool.query('SELECT zone_id FROM groups WHERE id = $1', [id]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: { message: 'Group not found.', code: 'NOT_FOUND' } });
    if (!(await assertZoneAccess(req.user, groupRes.rows[0].zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this group.', code: 'FORBIDDEN' } });
    }
    const params = [id];
    let typeSql = '';
    if (filter !== 'all') { params.push(filter); typeSql = ` AND customer_type = $${params.length}`; }
    const result = await pool.query(
      `SELECT id, customer_type FROM customers WHERE group_id = $1 AND status = 'active'${typeSql}`,
      params
    );
    const residential = result.rows.filter((r) => r.customer_type === 'residential').length;
    const commercial = result.rows.filter((r) => r.customer_type === 'commercial').length;
    res.json({
      data: {
        customer_ids: result.rows.map((r) => r.id),
        count: result.rows.length,
        customer_type_breakdown: { residential, commercial },
      },
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to resolve eligible customers.', code: 'INTERNAL' } });
  }
});

function validateGroupInput(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  if (!partial) {
    const zoneId = parseStrictId(String(body.zone_id ?? ''));
    if (zoneId === null) errors.push('zone_id is required and must be a valid zone.');
    else out.zone_id = zoneId;
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

// POST /api/v2/groups — admin, gudoomiye (own zone). No fixed cap on Group
// count per Zone (Locked Decision #1 / Hierarchy — "31+ groups, no
// hardcoded maximum"): this is a real, unbounded table, not an enum.
router.post('/', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const { errors, data } = validateGroupInput(req.body, { partial: false });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  if (!(await assertZoneAccess(req.user, data.zone_id))) {
    return res.status(403).json({ error: { message: 'You cannot create a group outside your assigned zone.', code: 'FORBIDDEN' } });
  }
  try {
    const dup = await pool.query('SELECT id FROM groups WHERE zone_id = $1 AND code = $2', [data.zone_id, data.code]);
    if (dup.rows.length) return res.status(409).json({ error: { message: `Group code "${data.code}" is already in use in this zone.`, code: 'DUPLICATE' } });

    const result = await pool.query(
      `INSERT INTO groups (zone_id, code, name, status, created_by) VALUES ($1,$2,$3,COALESCE($4,'active'),$5) RETURNING *`,
      [data.zone_id, data.code, data.name ?? null, data.status ?? null, req.user.id]
    );
    const group = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'group.create', entityType: 'group', entityId: group.id, before: null, after: group });
    res.status(201).json({ data: group });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'Group code is already in use in this zone.', code: 'DUPLICATE' } });
    if (err.code === '23503') return res.status(400).json({ error: { message: 'zone_id does not reference an existing zone.', code: 'VALIDATION' } });
    res.status(500).json({ error: { message: 'Failed to create group.', code: 'INTERNAL' } });
  }
});

// PUT /api/v2/groups/:id — admin, gudoomiye (own zone). zone_id is
// immutable via this route (not accepted) — moving a Group to a different
// Zone is a materially different, undecided operation (Discovery §26 non-
// blocking item on renaming/lifecycle), not silently allowed here.
router.put('/:id', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid group id.', code: 'VALIDATION' } });
  const { errors, data } = validateGroupInput(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  if (Object.keys(data).length === 0) return res.status(400).json({ error: { message: 'No valid fields provided to update.', code: 'VALIDATION' } });
  try {
    const existing = await pool.query('SELECT * FROM groups WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: { message: 'Group not found.', code: 'NOT_FOUND' } });
    const current = existing.rows[0];
    if (!(await assertZoneAccess(req.user, current.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this group.', code: 'FORBIDDEN' } });
    }
    if (data.code) {
      const dup = await pool.query('SELECT id FROM groups WHERE zone_id = $1 AND code = $2 AND id != $3', [current.zone_id, data.code, id]);
      if (dup.rows.length) return res.status(409).json({ error: { message: `Group code "${data.code}" is already in use in this zone.`, code: 'DUPLICATE' } });
    }
    const fields = Object.keys(data);
    const setSql = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = fields.map((f) => data[f]);
    values.push(id);
    const result = await pool.query(`UPDATE groups SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`, values);
    const group = result.rows[0];
    await logAudit({
      actorId: req.user.id, actorUsername: req.user.username,
      action: data.status !== undefined && data.status !== current.status ? 'group.status_change' : 'group.update',
      entityType: 'group', entityId: group.id, before: current, after: group,
    });
    res.json({ data: group });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'Group code is already in use in this zone.', code: 'DUPLICATE' } });
    res.status(500).json({ error: { message: 'Failed to update group.', code: 'INTERNAL' } });
  }
});

// DELETE is deliberately not implemented — matches the existing Zones/
// Customers convention of archive-via-status rather than hard delete, and
// avoids the unresolved question of what happens to customers/routes/
// batches still referencing a deleted Group.

module.exports = router;
