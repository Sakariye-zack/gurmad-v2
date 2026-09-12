const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  resolvePeriod, getExecutiveSummary, getCollectorPerformance, getZonePerformance, getTruckPerformance,
  getCollectionHistory, getRevenueForPeriod, getInvoicesSummary, getPaymentsSummary, getDebtsSummary,
  getCashoutSummary, getFinancialSummary, toCsv,
} = require('../lib/reportsCalculations');

const router = express.Router();

// Module 8 — Reports RBAC (approved matrix). Collector is explicitly
// excluded from every financial/cashout route at the requireRole() layer
// — rejected 403 before any query runs, never "compute then strip
// fields." Same local zone-scope pattern as every closed module.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const OPERATIONAL_ROLES = ['admin', 'gudoomiye', 'zone_accountant'];
const COLLECTOR_ROLES = ['collector'];
const FINANCIAL_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier'];
const READ_ONLY_ROLES = ['zone_accountant']; // documented — no write routes exist in this module anyway

function parseStrictId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^\d+$/.test(String(raw))) return null;
  return parseInt(raw, 10);
}

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

// OD-2 identity chain (same as every closed module) — a Collector's own
// employee id, resolved server-side, never trusted from a query param.
async function resolveOwnEmployeeId(user) {
  const r = await pool.query('SELECT id FROM employees WHERE user_id = $1', [user.id]);
  return r.rows[0]?.id ?? null;
}

function parsePeriodFromQuery(req) {
  const period = req.query.period || 'today';
  return resolvePeriod(period, req.query.start, req.query.end);
}

// ---------- A. Executive Summary (operational roles only — see report,
// not the disclosed simplification: Collector gets Collector Performance
// instead, not a scoped-down Executive Summary, per the Implementation
// Report's own note) ----------
router.get('/executive-summary', authenticateToken, requireRole(...OPERATIONAL_ROLES), async (req, res) => {
  const p = parsePeriodFromQuery(req);
  if (!p) return res.status(400).json({ error: { message: 'A valid period is required.', code: 'VALIDATION' } });
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const includeFinancial = FINANCIAL_ROLES.includes((req.user.role || '').toLowerCase());
    const data = await getExecutiveSummary({ zoneId: myZoneId, periodStart: p.start, periodEnd: p.end, includeFinancial });
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load executive summary.', code: 'INTERNAL' } });
  }
});

// ---------- B. Collector Performance ----------
router.get('/collector-performance', authenticateToken, requireRole(...OPERATIONAL_ROLES, ...COLLECTOR_ROLES), async (req, res) => {
  const p = parsePeriodFromQuery(req);
  if (!p) return res.status(400).json({ error: { message: 'A valid period is required.', code: 'VALIDATION' } });
  try {
    const role = (req.user.role || '').toLowerCase();
    const myZoneId = await resolveUserZoneId(req.user);
    let employeeId = parseStrictId(req.query.employee_id);
    if (role === 'collector') {
      // A Collector may only ever see their own row — their own resolved
      // employee id always wins, a query-param override is ignored.
      employeeId = await resolveOwnEmployeeId(req.user);
      if (employeeId === null) return res.json({ data: [] });
    }
    const data = await getCollectorPerformance({ zoneId: myZoneId, employeeId, periodStart: p.start, periodEnd: p.end });
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load collector performance.', code: 'INTERNAL' } });
  }
});

// ---------- C. Zone Performance ----------
router.get('/zone-performance', authenticateToken, requireRole(...OPERATIONAL_ROLES), async (req, res) => {
  const p = parsePeriodFromQuery(req);
  if (!p) return res.status(400).json({ error: { message: 'A valid period is required.', code: 'VALIDATION' } });
  try {
    const includeFinancial = FINANCIAL_ROLES.includes((req.user.role || '').toLowerCase());
    let data = await getZonePerformance({ periodStart: p.start, periodEnd: p.end, includeFinancial });
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null) data = data.filter((r) => r.zone_id === myZoneId);
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load zone performance.', code: 'INTERNAL' } });
  }
});

// ---------- D. Truck Performance ----------
router.get('/truck-performance', authenticateToken, requireRole(...OPERATIONAL_ROLES), async (req, res) => {
  const p = parsePeriodFromQuery(req);
  if (!p) return res.status(400).json({ error: { message: 'A valid period is required.', code: 'VALIDATION' } });
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const truckId = parseStrictId(req.query.truck_id);
    const data = await getTruckPerformance({ zoneId: myZoneId, truckId, periodStart: p.start, periodEnd: p.end });
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load truck performance.', code: 'INTERNAL' } });
  }
});

// ---------- E. Collection History ----------
router.get('/collection-history', authenticateToken, requireRole(...OPERATIONAL_ROLES), async (req, res) => {
  const p = parsePeriodFromQuery(req);
  if (!p) return res.status(400).json({ error: { message: 'A valid period is required.', code: 'VALIDATION' } });
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const customerId = parseStrictId(req.query.customer_id);
    const batchId = parseStrictId(req.query.batch_id);
    const status = req.query.status || null;
    const limit = Math.min(parseStrictId(req.query.limit) || 100, 500);
    const offset = parseStrictId(req.query.offset) || 0;
    const data = await getCollectionHistory({ zoneId: myZoneId, customerId, batchId, status, periodStart: p.start, periodEnd: p.end, limit, offset });
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load collection history.', code: 'INTERNAL' } });
  }
});

// ---------- F. Revenue ----------
router.get('/revenue', authenticateToken, requireRole(...FINANCIAL_ROLES), async (req, res) => {
  const p = parsePeriodFromQuery(req);
  if (!p) return res.status(400).json({ error: { message: 'A valid period is required.', code: 'VALIDATION' } });
  try {
    const role = (req.user.role || '').toLowerCase();
    const myZoneId = await resolveUserZoneId(req.user);
    // Cashier: own-recorded-payments only (matches the reference system's
    // existing today-scoped precedent, extended to any approved period).
    const cashierId = role === 'cashier' ? req.user.id : parseStrictId(req.query.cashier_id);
    const data = await getRevenueForPeriod({ zoneId: myZoneId, cashierId, periodStart: p.start, periodEnd: p.end });
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load revenue.', code: 'INTERNAL' } });
  }
});

// ---------- Invoices / Payments / Debts summaries ----------
router.get('/invoices-summary', authenticateToken, requireRole(...FINANCIAL_ROLES), async (req, res) => {
  const p = parsePeriodFromQuery(req);
  if (!p) return res.status(400).json({ error: { message: 'A valid period is required.', code: 'VALIDATION' } });
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const limit = Math.min(parseStrictId(req.query.limit) || 100, 500);
    const offset = parseStrictId(req.query.offset) || 0;
    const data = await getInvoicesSummary({ zoneId: myZoneId, status: req.query.status || null, periodStart: p.start, periodEnd: p.end, limit, offset });
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load invoices summary.', code: 'INTERNAL' } });
  }
});

router.get('/payments-summary', authenticateToken, requireRole(...FINANCIAL_ROLES), async (req, res) => {
  const p = parsePeriodFromQuery(req);
  if (!p) return res.status(400).json({ error: { message: 'A valid period is required.', code: 'VALIDATION' } });
  try {
    const role = (req.user.role || '').toLowerCase();
    const myZoneId = await resolveUserZoneId(req.user);
    const cashierId = role === 'cashier' ? req.user.id : parseStrictId(req.query.cashier_id);
    const limit = Math.min(parseStrictId(req.query.limit) || 100, 500);
    const offset = parseStrictId(req.query.offset) || 0;
    const data = await getPaymentsSummary({ zoneId: myZoneId, cashierId, periodStart: p.start, periodEnd: p.end, limit, offset });
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load payments summary.', code: 'INTERNAL' } });
  }
});

router.get('/debts-summary', authenticateToken, requireRole(...FINANCIAL_ROLES), async (req, res) => {
  const p = parsePeriodFromQuery(req);
  if (!p) return res.status(400).json({ error: { message: 'A valid period is required.', code: 'VALIDATION' } });
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const limit = Math.min(parseStrictId(req.query.limit) || 100, 500);
    const offset = parseStrictId(req.query.offset) || 0;
    const data = await getDebtsSummary({ zoneId: myZoneId, status: req.query.status || null, periodStart: p.start, periodEnd: p.end, limit, offset });
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load debts summary.', code: 'INTERNAL' } });
  }
});

// ---------- G. Cashout / Reconciliation ----------
router.get('/cashout-summary', authenticateToken, requireRole(...FINANCIAL_ROLES), async (req, res) => {
  const p = parsePeriodFromQuery(req);
  if (!p) return res.status(400).json({ error: { message: 'A valid period is required.', code: 'VALIDATION' } });
  try {
    const role = (req.user.role || '').toLowerCase();
    const myZoneId = await resolveUserZoneId(req.user);
    const cashierId = role === 'cashier' ? req.user.id : parseStrictId(req.query.cashier_id);
    const data = await getCashoutSummary({ zoneId: myZoneId, cashierId, periodStart: p.start, periodEnd: p.end });
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load cashout summary.', code: 'INTERNAL' } });
  }
});

// ---------- H. Financial Summary ----------
router.get('/financial-summary', authenticateToken, requireRole(...FINANCIAL_ROLES), async (req, res) => {
  const p = parsePeriodFromQuery(req);
  if (!p) return res.status(400).json({ error: { message: 'A valid period is required.', code: 'VALIDATION' } });
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const data = await getFinancialSummary({ zoneId: myZoneId, periodStart: p.start, periodEnd: p.end });
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load financial summary.', code: 'INTERNAL' } });
  }
});

// ---------- CSV export (§12/§13: identical calc/filter/RBAC path as the
// visible report; audited per §19) ----------
const EXPORTABLE = {
  'collector-performance': { roles: [...OPERATIONAL_ROLES, ...COLLECTOR_ROLES], fn: 'collector', columns: [
    { key: 'collector_name', label: 'Collector' }, { key: 'zone_name', label: 'Zone' }, { key: 'assigned', label: 'Assigned' },
    { key: 'serviced', label: 'Serviced' }, { key: 'missed', label: 'Missed' }, { key: 'skipped', label: 'Skipped' },
    { key: 'rescheduled', label: 'Rescheduled' }, { key: 'completionRate', label: 'Completion %' },
  ] },
  'zone-performance': { roles: OPERATIONAL_ROLES, fn: 'zone', columns: [
    { key: 'zone_name', label: 'Zone' }, { key: 'batches', label: 'Batches' }, { key: 'assigned_customers', label: 'Assigned' },
    { key: 'serviced', label: 'Serviced' }, { key: 'missed', label: 'Missed' }, { key: 'skipped', label: 'Skipped' },
    { key: 'rescheduled', label: 'Rescheduled' }, { key: 'completionRate', label: 'Completion %' },
  ] },
  'invoices-summary': { roles: FINANCIAL_ROLES, fn: 'invoices', columns: [
    { key: 'invoice_number', label: 'Invoice' }, { key: 'customer_name', label: 'Customer' }, { key: 'invoice_total', label: 'Total' },
    { key: 'status', label: 'Status' }, { key: 'created_at', label: 'Date' },
  ] },
  'payments-summary': { roles: FINANCIAL_ROLES, fn: 'payments', columns: [
    { key: 'invoice_number', label: 'Invoice' }, { key: 'customer_name', label: 'Customer' }, { key: 'amount', label: 'Amount' },
    { key: 'currency', label: 'Currency' }, { key: 'amount_usd', label: 'USD Value' }, { key: 'method', label: 'Method' },
    { key: 'status', label: 'Status' }, { key: 'created_at', label: 'Date' },
  ] },
  'debts-summary': { roles: FINANCIAL_ROLES, fn: 'debts', columns: [
    { key: 'customer_name', label: 'Customer' }, { key: 'amount', label: 'Amount' }, { key: 'status', label: 'Status' }, { key: 'created_at', label: 'Date' },
  ] },
  // Added (Phase 10 — user-reported: 'si isla xisaabtanku u hagaago' —
  // so the accounting itself reconciles): the Collection History tab
  // was the one report with no Export CSV at all, and GET
  // /collection-history's own existing ?status= filter was never
  // exposed anywhere in the UI. A cashier/gudoomiye trying to
  // reconcile who was actually serviced vs missed/skipped over a
  // period had to read a live on-screen table, not a keepable record.
  'collection-history': { roles: OPERATIONAL_ROLES, fn: 'history', columns: [
    { key: 'customer_name', label: 'Customer' }, { key: 'customer_number', label: 'Customer #' }, { key: 'batch_code', label: 'Batch' },
    { key: 'zone_name', label: 'Zone' }, { key: 'status', label: 'Status' }, { key: 'status_at', label: 'Date' },
  ] },
};

// Manual per-category role check (not requireRole middleware, since the
// allowed role set varies per category) — same 403-before-any-query
// guarantee: the role check happens before any report function runs.
router.get('/:category/export.csv', authenticateToken, async (req, res) => {
  const category = req.params.category;
  const def = EXPORTABLE[category];
  if (!def) return res.status(404).json({ error: { message: 'Unknown export category.', code: 'NOT_FOUND' } });
  const role = (req.user.role || '').toLowerCase();
  if (role !== 'admin' && !def.roles.includes(role)) {
    return res.status(403).json({ error: { message: 'You do not have permission to export this report.', code: 'FORBIDDEN' } });
  }
  const p = parsePeriodFromQuery(req);
  if (!p) return res.status(400).json({ error: { message: 'A valid period is required.', code: 'VALIDATION' } });
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    let rows;
    if (def.fn === 'collector') {
      let employeeId = parseStrictId(req.query.employee_id);
      if (role === 'collector') employeeId = await resolveOwnEmployeeId(req.user);
      rows = await getCollectorPerformance({ zoneId: myZoneId, employeeId, periodStart: p.start, periodEnd: p.end });
    } else if (def.fn === 'zone') {
      rows = await getZonePerformance({ periodStart: p.start, periodEnd: p.end, includeFinancial: false });
      if (myZoneId !== null) rows = rows.filter((r) => r.zone_id === myZoneId);
    } else if (def.fn === 'invoices') {
      rows = await getInvoicesSummary({ zoneId: myZoneId, status: req.query.status || null, periodStart: p.start, periodEnd: p.end, limit: 1000, offset: 0 });
    } else if (def.fn === 'payments') {
      const cashierId = role === 'cashier' ? req.user.id : parseStrictId(req.query.cashier_id);
      rows = await getPaymentsSummary({ zoneId: myZoneId, cashierId, periodStart: p.start, periodEnd: p.end, limit: 1000, offset: 0 });
    } else if (def.fn === 'debts') {
      rows = await getDebtsSummary({ zoneId: myZoneId, status: req.query.status || null, periodStart: p.start, periodEnd: p.end, limit: 1000, offset: 0 });
    } else if (def.fn === 'history') {
      rows = await getCollectionHistory({ zoneId: myZoneId, status: req.query.status || null, periodStart: p.start, periodEnd: p.end, limit: 1000, offset: 0 });
    }
    const csv = toCsv(rows, def.columns);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'report.export', entityType: 'report', entityId: null, before: null, after: { category, rowCount: rows.length, period: req.query.period } });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${category}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to export report.', code: 'INTERNAL' } });
  }
});

// ---------- Group & Group-Based Collection — Change Request. Implementation
// Spec §13 (Reporting, approved scope). Additive endpoints only — nothing
// above this line is modified. Both queries join through batches.group_id
// (the historical-integrity snapshot, Spec §5) — NEVER through a live join
// to customers.group_id — so a later customer Group move never changes an
// already-reported number for a past batch. Financial attribution is
// deliberately untouched: neither endpoint reads invoices/payments. ----------
router.get('/groups/:id/summary', authenticateToken, requireRole(...OPERATIONAL_ROLES), async (req, res) => {
  const groupId = parseStrictId(req.params.id);
  if (groupId === null) return res.status(400).json({ error: { message: 'Invalid group id.', code: 'VALIDATION' } });
  try {
    const groupRes = await pool.query('SELECT zone_id FROM groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: { message: 'Group not found.', code: 'NOT_FOUND' } });
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && groupRes.rows[0].zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this group.', code: 'FORBIDDEN' } });
    }
    const result = await pool.query(
      `SELECT
         COUNT(bc.id)::int AS assigned,
         COUNT(bc.id) FILTER (WHERE bc.status = 'serviced')::int    AS serviced,
         COUNT(bc.id) FILTER (WHERE bc.status = 'missed')::int      AS missed,
         COUNT(bc.id) FILTER (WHERE bc.status = 'skipped')::int     AS skipped,
         COUNT(bc.id) FILTER (WHERE bc.status = 'rescheduled')::int AS rescheduled,
         COUNT(bc.id) FILTER (WHERE bc.status = 'pending')::int     AS remaining,
         ROUND(100.0 * COUNT(bc.id) FILTER (WHERE bc.status = 'serviced') / NULLIF(COUNT(bc.id), 0), 1) AS completion_pct
       FROM batches b
       JOIN batch_customers bc ON bc.batch_id = b.id
       WHERE b.group_id = $1`,
      [groupId]
    );
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load group summary.', code: 'INTERNAL' } });
  }
});

router.get('/groups/:id/collector-performance', authenticateToken, requireRole(...OPERATIONAL_ROLES), async (req, res) => {
  const groupId = parseStrictId(req.params.id);
  if (groupId === null) return res.status(400).json({ error: { message: 'Invalid group id.', code: 'VALIDATION' } });
  try {
    const groupRes = await pool.query('SELECT zone_id FROM groups WHERE id = $1', [groupId]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: { message: 'Group not found.', code: 'NOT_FOUND' } });
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && groupRes.rows[0].zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this group.', code: 'FORBIDDEN' } });
    }
    const result = await pool.query(
      `SELECT e.id AS collector_id, e.name AS collector_name,
         COUNT(bc.id)::int AS assigned,
         COUNT(bc.id) FILTER (WHERE bc.status = 'serviced')::int AS serviced,
         COUNT(bc.id) FILTER (WHERE bc.status = 'missed')::int   AS missed
       FROM batches b
       JOIN tasks t ON t.batch_id = b.id
       JOIN task_resources tr ON tr.task_id = t.id AND tr.resource_type = 'collector'
       JOIN employees e ON e.id = tr.resource_id
       LEFT JOIN batch_customers bc ON bc.batch_id = b.id
       WHERE b.group_id = $1
       GROUP BY e.id, e.name ORDER BY e.name`,
      [groupId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load group collector performance.', code: 'INTERNAL' } });
  }
});

module.exports = router;
