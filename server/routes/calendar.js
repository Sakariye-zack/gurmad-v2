const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Operational Calendar — Implementation Spec. New, additive, isolated
// module. Read-only projection of the CLOSED batches table — zero
// mutation, zero touch to routes/batches.js. Batch is the sole canonical
// calendar event (batches.start_date/end_date only — tasks.scheduled_at
// is never referenced).
const ALLOWED_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'];
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'head_of_cashiers'];
const VALID_STATUSES = ['draft', 'assigned', 'in_progress', 'partially_completed', 'completed', 'cancelled'];
const VALID_CUSTOMER_TYPES = ['residential', 'commercial'];
const MAX_WINDOW_DAYS = 42;

router.use(authenticateToken, requireRole(...ALLOWED_ROLES));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateString(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime());
}

function parseStrictId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^\d+$/.test(String(raw))) return null;
  return parseInt(raw, 10);
}

// Trivial, duplicated, non-decisional identity lookup — same justified
// precedent already used across Offline/Sync and Staff Notifications for
// reusing a one-line query without modifying/exporting from the CLOSED
// routes/batches.js file it also appears in.
async function resolveUserZoneId(user) {
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

// GET /api/v2/calendar/batches
router.get('/batches', async (req, res) => {
  const { from, to, zone_id, status, customer_type } = req.query;

  if (!isValidDateString(from) || !isValidDateString(to)) {
    return res.status(400).json({ error: { message: 'from and to must be valid YYYY-MM-DD dates.', code: 'VALIDATION' } });
  }
  const fromDate = new Date(from + 'T00:00:00Z');
  const toDate = new Date(to + 'T00:00:00Z');
  if (toDate < fromDate) {
    return res.status(400).json({ error: { message: 'to must not be before from.', code: 'VALIDATION' } });
  }
  const windowDays = Math.round((toDate - fromDate) / 86400000) + 1;
  if (windowDays > MAX_WINDOW_DAYS) {
    return res.status(400).json({ error: { message: `Date window cannot exceed ${MAX_WINDOW_DAYS} days.`, code: 'VALIDATION' } });
  }

  let statusList = null;
  if (status !== undefined) {
    statusList = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    if (statusList.length === 0 || statusList.some((s) => !VALID_STATUSES.includes(s))) {
      return res.status(400).json({ error: { message: `status must be one of: ${VALID_STATUSES.join(', ')}.`, code: 'VALIDATION' } });
    }
  }

  if (customer_type !== undefined && !VALID_CUSTOMER_TYPES.includes(customer_type)) {
    return res.status(400).json({ error: { message: `customer_type must be one of: ${VALID_CUSTOMER_TYPES.join(', ')}.`, code: 'VALIDATION' } });
  }

  let requestedZoneId = null;
  if (zone_id !== undefined) {
    requestedZoneId = parseStrictId(zone_id);
    if (requestedZoneId === null) {
      return res.status(400).json({ error: { message: 'Invalid zone id.', code: 'VALIDATION' } });
    }
  }

  try {
    // Zone security (Spec §11/§22): non-Admin roles are FORCED to their own
    // zone server-side — a forged/different zone_id is silently overridden,
    // never trusted, mirroring the existing assertBatchZoneAccess
    // precedent's own "never trust the client" discipline.
    let effectiveZoneId = requestedZoneId;
    const role = (req.user.role || '').toLowerCase();
    if (ZONE_SCOPED_ROLES.includes(role)) {
      const myZoneId = await resolveUserZoneId(req.user);
      effectiveZoneId = myZoneId; // overrides any client-supplied value, including null
      if (effectiveZoneId === null) {
        return res.json({ data: [] }); // no resolvable zone -> nothing to show, not an error
      }
    }

    const params = [to, from];
    let where = 'b.start_date <= $1 AND (b.end_date IS NULL OR b.end_date >= $2)';
    if (effectiveZoneId !== null) {
      params.push(effectiveZoneId);
      where += ` AND b.zone_id = $${params.length}`;
    }
    if (statusList) {
      params.push(statusList);
      where += ` AND b.status = ANY($${params.length}::text[])`;
    }
    if (customer_type !== undefined) {
      params.push(customer_type);
      where += ` AND b.customer_type = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT b.id, b.batch_code, b.start_date, b.end_date, b.status, b.zone_id, z.name AS zone_name,
              b.customer_type, b.commercial_shift, b.total_customers
       FROM batches b
       JOIN zones z ON z.id = b.zone_id
       WHERE ${where}
       ORDER BY b.start_date ASC, b.id ASC`,
      params
    );

    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load calendar data.', code: 'INTERNAL' } });
  }
});

module.exports = router;
