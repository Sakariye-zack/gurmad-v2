const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

const VIEW_ROLES = ['admin', 'cashier'];

// GET / — current + full history (append-only, never edited/deleted).
router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM exchange_rates ORDER BY effective_from DESC');
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load exchange rates.', code: 'INTERNAL' } });
  }
});

// POST / — Admin only. Immediate effect (effective_from = NOW()); never
// updates or deletes an existing row — history is structural.
router.post('/', authenticateToken, requireRole('admin'), async (req, res) => {
  const rate = parseFloat(req.body?.rate);
  if (isNaN(rate) || rate <= 0) return res.status(400).json({ error: { message: 'rate must be a positive number.', code: 'VALIDATION' } });
  try {
    const inserted = await pool.query(
      `INSERT INTO exchange_rates (rate, effective_from, set_by) VALUES ($1, NOW(), $2) RETURNING *`,
      [rate, req.user.id]
    );
    const row = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'exchange_rate.create', entityType: 'exchange_rate', entityId: row.id, before: null, after: row });
    res.status(201).json({ data: row });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to set exchange rate.', code: 'INTERNAL' } });
  }
});

module.exports = router;
