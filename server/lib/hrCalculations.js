const { pool } = require('../db');

// Master Functional Completion Program — Phase 1: HR & Payroll.
// Shared helpers, mirroring reportsCalculations.js's own parameterized-
// function pattern (Spec §17/§23) — no calculation logic duplicated in
// any route file.

// Spec §15: reused from batches.js's own resolveEmployeeIdForUser
// pattern (Discovery-confirmed precedent) — resolves the authenticated
// user's own employee_id via the existing employees.user_id link. Never
// accepts a client-supplied employee_id for a /me route.
async function resolveEmployeeIdForRequestUser(user, client = pool) {
  const r = await client.query('SELECT id FROM employees WHERE user_id = $1', [user.id]);
  return r.rows[0]?.id ?? null;
}

// Spec §5 — mandatory architecture check. Derives an employee's
// effective status on read only: employees.status itself is NEVER
// written by the leave domain. No background worker, no scheduled job,
// no trigger.
async function getEffectiveEmployeeStatus(employeeId, client = pool) {
  const stored = await client.query('SELECT status FROM employees WHERE id = $1', [employeeId]);
  if (stored.rows.length === 0) return null;
  const active = await client.query(
    `SELECT 1 FROM leave_requests WHERE employee_id = $1 AND status = 'approved'
     AND CURRENT_DATE BETWEEN start_date AND end_date LIMIT 1`,
    [employeeId]
  );
  return active.rows.length > 0 ? 'on_leave' : stored.rows[0].status;
}

// ---------- HR/Payroll reports (Spec §17) — server-side aggregation only ----------

async function getHeadcountSummary({ zoneId = null } = {}, client = pool) {
  const params = [];
  let where = '';
  if (zoneId) { params.push(zoneId); where = `WHERE zone_id = $${params.length}`; }
  const res = await client.query(
    `SELECT status, COUNT(*) AS count FROM employees ${where} GROUP BY status ORDER BY status`,
    params
  );
  return res.rows;
}

async function getAttendanceSummary({ zoneId = null, periodStart, periodEnd } = {}, client = pool) {
  const params = [periodStart, periodEnd];
  let zoneClause = '';
  if (zoneId) { params.push(zoneId); zoneClause = `AND e.zone_id = $${params.length}`; }
  const res = await client.query(
    `SELECT ar.status, COUNT(*) AS count
     FROM attendance_records ar JOIN employees e ON ar.employee_id = e.id
     WHERE ar.attendance_date >= $1 AND ar.attendance_date <= $2 AND ar.corrected_from_id IS NULL ${zoneClause}
     GROUP BY ar.status ORDER BY ar.status`,
    params
  );
  return res.rows;
}

async function getLeaveSummary({ zoneId = null, periodStart, periodEnd } = {}, client = pool) {
  const params = [periodStart, periodEnd];
  let zoneClause = '';
  if (zoneId) { params.push(zoneId); zoneClause = `AND e.zone_id = $${params.length}`; }
  const res = await client.query(
    `SELECT lr.status, lt.label AS leave_type, COUNT(*) AS count
     FROM leave_requests lr
     JOIN employees e ON lr.employee_id = e.id
     JOIN leave_types lt ON lr.leave_type_id = lt.id
     WHERE lr.start_date <= $2 AND lr.end_date >= $1 ${zoneClause}
     GROUP BY lr.status, lt.label ORDER BY lt.label, lr.status`,
    params
  );
  return res.rows;
}

async function getPayrollSummary({ payrollPeriodId, zoneId = null } = {}, client = pool) {
  const params = [payrollPeriodId];
  let zoneClause = '';
  if (zoneId) { params.push(zoneId); zoneClause = `AND pr.zone_snapshot_id = $${params.length}`; }
  const res = await client.query(
    `SELECT COUNT(*) AS employee_count,
       COALESCE(SUM(salary_snapshot), 0) AS total_salary,
       COALESCE(SUM(earnings_total), 0) AS total_earnings,
       COALESCE(SUM(deductions_total), 0) AS total_deductions,
       COALESCE(SUM(net_salary), 0) AS total_net
     FROM payroll_records pr WHERE payroll_period_id = $1 ${zoneClause}`,
    params
  );
  return res.rows[0];
}

async function getPayrollByZone({ payrollPeriodId } = {}, client = pool) {
  const res = await client.query(
    `SELECT z.name AS zone_name, pr.zone_snapshot_id,
       COUNT(*) AS employee_count, COALESCE(SUM(pr.net_salary), 0) AS total_net
     FROM payroll_records pr LEFT JOIN zones z ON pr.zone_snapshot_id = z.id
     WHERE pr.payroll_period_id = $1
     GROUP BY z.name, pr.zone_snapshot_id ORDER BY z.name`,
    [payrollPeriodId]
  );
  return res.rows;
}

async function getPayrollHistory({ employeeId, limit = 50, offset = 0 } = {}, client = pool) {
  const res = await client.query(
    `SELECT pr.*, pp.label AS period_label, pp.start_date AS period_start, pp.end_date AS period_end
     FROM payroll_records pr JOIN payroll_periods pp ON pr.payroll_period_id = pp.id
     WHERE pr.employee_id = $1
     ORDER BY pp.start_date DESC LIMIT $2 OFFSET $3`,
    [employeeId, limit, offset]
  );
  return res.rows;
}

module.exports = {
  resolveEmployeeIdForRequestUser,
  getEffectiveEmployeeStatus,
  getHeadcountSummary,
  getAttendanceSummary,
  getLeaveSummary,
  getPayrollSummary,
  getPayrollByZone,
  getPayrollHistory,
};
