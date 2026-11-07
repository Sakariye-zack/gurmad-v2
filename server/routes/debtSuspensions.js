const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const ds = require('../lib/debtSuspension');

// F3 — Debt suspensions (/admin/debt-suspensions). Admin and gudoomiye only;
// a gudoomiye only ever sees and acts on their own district.
const router = express.Router();
router.use(authenticateToken);

const MANAGE_ROLES = ['admin', 'gudoomiye'];
// Read-only banner figures on the customer detail page.
const OUTSTANDING_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'cashier', 'head_of_cashiers'];
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'cashier'];
const MAX_BULK = 500;
const err = (res, status, code, message) => res.status(status).json({ error: { message, code } });

function parseStrictId(raw) {
  if (!/^\d+$/.test(String(raw ?? ''))) return null;
  return parseInt(raw, 10);
}

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return -1; // scoped role without a district sees nothing
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? -1;
}

function parseIds(body) {
  const raw = Array.isArray(body?.customer_ids) ? body.customer_ids : null;
  if (!raw || raw.length === 0) return { error: 'customer_ids must be a non-empty array.' };
  if (raw.length > MAX_BULK) return { error: `At most ${MAX_BULK} customers at once.` };
  const ids = raw.map((v) => parseStrictId(v));
  if (ids.some((v) => v === null)) return { error: 'customer_ids must contain customer ids only.' };
  return { ids };
}

// GET /api/v2/debt-suspensions/candidates
router.get('/candidates', requireRole(...MANAGE_ROLES), async (req, res) => {
  try {
    const zoneId = await resolveUserZoneId(req.user);
    const { days, rows } = await ds.listCandidates({ zoneId });
    res.json({ data: rows, meta: { debt_suspend_days: days, dismiss_days: ds.DISMISS_DAYS } });
  } catch (e) {
    err(res, 500, 'INTERNAL', 'Failed to load debt suspension candidates.');
  }
});

// GET /api/v2/debt-suspensions/suspended
router.get('/suspended', requireRole(...MANAGE_ROLES), async (req, res) => {
  try {
    const zoneId = await resolveUserZoneId(req.user);
    res.json({ data: await ds.listSuspended({ zoneId }) });
  } catch (e) {
    err(res, 500, 'INTERNAL', 'Failed to load suspended customers.');
  }
});

// POST /api/v2/debt-suspensions/approve { customer_ids: [..] }
router.post('/approve', requireRole(...MANAGE_ROLES), async (req, res) => {
  const p = parseIds(req.body);
  if (p.error) return err(res, 400, 'VALIDATION', p.error);
  try {
    const zoneId = await resolveUserZoneId(req.user);
    const result = await ds.approve(p.ids, req.user, { zoneId });
    res.json({ data: result });
  } catch (e) {
    err(res, 500, 'INTERNAL', 'Failed to approve suspension.');
  }
});

// POST /api/v2/debt-suspensions/dismiss { customer_ids: [..] } — snooze 30 days.
router.post('/dismiss', requireRole(...MANAGE_ROLES), async (req, res) => {
  const p = parseIds(req.body);
  if (p.error) return err(res, 400, 'VALIDATION', p.error);
  try {
    const zoneId = await resolveUserZoneId(req.user);
    res.json({ data: await ds.dismiss(p.ids, req.user, { zoneId }) });
  } catch (e) {
    err(res, 500, 'INTERNAL', 'Failed to dismiss.');
  }
});

// POST /api/v2/debt-suspensions/check — run the reactivation sweep now (admin).
router.post('/check', requireRole('admin'), async (req, res) => {
  try {
    res.json({ data: await ds.nightlyCheck() });
  } catch (e) {
    err(res, 500, 'INTERNAL', 'Failed to run the reactivation check.');
  }
});

// GET /api/v2/debt-suspensions/customer/:id — banner figures for one customer.
router.get('/customer/:id', requireRole(...OUTSTANDING_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return err(res, 400, 'VALIDATION', 'Invalid customer id.');
  try {
    const c = (await pool.query(
      `SELECT c.id, c.zone_id, c.status, c.suspended_reason, c.suspended_at, u.username AS suspended_by_username
       FROM customers c LEFT JOIN v2_users u ON u.id = c.suspended_by WHERE c.id = $1`, [id])).rows[0];
    if (!c) return err(res, 404, 'NOT_FOUND', 'Customer not found.');
    const zoneId = await resolveUserZoneId(req.user);
    if (zoneId !== null && c.zone_id !== zoneId) return err(res, 403, 'FORBIDDEN', 'You do not have access to this customer.');
    const outstanding = await ds.customerOutstanding(id);
    res.json({ data: { customer_id: id, status: c.status, suspended_reason: c.suspended_reason, suspended_at: c.suspended_at,
      suspended_by_username: c.suspended_by_username, outstanding } });
  } catch (e) {
    err(res, 500, 'INTERNAL', 'Failed to load customer debt status.');
  }
});

module.exports = router;
