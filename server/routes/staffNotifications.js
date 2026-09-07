const express = require('express');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Staff Notifications — Implementation Spec §17. Every staff role may
// access ONLY its own notifications — recipient_id is always
// server-resolved from req.user.id (existing, unmodified
// authenticateToken), never client-supplied. No new RBAC role; every
// existing role gets identical, self-scoped behavior. No POST/DELETE —
// creation is trigger-only (Decisions §20/lib/staffNotifications.js),
// deletion is not authorized in v1 (Decisions §8).
router.use(authenticateToken);

function parseStrictId(raw) {
  if (!/^\d+$/.test(raw)) return null;
  return parseInt(raw, 10);
}

// GET /api/v2/staff-notifications — list the caller's own notifications.
router.get('/', async (req, res) => {
  const unreadOnly = req.query.unread_only === 'true';
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const cursor = req.query.cursor ? parseStrictId(req.query.cursor) : null;
  try {
    const params = [req.user.id];
    let where = 'recipient_id = $1';
    if (unreadOnly) where += ' AND is_read = FALSE';
    if (cursor !== null) {
      params.push(cursor);
      where += ` AND id < $${params.length}`;
    }
    params.push(limit);
    const result = await pool.query(
      `SELECT * FROM v2_staff_notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params
    );
    const next_cursor = result.rows.length === limit ? result.rows[result.rows.length - 1].id : null;
    res.json({ data: result.rows, next_cursor });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load notifications.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/staff-notifications/unread-count
router.get('/unread-count', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT COUNT(*)::int AS count FROM v2_staff_notifications WHERE recipient_id = $1 AND is_read = FALSE',
      [req.user.id]
    );
    res.json({ data: { count: result.rows[0].count } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load unread count.', code: 'INTERNAL' } });
  }
});

// PUT /api/v2/staff-notifications/:id/read — ownership-checked before
// mutation; 404 (never 403) for a not-found-or-not-owned id, matching the
// Customer Portal's own established anti-enumeration precedent for this
// exact class of check.
router.put('/:id/read', async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid notification id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query(
      `UPDATE v2_staff_notifications SET is_read = TRUE, read_at = NOW()
       WHERE id = $1 AND recipient_id = $2 RETURNING *`,
      [id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Notification not found.', code: 'NOT_FOUND' } });
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update notification.', code: 'INTERNAL' } });
  }
});

// PUT /api/v2/staff-notifications/read-all
router.put('/read-all', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE v2_staff_notifications SET is_read = TRUE, read_at = NOW()
       WHERE recipient_id = $1 AND is_read = FALSE RETURNING id`,
      [req.user.id]
    );
    res.json({ data: { updated: result.rows.length } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update notifications.', code: 'INTERNAL' } });
  }
});

module.exports = router;
