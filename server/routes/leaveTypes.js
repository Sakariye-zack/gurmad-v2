const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Phase 1 HR & Payroll — Spec §4. Reference catalog, ungated read
// (matches Zones' own "no legitimate role excluded from viewing"
// precedent), admin-only write. No accrual/entitlement engine.

router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM leave_types ORDER BY label ASC');
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list leave types.', code: 'INTERNAL' } });
  }
});

router.post('/', authenticateToken, requireRole('admin'), async (req, res) => {
  const { code, label, is_paid } = req.body;
  if (!code || !String(code).trim()) return res.status(400).json({ error: { message: 'code is required.', code: 'VALIDATION' } });
  if (!label || !String(label).trim()) return res.status(400).json({ error: { message: 'label is required.', code: 'VALIDATION' } });
  try {
    const inserted = await pool.query(
      `INSERT INTO leave_types (code, label, is_paid) VALUES ($1,$2,$3) RETURNING *`,
      [String(code).trim().toLowerCase(), String(label).trim(), is_paid !== false]
    );
    const type = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'leave_type.create', entityType: 'leave_type', entityId: type.id, before: null, after: type });
    res.status(201).json({ data: type });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'A leave type with this code already exists.', code: 'CONFLICT' } });
    res.status(500).json({ error: { message: 'Failed to create leave type.', code: 'INTERNAL' } });
  }
});

// PUT /:id/status — activate/deactivate. Never delete reference data.
router.put('/:id/status', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: { message: 'Invalid leave type id.', code: 'VALIDATION' } });
  const { status } = req.body;
  if (!['active', 'inactive'].includes(status)) return res.status(400).json({ error: { message: "status must be 'active' or 'inactive'.", code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM leave_types WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Leave type not found.', code: 'NOT_FOUND' } });
    const updated = await pool.query('UPDATE leave_types SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *', [status, id]);
    const type = updated.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'leave_type.status', entityType: 'leave_type', entityId: type.id, before: before.rows[0], after: type });
    res.json({ data: type });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update leave type.', code: 'INTERNAL' } });
  }
});

module.exports = router;
