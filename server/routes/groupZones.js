const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Zone level between Group and Sub Zone (routes). Roles and zone-access
// checks mirror groups.js exactly.
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'collector'];
const WRITE_ROLES = ['admin', 'gudoomiye'];
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const VALID_STATUSES = ['active', 'inactive'];
const CODE_RE = /^.{1,30}$/;
const TEXT_MAX = 1000;

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

async function assertZoneAccess(user, districtId) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return true;
  const myZoneId = await resolveUserZoneId(user);
  return myZoneId !== null && myZoneId === districtId;
}

// GET /api/v2/group-zones?group_id=
router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.group_id) {
      const gid = parseStrictId(req.query.group_id);
      if (gid === null) return res.status(400).json({ error: { message: 'Invalid group_id filter.', code: 'VALIDATION' } });
      const g = await pool.query('SELECT zone_id FROM groups WHERE id = $1', [gid]);
      if (g.rows.length === 0) return res.status(404).json({ error: { message: 'Group not found.', code: 'NOT_FOUND' } });
      if (!(await assertZoneAccess(req.user, g.rows[0].zone_id))) {
        return res.status(403).json({ error: { message: 'You do not have access to that group.', code: 'FORBIDDEN' } });
      }
      params.push(gid);
      where.push(`gz.group_id = $${params.length}`);
    } else {
      const myZoneId = await resolveUserZoneId(req.user);
      if (myZoneId !== null) {
        params.push(myZoneId);
        where.push(`g.zone_id = $${params.length}`);
      }
    }
    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) return res.status(400).json({ error: { message: `status must be one of: ${VALID_STATUSES.join(', ')}.`, code: 'VALIDATION' } });
      params.push(req.query.status);
      where.push(`gz.status = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT gz.*, g.code AS group_code, g.zone_id,
        (SELECT COUNT(*)::int FROM routes r WHERE r.group_zone_id = gz.id) AS route_count
       FROM group_zones gz JOIN groups g ON gz.group_id = g.id
       ${whereSql} ORDER BY g.code, gz.code`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list zones.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/group-zones/:id — with its Sub Zones.
router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid zone id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query(
      `SELECT gz.*, g.code AS group_code, g.zone_id FROM group_zones gz JOIN groups g ON gz.group_id = g.id WHERE gz.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Zone not found.', code: 'NOT_FOUND' } });
    const gz = result.rows[0];
    if (!(await assertZoneAccess(req.user, gz.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this zone.', code: 'FORBIDDEN' } });
    }
    const routes = await pool.query(
      `SELECT r.*, u.full_name AS collector_name, u.is_active AS collector_active,
        (SELECT COUNT(*)::int FROM customers c WHERE c.route_id = r.id AND c.status = 'active') AS customer_count
       FROM routes r LEFT JOIN v2_users u ON u.id = r.collector_user_id
       WHERE r.group_zone_id = $1 ORDER BY r.code`,
      [id]
    );
    res.json({ data: { ...gz, routes: routes.rows } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load zone.', code: 'INTERNAL' } });
  }
});

function validateInput(body, { partial = false } = {}) {
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
  // Groups V2: free-text description + notes (optional, up to 1000 chars).
  for (const f of ['description', 'notes']) {
    if (body[f] === undefined) continue;
    if (body[f] === null) { out[f] = null; continue; }
    if (typeof body[f] !== 'string') { errors.push(`${f} must be text.`); continue; }
    const v = body[f].trim();
    if (v.length > TEXT_MAX) errors.push(`${f} must be at most ${TEXT_MAX} characters.`);
    else out[f] = v || null;
  }
  return { errors, data: out };
}

// POST /api/v2/group-zones — admin, gudoomiye (own district).
router.post('/', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const { errors, data } = validateInput(req.body, { partial: false });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  try {
    const g = await pool.query('SELECT zone_id FROM groups WHERE id = $1', [data.group_id]);
    if (g.rows.length === 0) return res.status(400).json({ error: { message: 'group_id does not reference an existing group.', code: 'VALIDATION' } });
    if (!(await assertZoneAccess(req.user, g.rows[0].zone_id))) {
      return res.status(403).json({ error: { message: 'You cannot create a zone under a group outside your assigned district.', code: 'FORBIDDEN' } });
    }
    const dup = await pool.query('SELECT id FROM group_zones WHERE group_id = $1 AND code = $2', [data.group_id, data.code]);
    if (dup.rows.length) return res.status(409).json({ error: { message: `Zone code "${data.code}" is already in use in this group.`, code: 'DUPLICATE' } });
    const result = await pool.query(
      `INSERT INTO group_zones (group_id, code, name, status, created_by, description, notes) VALUES ($1,$2,$3,COALESCE($4,'active'),$5,$6,$7) RETURNING *`,
      [data.group_id, data.code, data.name ?? null, data.status ?? null, req.user.id, data.description ?? null, data.notes ?? null]
    );
    const gz = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'group_zone.create', entityType: 'group_zone', entityId: gz.id, before: null, after: gz });
    res.status(201).json({ data: gz });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'Zone code is already in use in this group.', code: 'DUPLICATE' } });
    res.status(500).json({ error: { message: 'Failed to create zone.', code: 'INTERNAL' } });
  }
});

// PUT /api/v2/group-zones/:id — group_id immutable.
router.put('/:id', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid zone id.', code: 'VALIDATION' } });
  const { errors, data } = validateInput(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  if (Object.keys(data).length === 0) return res.status(400).json({ error: { message: 'No valid fields provided to update.', code: 'VALIDATION' } });
  try {
    const existing = await pool.query('SELECT gz.*, g.zone_id FROM group_zones gz JOIN groups g ON gz.group_id = g.id WHERE gz.id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: { message: 'Zone not found.', code: 'NOT_FOUND' } });
    const current = existing.rows[0];
    if (!(await assertZoneAccess(req.user, current.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this zone.', code: 'FORBIDDEN' } });
    }
    if (data.code) {
      const dup = await pool.query('SELECT id FROM group_zones WHERE group_id = $1 AND code = $2 AND id != $3', [current.group_id, data.code, id]);
      if (dup.rows.length) return res.status(409).json({ error: { message: `Zone code "${data.code}" is already in use in this group.`, code: 'DUPLICATE' } });
    }
    const fields = Object.keys(data);
    const setSql = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = fields.map((f) => data[f]);
    values.push(id);
    const result = await pool.query(`UPDATE group_zones SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`, values);
    const gz = result.rows[0];
    await logAudit({
      actorId: req.user.id, actorUsername: req.user.username,
      action: data.status !== undefined && data.status !== current.status ? 'group_zone.status_change' : 'group_zone.update',
      entityType: 'group_zone', entityId: gz.id, before: current, after: gz,
    });
    res.json({ data: gz });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'Zone code is already in use in this group.', code: 'DUPLICATE' } });
    res.status(500).json({ error: { message: 'Failed to update zone.', code: 'INTERNAL' } });
  }
});

module.exports = router;
