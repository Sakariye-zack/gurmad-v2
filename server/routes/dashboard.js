const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  resolvePeriod, getExecutiveSummary, getRevenueForPeriod, getZonePerformance,
  getCollectorPerformance, getCashoutSummary,
} = require('../lib/reportsCalculations');

const router = express.Router();

// Module 9 — Dashboard. Composition + presentation ONLY — every figure
// here is produced by an already-frozen Module 8 function, never a new
// SQL query. Architecture: Modules 1-8 -> Module 8 calculation layer ->
// Module 9 composition -> Dashboard UI. Same local zone-scope/RBAC
// pattern as every closed module — no new engine.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

router.get('/summary', authenticateToken, requireRole('admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier', 'collector'), async (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  const p = resolvePeriod(req.query.period || 'today', req.query.start, req.query.end);
  if (!p) return res.status(400).json({ error: { message: 'A valid period is required.', code: 'VALIDATION' } });

  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const summary = { period: req.query.period || 'today' };

    // Collector: operational-only, NEVER a financial query for this role
    // (the same structural guarantee Module 8 already established —
    // rejected/omitted before any financial function runs, not computed
    // then stripped).
    if (role === 'collector') {
      summary.collectorPerformance = await getCollectorPerformance({ employeeId: null, periodStart: p.start, periodEnd: p.end }, pool)
        .then(async (rows) => {
          // Own row only — resolved server-side via the OD-2 identity
          // chain, same as every closed module's own pattern.
          const empRes = await pool.query('SELECT id FROM employees WHERE user_id = $1', [req.user.id]);
          const myId = empRes.rows[0]?.id ?? null;
          return myId === null ? [] : rows.filter((r) => r.employee_id === myId);
        });
      return res.json({ data: summary });
    }

    // Head of Cashiers / Cashier: financial/cashout-scoped only, matching
    // Module 8's own RBAC exactly — no operational tiles.
    if (role === 'head_of_cashiers' || role === 'cashier') {
      const cashierId = role === 'cashier' ? req.user.id : null;
      summary.revenue = await getRevenueForPeriod({ zoneId: myZoneId, cashierId, periodStart: p.start, periodEnd: p.end }, pool);
      summary.cashout = await getCashoutSummary({ zoneId: myZoneId, cashierId, periodStart: p.start, periodEnd: p.end }, pool);
      return res.json({ data: summary });
    }

    // Admin / Gudoomiye / Zone Accountant: full composed snapshot,
    // company-wide or zone-scoped per the same resolver every closed
    // module already uses.
    summary.executive = await getExecutiveSummary({ zoneId: myZoneId, periodStart: p.start, periodEnd: p.end, includeFinancial: true }, pool);
    let zonePerf = await getZonePerformance({ periodStart: p.start, periodEnd: p.end, includeFinancial: true }, pool);
    if (myZoneId !== null) zonePerf = zonePerf.filter((z) => z.zone_id === myZoneId);
    summary.zonePerformance = zonePerf;
    summary.collectorPerformance = (await getCollectorPerformance({ zoneId: myZoneId, employeeId: null, periodStart: p.start, periodEnd: p.end }, pool)).slice(0, 10);
    summary.cashout = await getCashoutSummary({ zoneId: myZoneId, periodStart: p.start, periodEnd: p.end }, pool);

    res.json({ data: summary });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load dashboard summary.', code: 'INTERNAL' } });
  }
});

module.exports = router;
