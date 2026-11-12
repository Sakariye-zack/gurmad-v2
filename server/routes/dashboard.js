const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  resolvePeriod, getExecutiveSummary, getRevenueForPeriod, getZonePerformance,
  getCollectorPerformance, getCashoutSummary,
} = require('../lib/reportsCalculations');
const { getTimezone, localParts } = require('../lib/autoBilling');
const { getLiveTrucks } = require('../lib/liveTrucks');

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

// ---------- F7. Operations panel ("Today" cards) ----------
// GET /api/v2/dashboard/operations-today — admin (company-wide) and
// gudoomiye (own district, same resolver as /summary; a gudoomiye with no
// district gets an all-zero panel, never company-wide). Each figure reuses
// the module that owns it: today's auto lists (lib/dailyLists' batches),
// live trucks (lib/liveTrucks, the Map's own query), backups
// (lib/backups.getStatus, same overdue rule as lib/backupMonitor), fleet
// alerts (Fleet > Expiry documents + maintenance due from lib/fleetInsights)
// and debt-suspension candidates (lib/debtSuspension.countDebtCandidates —
// null while that module is not installed). Backups are admin-only (same as
// the Backups page): null for gudoomiye.
const OPS_ROLES = ['admin', 'gudoomiye'];

function loadDebtCandidateCounter() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('../lib/debtSuspension');
    return typeof mod.countDebtCandidates === 'function' ? mod.countDebtCandidates : null;
  } catch (_) {
    return null;
  }
}

async function opsLists(zoneId, today) {
  const params = [today];
  let zoneSql = '';
  if (zoneId !== null) { params.push(zoneId); zoneSql = ` AND b.zone_id = $${params.length}`; }
  const r = await pool.query(
    `SELECT COUNT(DISTINCT b.id)::int AS lists,
            COUNT(bc.id)::int AS total,
            COUNT(bc.id) FILTER (WHERE bc.status = 'serviced')::int AS serviced,
            COUNT(bc.id) FILTER (WHERE bc.status = 'missed')::int AS missed,
            COUNT(bc.id) FILTER (WHERE bc.status = 'pending')::int AS pending
     FROM batches b
     LEFT JOIN batch_customers bc ON bc.batch_id = b.id
     WHERE b.auto_generated AND b.start_date = $1::date AND b.status <> 'cancelled'${zoneSql}`,
    params
  );
  return r.rows[0];
}

async function opsBackup() {
  const backups = require('../lib/backups');
  const status = await backups.getStatus();
  const lastAt = status.last ? status.last.at : null;
  const overdue = !status.last || Date.now() - Date.parse(lastAt) > backups.OVERDUE_MS;
  const failed = !!status.last_error;
  return { ok: !overdue && !failed, last_at: lastAt, overdue, failed };
}

async function opsFleetAlerts(zoneId, today) {
  const { getExpiringDocuments } = require('../lib/fleetCalculations');
  const { getNextMaintenance } = require('../lib/fleetInsights');
  const docs = await getExpiringDocuments({ zoneId, withinDays: 30 });
  const next = await getNextMaintenance({ today });
  let due = 0;
  for (const m of next.values()) {
    // Same visibility as Fleet overview: own district + company-wide trucks.
    if (m.due && (zoneId === null || m.zone_id === zoneId || m.zone_id === null)) due += 1;
  }
  return { documents: docs.length, maintenance_due: due, total: docs.length + due };
}

router.get('/operations-today', authenticateToken, requireRole(...OPS_ROLES), async (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  try {
    const tz = await getTimezone();
    const today = localParts(new Date(), tz).date;
    const zoneId = await resolveUserZoneId(req.user);
    const noZone = role !== 'admin' && zoneId === null;
    const counter = loadDebtCandidateCounter();

    if (noZone) {
      return res.json({ data: {
        date: today, zone_id: null,
        lists: { lists: 0, total: 0, serviced: 0, missed: 0, pending: 0 },
        collectors_active: 0, trucks_live: 0,
        debt_candidates: counter ? 0 : null,
        backup: null,
        fleet_alerts: { documents: 0, maintenance_due: 0, total: 0 },
      } });
    }

    const [lists, live, fleetAlerts, backup, debt] = await Promise.all([
      opsLists(zoneId, today),
      getLiveTrucks({ zoneId }),
      opsFleetAlerts(zoneId, today),
      role === 'admin' ? opsBackup() : Promise.resolve(null),
      counter ? Promise.resolve().then(() => counter({ zoneId })).then((n) => (n == null ? null : Number(n))).catch(() => null) : Promise.resolve(null),
    ]);
    const liveTruckIds = new Set(live.filter((x) => x.status === 'live' && x.truck_id != null).map((x) => x.truck_id));

    res.json({ data: {
      date: today,
      zone_id: zoneId,
      lists,
      collectors_active: live.length,
      trucks_live: liveTruckIds.size,
      debt_candidates: debt,
      backup,
      fleet_alerts: fleetAlerts,
    } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load today\'s operations.', code: 'INTERNAL' } });
  }
});

// ---------- Setup checklist ----------
// GET /api/v2/dashboard/setup-health — admin (company-wide) and gudoomiye
// (own district; no district = empty "all set" panel, never company-wide),
// same scoping as operations-today. Read-only: lists what keeps Sub Zones
// and customers off the automatic daily lists (lib/setupHealth, shared with
// GET /daily-lists/warnings).
router.get('/setup-health', authenticateToken, requireRole(...OPS_ROLES), async (req, res) => {
  const role = (req.user.role || '').toLowerCase();
  try {
    const { getSetupHealth, emptySetupHealth } = require('../lib/setupHealth');
    const zoneId = await resolveUserZoneId(req.user);
    if (role !== 'admin' && zoneId === null) return res.json({ data: { zone_id: null, ...emptySetupHealth() } });
    res.json({ data: { zone_id: zoneId, ...(await getSetupHealth(zoneId)) } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load setup checklist.', code: 'INTERNAL' } });
  }
});

module.exports = router;
