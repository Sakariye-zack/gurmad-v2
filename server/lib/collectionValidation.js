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

// ---------- Truck Capacity (Module 5 final review, additional requirement) ----------
//
// LOAD-CALCULATION SOURCE — grounded, not invented: the CURRENT system
// already has this exact feature (`checkResourceCapacity`, server/index.js
// ~line 3396), referenced against a "P0-T2 Design Spec (Rev 1)" (the spec
// document itself is not present in the repo, but its behavior is fully
// readable from the shipped code, which is the authoritative source used
// here). It establishes, in production, right now:
//   - The unit is a COUNT OF CUSTOMERS assigned to the resource — not kg,
//     bags, bins, or any physical volume/weight unit. No such field exists
//     anywhere in the customer/collection data model (checked directly:
//     neither the current system's schema nor V2's own customers table has
//     any quantity/weight/volume/container field).
//   - `trucks.capacity` (already a real V2 column) IS that threshold,
//     already in the same "count of customers" unit.
//   - Below capacity or capacity unset: allowed. At/above capacity (only
//     when a capacity number is actually configured): blocked.
// V2 SCOPE ADAPTATION (disclosed): the current system scopes load to
// "today" (`t.scheduled_at::date = CURRENT_DATE`) across every task a
// resource touches, because a truck's real constraint is same-day capacity
// across potentially many batches. V2's actual data model doesn't yet have
// per-day multi-batch truck scheduling — this checkpoint scopes load to
// "customers currently in THIS batch" (a truck attached to a batch's task
// is being asked to carry that batch's customers), which is the unit the
// user's own capacity requirement describes ("Batch load", "Batch
// Capacity"). This is a scope adaptation to V2's current data shape, not a
// reinterpretation of the unit itself.
// "Near Capacity" threshold: NO business rule defines one anywhere in the
// approved V2 documentation or the current system's own Design Spec
// reference. Hoisted here as the ONE place this number is defined (never
// duplicated in the frontend — the frontend only ever reads the `status`
// string this function returns, plus `nearCapacityThresholdPercent` for
// display, never re-deriving the threshold itself) — per the explicit
// instruction not to hardcode it in multiple places, and to treat it as
// provisional/configurable, not an irreversible business rule, until a
// real operational decision sets it. "Over Capacity" is NOT provisional —
// load > capacity, the capacity number itself is the authoritative limit.
const NEAR_CAPACITY_THRESHOLD = 0.9; // 90% — PROVISIONAL, see comment above.

async function computeBatchCapacity(batchId, client = pool) {
  const batchRes = await client.query('SELECT id FROM batches WHERE id = $1', [batchId]);
  if (batchRes.rows.length === 0) return null;

  const truckRes = await client.query(
    `SELECT t.id AS truck_id, t.capacity FROM task_resources tr
     JOIN tasks tk ON tk.id = tr.task_id
     JOIN trucks t ON t.id = tr.resource_id
     WHERE tk.batch_id = $1 AND tr.resource_type = 'truck' LIMIT 1`,
    [batchId]
  );
  if (truckRes.rows.length === 0) {
    return { truckId: null, capacity: null, load: null, remaining: null, utilizationPercent: null, status: 'no_truck' };
  }
  const { truck_id: truckId, capacity } = truckRes.rows[0];

  // Load = customers currently this batch's responsibility — every
  // batch_customers row except ones that have been rescheduled OUT (their
  // load moved to the target batch, which gets its own count via its own
  // total_customers increment).
  const loadRes = await client.query(`SELECT COUNT(*)::int AS load FROM batch_customers WHERE batch_id = $1 AND status != 'rescheduled'`, [batchId]);
  const load = loadRes.rows[0].load;

  if (capacity == null) {
    return { truckId, capacity: null, load, remaining: null, utilizationPercent: null, status: 'not_configured' };
  }
  const remaining = capacity - load;
  const utilizationPercent = capacity > 0 ? Math.round((load / capacity) * 1000) / 10 : null;
  let status = 'within';
  if (load > capacity) status = 'over';
  else if (capacity > 0 && load / capacity >= NEAR_CAPACITY_THRESHOLD) status = 'near';
  return { truckId, capacity, load, remaining, utilizationPercent, status, nearCapacityThresholdPercent: NEAR_CAPACITY_THRESHOLD * 100 };
}

// Called before any operation that would ADD customers to a batch that
// already has a truck attached (batch creation with customer_ids, and
// reschedule-into-an-existing-batch — the only two "add a customer to a
// batch" pathways that exist in V2 today; there is no separate "add more
// customers to an already-created batch" endpoint, disclosed in the
// completion report, not silently assumed away).
async function assertCapacityForAddition(batchId, additionalCount, client = pool) {
  const capacity = await computeBatchCapacity(batchId, client);
  if (!capacity || capacity.status === 'no_truck' || capacity.status === 'not_configured') {
    return { ok: true, capacity }; // no reliable comparison possible — allowed, per instruction
  }
  const projectedLoad = capacity.load + additionalCount;
  if (projectedLoad > capacity.capacity) {
    return {
      ok: false, code: 'CAPACITY_EXCEEDED', capacity,
      error: `Truck capacity exceeded. Capacity: ${capacity.capacity}. Required: ${projectedLoad}.`,
    };
  }
  return { ok: true, capacity };
}

// Called when a truck is newly assigned/changed on a task within a batch —
// the batch's current load must not already exceed the NEW truck's
// capacity.
async function assertCapacityForTruckAssignment(batchId, truckId, client = pool) {
  const truckRes = await client.query('SELECT capacity FROM trucks WHERE id = $1', [truckId]);
  const capacity = truckRes.rows[0]?.capacity;
  if (capacity == null) return { ok: true };
  const loadRes = await client.query(`SELECT COUNT(*)::int AS load FROM batch_customers WHERE batch_id = $1 AND status != 'rescheduled'`, [batchId]);
  const load = loadRes.rows[0].load;
  if (load > capacity) {
    return { ok: false, code: 'CAPACITY_EXCEEDED', error: `Truck capacity exceeded. Capacity: ${capacity}. Required: ${load}.` };
  }
  return { ok: true };
}

module.exports = {
  validateResourceAssignment, validateDr7ForCollector, validateResourceEligibility,
  computeBatchCapacity, assertCapacityForAddition, assertCapacityForTruckAssignment,
};
