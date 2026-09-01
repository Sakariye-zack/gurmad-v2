const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

const VALID_CYCLE_TYPES = ['monthly', 'weekly', 'custom'];
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant'];
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

router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const where = [];
    const params = [];
    if (myZoneId !== null) {
      params.push(myZoneId);
      where.push(`collection_cycles.zone_id = $${params.length}`);
    }
    if (req.query.is_active !== undefined) {
      params.push(req.query.is_active === 'true');
      where.push(`collection_cycles.is_active = $${params.length}`);
    }
    if (req.query.zone_id) {
      const zid = parseStrictId(req.query.zone_id);
      if (zid === null) return res.status(400).json({ error: { message: 'Invalid zone_id filter.', code: 'VALIDATION' } });
      if (myZoneId !== null && zid !== myZoneId) return res.status(403).json({ error: { message: 'You do not have access to that zone.', code: 'FORBIDDEN' } });
      params.push(zid);
      where.push(`collection_cycles.zone_id = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT collection_cycles.*, zones.name AS zone_name FROM collection_cycles
       LEFT JOIN zones ON collection_cycles.zone_id = zones.id
       ${whereSql} ORDER BY collection_cycles.created_at DESC`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list collection cycles.', code: 'INTERNAL' } });
  }
});

router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cycle id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query(
      `SELECT collection_cycles.*, zones.name AS zone_name FROM collection_cycles
       LEFT JOIN zones ON collection_cycles.zone_id = zones.id WHERE collection_cycles.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Cycle not found.', code: 'NOT_FOUND' } });
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && result.rows[0].zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this cycle.', code: 'FORBIDDEN' } });
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load cycle.', code: 'INTERNAL' } });
  }
});

router.post('/', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const { zone_id, cycle_type, start_date, end_date } = req.body;
  const zid = parseStrictId(String(zone_id ?? ''));
  if (zid === null) return res.status(400).json({ error: { message: 'zone_id is required.', code: 'VALIDATION' } });
  if (!VALID_CYCLE_TYPES.includes(cycle_type)) return res.status(400).json({ error: { message: `cycle_type must be one of: ${VALID_CYCLE_TYPES.join(', ')}.`, code: 'VALIDATION' } });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(end_date || '')) {
    return res.status(400).json({ error: { message: 'start_date and end_date are required (YYYY-MM-DD).', code: 'VALIDATION' } });
  }
  const myZoneId = await resolveUserZoneId(req.user);
  if (myZoneId !== null && zid !== myZoneId) {
    return res.status(403).json({ error: { message: 'You cannot create a cycle outside your assigned zone.', code: 'FORBIDDEN' } });
  }
  try {
    const result = await pool.query(
      `INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [zid, cycle_type, start_date, end_date, req.user.id]
    );
    const cycle = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cycle.create', entityType: 'collection_cycle', entityId: cycle.id, before: null, after: cycle });
    res.status(201).json({ data: cycle });
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: { message: 'zone_id does not reference an existing zone.', code: 'VALIDATION' } });
    res.status(500).json({ error: { message: 'Failed to create cycle.', code: 'INTERNAL' } });
  }
});

// PUT /:id/close — cycle lifecycle is a plain boolean (is_active), matching
// the current system's own proven two-state model (see db.js comment) —
// no new lifecycle vocabulary invented.
router.put('/:id/close', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cycle id.', code: 'VALIDATION' } });
  try {
    const existing = await pool.query('SELECT * FROM collection_cycles WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: { message: 'Cycle not found.', code: 'NOT_FOUND' } });
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && existing.rows[0].zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this cycle.', code: 'FORBIDDEN' } });
    }
    const result = await pool.query(`UPDATE collection_cycles SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [id]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cycle.close', entityType: 'collection_cycle', entityId: id, before: existing.rows[0], after: result.rows[0] });
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to close cycle.', code: 'INTERNAL' } });
  }
});

module.exports = router;
