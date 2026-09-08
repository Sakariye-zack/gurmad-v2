const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  getHeadcountSummary, getAttendanceSummary, getLeaveSummary,
  getPayrollSummary, getPayrollByZone, getPayrollHistory,
} = require('../lib/hrCalculations');

const router = express.Router();

// Phase 1 HR & Payroll — Spec §17/§19. Thin routes only, zero
// calculation logic here — matches reports.js's own discipline exactly.
// No modification to reports.js/reportsCalculations.js anywhere.
const OPERATIONAL_ROLES = ['admin', 'gudoomiye', 'zone_accountant'];
const PAYROLL_SUMMARY_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'];
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];

function parseStrictId(raw) {
  if (!/^\d+$/.test(String(raw ?? ''))) return null;
  return parseInt(raw, 10);
}

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

router.get('/headcount', authenticateToken, requireRole(...OPERATIONAL_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    res.json({ data: await getHeadcountSummary({ zoneId: myZoneId }) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load headcount summary.', code: 'INTERNAL' } });
  }
});

router.get('/attendance-summary', authenticateToken, requireRole(...OPERATIONAL_ROLES), async (req, res) => {
  const { period_start, period_end } = req.query;
  if (!period_start || !period_end) return res.status(400).json({ error: { message: 'period_start and period_end are required.', code: 'VALIDATION' } });
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    res.json({ data: await getAttendanceSummary({ zoneId: myZoneId, periodStart: period_start, periodEnd: period_end }) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load attendance summary.', code: 'INTERNAL' } });
  }
});

router.get('/leave-summary', authenticateToken, requireRole(...OPERATIONAL_ROLES), async (req, res) => {
  const { period_start, period_end } = req.query;
  if (!period_start || !period_end) return res.status(400).json({ error: { message: 'period_start and period_end are required.', code: 'VALIDATION' } });
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    res.json({ data: await getLeaveSummary({ zoneId: myZoneId, periodStart: period_start, periodEnd: period_end }) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load leave summary.', code: 'INTERNAL' } });
  }
});

router.get('/payroll-summary', authenticateToken, requireRole(...PAYROLL_SUMMARY_ROLES), async (req, res) => {
  const payrollPeriodId = parseStrictId(req.query.payroll_period_id);
  if (payrollPeriodId === null) return res.status(400).json({ error: { message: 'payroll_period_id is required.', code: 'VALIDATION' } });
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    res.json({ data: await getPayrollSummary({ payrollPeriodId, zoneId: myZoneId }) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load payroll summary.', code: 'INTERNAL' } });
  }
});

router.get('/payroll-by-zone', authenticateToken, requireRole('admin'), async (req, res) => {
  const payrollPeriodId = parseStrictId(req.query.payroll_period_id);
  if (payrollPeriodId === null) return res.status(400).json({ error: { message: 'payroll_period_id is required.', code: 'VALIDATION' } });
  try {
    res.json({ data: await getPayrollByZone({ payrollPeriodId }) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load payroll by zone.', code: 'INTERNAL' } });
  }
});

router.get('/payroll-history', authenticateToken, requireRole(...OPERATIONAL_ROLES), async (req, res) => {
  const employeeId = parseStrictId(req.query.employee_id);
  if (employeeId === null) return res.status(400).json({ error: { message: 'employee_id is required.', code: 'VALIDATION' } });
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    res.json({ data: await getPayrollHistory({ employeeId, limit, offset }) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load payroll history.', code: 'INTERNAL' } });
  }
});

module.exports = router;
