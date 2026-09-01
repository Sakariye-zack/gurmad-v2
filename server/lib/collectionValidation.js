const { pool } = require('../db');

// Shared by assignment-time AND task-start-time validation (OD-4, approved:
// enforce DR-7 at both points) — one implementation, not two copies that
// could drift apart.
//
// DR-7 approved rules (Decision_Register.md, verbatim, not re-derived):
// 1. Residential Collector -> Residential customers/tasks only.
// 2/3. Commercial Collector - Day/Night -> Commercial customers/tasks only,
//      matching shift only.
// 4. A Commercial Collector must never be assigned to a Residential task.
// 5. A Residential Collector must never be assigned to a Commercial task.
// 6/7. Day/Night Commercial Collector must not receive the other shift's
//      tasks.
// A batch is either all-Residential or all-Commercial+shift (batches.
// customer_type/commercial_shift) — DR-7's own approved design describes
// this as the operation-level classification a collector's employee record
// is checked against.
async function validateDr7ForCollector(employeeId, batch) {
  const r = await pool.query('SELECT id, employee_type, collector_type, commercial_shift, status FROM employees WHERE id = $1', [employeeId]);
  if (r.rows.length === 0) return { ok: false, code: 'NOT_FOUND', error: `Employee #${employeeId} does not exist.` };
  const emp = r.rows[0];
  if (emp.employee_type !== 'collector') {
    return { ok: false, code: 'VALIDATION', error: `Employee #${employeeId} is not a collector.` };
  }
  if (emp.status === 'archived') {
    return { ok: false, code: 'INELIGIBLE', error: `Employee #${employeeId} is archived and not eligible for assignment.` };
  }

  if (batch.customer_type === 'residential') {
    if (emp.collector_type === 'commercial') {
      return { ok: false, code: 'DR7_BLOCK', error: `Assignment blocked: a Commercial Collector cannot be assigned to a Residential task (DR-7 rule 4).` };
    }
  } else if (batch.customer_type === 'commercial') {
    if (emp.collector_type !== 'commercial') {
      return { ok: false, code: 'DR7_BLOCK', error: `Assignment blocked: a Residential Collector cannot be assigned to a Commercial task (DR-7 rule 5).` };
    }
    if (emp.commercial_shift !== batch.commercial_shift) {
      return {
        ok: false, code: 'DR7_BLOCK',
        error: `Assignment blocked: a Commercial ${emp.commercial_shift === 'day' ? 'Day' : 'Night'} Collector cannot be assigned to a ${batch.commercial_shift === 'day' ? 'Day' : 'Night'} commercial task (DR-7 rule ${emp.commercial_shift === 'day' ? '6' : '7'}).`,
      };
    }
  }
  return { ok: true };
}

// Eligibility (existence + not archived/retired) for driver/truck/cashier —
// distinct from DR-7 (which only governs collectors), per the explicit
// instruction to validate "referenced resource eligibility" for every
// resource type, not just collectors.
async function validateResourceEligibility(resourceType, resourceId) {
  if (resourceType === 'driver') {
    const r = await pool.query('SELECT id, employee_type, status FROM employees WHERE id = $1', [resourceId]);
    if (r.rows.length === 0) return { ok: false, code: 'NOT_FOUND', error: `Employee #${resourceId} does not exist.` };
    if (r.rows[0].employee_type !== 'driver') return { ok: false, code: 'VALIDATION', error: `Employee #${resourceId} is not a driver.` };
    if (r.rows[0].status === 'archived') return { ok: false, code: 'INELIGIBLE', error: `Employee #${resourceId} is archived and not eligible for assignment.` };
    return { ok: true };
  }
  if (resourceType === 'truck') {
    const r = await pool.query('SELECT id, status FROM trucks WHERE id = $1', [resourceId]);
    if (r.rows.length === 0) return { ok: false, code: 'NOT_FOUND', error: `Truck #${resourceId} does not exist.` };
    if (r.rows[0].status === 'retired') return { ok: false, code: 'INELIGIBLE', error: `Truck #${resourceId} is Retired and not eligible for assignment.` };
    return { ok: true };
  }
  if (resourceType === 'cashier') {
    // users lives in the reference backend's own database (same limitation
    // as employees.user_id, see db.js) — existence cannot be verified
    // locally. Format-only validation, documented, not silently treated as
    // a verified reference.
    if (!Number.isInteger(resourceId) || resourceId <= 0) {
      return { ok: false, code: 'VALIDATION', error: 'cashier resource_id must be a positive integer.' };
    }
    return { ok: true };
  }
  return { ok: false, code: 'VALIDATION', error: `Unknown resource_type "${resourceType}".` };
}

// One entry point for both assignment-time and task-start-time callers.
async function validateResourceAssignment(resourceType, resourceId, batch) {
  if (!['collector', 'driver', 'truck', 'cashier'].includes(resourceType)) {
    return { ok: false, code: 'VALIDATION', error: `resource_type must be one of: collector, driver, truck, cashier.` };
  }
  if (!Number.isInteger(resourceId) || resourceId <= 0) {
    return { ok: false, code: 'VALIDATION', error: 'resource_id must be a positive integer.' };
  }
  if (resourceType === 'collector') {
    return validateDr7ForCollector(resourceId, batch);
  }
  return validateResourceEligibility(resourceType, resourceId);
}

module.exports = { validateResourceAssignment, validateDr7ForCollector, validateResourceEligibility };
