const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

const VALID_STATUSES = ['active', 'inactive'];
const ZONE_CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,49}$/;

// Strict: parseInt() alone would silently truncate "1 OR 1=1" or "1abc" to
// 1 and resolve it as a valid id. Not exploitable (queries are parameterized)
// but it's a real validation gap — found during Phase 3 Module 1 QA.
function parseStrictId(raw) {
  if (!/^\d+$/.test(raw)) return null;
  return parseInt(raw, 10);
}

function validateZoneInput(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 100) {
      errors.push('name is required and must be 1-100 characters.');
    } else {
      out.name = body.name.trim();
    }
  }

  if (!partial || body.zone_code !== undefined) {
    const code = typeof body.zone_code === 'string' ? body.zone_code.trim().toUpperCase() : '';
    if (!ZONE_CODE_RE.test(code)) {
      errors.push('zone_code is required and must be 2-50 uppercase letters/digits/hyphens.');
    } else {
      out.zone_code = code;
    }
  }

  if (body.sub_zone !== undefined) {
    out.sub_zone = body.sub_zone === null ? null : String(body.sub_zone).trim().slice(0, 100);
  }
  if (body.area !== undefined) {
    out.area = body.area === null ? null : String(body.area).trim().slice(0, 100);
  }
  if (body.coordinates !== undefined) {
    if (body.coordinates !== null && typeof body.coordinates !== 'object') {
      errors.push('coordinates must be an object or null.');
    } else {
      out.coordinates = body.coordinates;
    }
  }
  if (body.collection_days !== undefined) {
    if (body.collection_days !== null && !Array.isArray(body.collection_days)) {
      errors.push('collection_days must be an array or null.');
    } else {
      out.collection_days = body.collection_days;
    }
  }
  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) {
      errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}.`);
    } else {
      out.status = body.status;
    }
  }

  return { errors, data: out };
}

// GET /api/v2/zones — any authenticated staff role. No zone-scoping applied
// here: Zones is the scope-defining entity, not a scoped one (see Discovery
// report, "Zone-scoping requirements"). Supports simple pagination/filtering.
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const where = [];
    const params = [];
    if (status) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: { message: `Invalid status filter. Must be one of: ${VALID_STATUSES.join(', ')}.`, code: 'VALIDATION' } });
      }
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM zones ${whereSql}`, params);
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT * FROM zones ${whereSql} ORDER BY name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: result.rows, meta: { total: countResult.rows[0].total, limit, offset } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list zones.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/zones/:id
router.get('/:id', authenticateToken, async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: { message: 'Invalid zone id.', code: 'VALIDATION' } });
  }
  try {
    const result = await pool.query('SELECT * FROM zones WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Zone not found.', code: 'NOT_FOUND' } });
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load zone.', code: 'INTERNAL' } });
  }
});

// POST /api/v2/zones — admin only.
router.post('/', authenticateToken, requireRole('admin'), async (req, res) => {
  const { errors, data } = validateZoneInput(req.body, { partial: false });
  if (errors.length) {
    return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  }
  try {
    const dup = await pool.query('SELECT id FROM zones WHERE zone_code = $1', [data.zone_code]);
    if (dup.rows.length) {
      return res.status(409).json({ error: { message: `zone_code "${data.zone_code}" is already in use.`, code: 'DUPLICATE' } });
    }
    const result = await pool.query(
      `INSERT INTO zones (name, zone_code, sub_zone, area, coordinates, collection_days, status)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'active'))
       RETURNING *`,
      [data.name, data.zone_code, data.sub_zone ?? null, data.area ?? null,
       data.coordinates ? JSON.stringify(data.coordinates) : null,
       data.collection_days ? JSON.stringify(data.collection_days) : null,
       data.status ?? null]
    );
    const zone = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'zone.create', entityType: 'zone', entityId: zone.id, before: null, after: zone });
    res.status(201).json({ data: zone });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: { message: 'zone_code is already in use.', code: 'DUPLICATE' } });
    }
    res.status(500).json({ error: { message: 'Failed to create zone.', code: 'INTERNAL' } });
  }
});

// PUT /api/v2/zones/:id — admin only.
router.put('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) {
    return res.status(400).json({ error: { message: 'Invalid zone id.', code: 'VALIDATION' } });
  }
  const { errors, data } = validateZoneInput(req.body, { partial: true });
  if (errors.length) {
    return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: { message: 'No valid fields provided to update.', code: 'VALIDATION' } });
  }
  try {
    const existing = await pool.query('SELECT * FROM zones WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Zone not found.', code: 'NOT_FOUND' } });
    }
    if (data.zone_code) {
      const dup = await pool.query('SELECT id FROM zones WHERE zone_code = $1 AND id != $2', [data.zone_code, id]);
      if (dup.rows.length) {
        return res.status(409).json({ error: { message: `zone_code "${data.zone_code}" is already in use.`, code: 'DUPLICATE' } });
      }
    }

    const fields = Object.keys(data);
    const setSql = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = fields.map((f) => {
      if ((f === 'coordinates' || f === 'collection_days') && data[f] !== null) return JSON.stringify(data[f]);
      return data[f];
    });
    values.push(id);

    const result = await pool.query(
      `UPDATE zones SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`,
      values
    );
    const zone = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'zone.update', entityType: 'zone', entityId: zone.id, before: existing.rows[0], after: zone });
    res.json({ data: zone });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: { message: 'zone_code is already in use.', code: 'DUPLICATE' } });
    }
    res.status(500).json({ error: { message: 'Failed to update zone.', code: 'INTERNAL' } });
  }
});

// DELETE is deliberately not implemented — see Discovery report §Risks and
// the explicit instruction to defer it until a reassignment policy exists.

module.exports = router;
