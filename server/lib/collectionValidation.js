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

// ---------- Batch customer status transition (Offline/Sync CR — extraction) ----------
//
// Extracted, behavior-preserving, from the existing PUT
// /:id/customers/:customerId/status route in routes/batches.js. This is
// the canonical row-lock/state-transition logic for a batch_customer
// status change (serviced/missed/skipped) — the ONLY implementation of
// this rule anywhere in the codebase after this extraction.
//
// Transaction ownership: the CALLER owns pool.connect()/BEGIN/COMMIT/
// ROLLBACK/release() — this function issues its two queries (the row
// lock and the update) against the client it is given and never opens,
// commits, or rolls back a transaction itself, and never releases the
// client. This mirrors the existing assertCapacityForAddition(id, qty,
// client) convention already established in this same file.
//
// Audit: this function does NOT call logAudit() — the caller does, AFTER
// its own COMMIT, exactly matching the pre-extraction behavior (today,
// logAudit() runs after COMMIT, not before). This function returns
// {before, after} so the caller has what it needs for that call.
//
// DR-1 collector-ownership validation is NOT performed here — it stays
// in the calling route, BEFORE the transaction opens, exactly as today.
// This function assumes the caller has already authorized the request.
// Late marks on a closed daily list (see applyBatchCustomerStatusChange).
const AUTO_CLOSE_REASON = 'not visited';
const LATE_MARK_STATUSES = ['serviced', 'missed'];
function lateMarkUntilHour() {
  const h = Number(process.env.DAILY_LATE_MARK_UNTIL_HOUR);
  return Number.isFinite(h) && h > 0 && h <= 24 ? h : 12;
}

async function applyBatchCustomerStatusChange(client, { batchId, customerId, status, reason, note, lat, lng, capturedAt: capturedAtRaw, now = new Date(), lateUntilHour }) {
  if (!['serviced', 'missed', 'skipped'].includes(status)) {
    return { ok: false, code: 'VALIDATION', error: 'status must be one of: serviced, missed, skipped.' };
  }
  if (status === 'missed' && !reason) {
    return { ok: false, code: 'VALIDATION', error: 'A reason is required to mark a customer Missed.' };
  }

  const bcRes = await client.query('SELECT * FROM batch_customers WHERE batch_id = $1 AND customer_id = $2 FOR UPDATE', [batchId, customerId]);
  if (bcRes.rows.length === 0) {
    return { ok: false, code: 'NOT_FOUND', error: 'This customer is not in this batch.' };
  }
  const bc = bcRes.rows[0];
  if (bc.status === 'pending') {
    const updated = await client.query(
      `UPDATE batch_customers SET status = $1, status_reason = $2, status_note = $3, status_lat = $4, status_lng = $5, status_at = NOW()
       WHERE batch_id = $6 AND customer_id = $7 RETURNING *`,
      [status, reason || null, note || null, lat || null, lng || null, batchId, customerId]
    );
    return { ok: true, code: 'ACCEPTED', before: bc, after: updated.rows[0] };
  }

  // Late (offline) mark on YESTERDAY's daily list after the 05:00 run closed
  // it: a phone that captured the visit before the close may still sync it
  // until noon (DAILY_LATE_MARK_UNTIL_HOUR) today. Bounded on purpose — it
  // must never rewrite older history.
  const conflict = { ok: false, code: 'CONFLICT', error: `This customer is already ${bc.status} in this batch.`, currentStatus: bc.status };
  if (bc.status !== 'missed' || bc.status_reason !== AUTO_CLOSE_REASON) return conflict;
  const tz = await require('./autoBilling').getTimezone();
  const local = require('./autoBilling').localParts(now, tz);
  const yesterday = require('./autoBilling').shiftDate(local.date, -1);
  const b = (await client.query(
    `SELECT id, auto_generated, status, to_char(start_date, 'YYYY-MM-DD') AS day, auto_closed_at FROM batches WHERE id = $1 FOR UPDATE`, [batchId])).rows[0];
  if (!b || !b.auto_generated || !b.auto_closed_at || !['completed', 'partially_completed'].includes(b.status)) return conflict;
  if (b.day !== yesterday || local.hour >= (lateUntilHour || lateMarkUntilHour())) return conflict;
  if (!LATE_MARK_STATUSES.includes(status)) return conflict;

  // The visit must have been captured on the phone between the start of that
  // list's day and the moment the list was closed.
  const capMs = typeof capturedAtRaw === 'string' ? Date.parse(capturedAtRaw) : NaN;
  if (!Number.isFinite(capMs)) return { ok: false, code: 'VALIDATION', error: 'captured_at is required for a mark on a closed daily list.' };
  const bounds = (await client.query(
    `SELECT ($1::date::timestamp AT TIME ZONE $2) AS lo, $3::timestamptz AS hi`, [b.day, tz, b.auto_closed_at])).rows[0];
  if (capMs < new Date(bounds.lo).getTime() || capMs > new Date(bounds.hi).getTime()) {
    return { ok: false, code: 'VALIDATION', error: 'captured_at is outside that list\'s day.' };
  }
  const capturedAt = new Date(capMs).toISOString();

  // Lock the customer's rows on later auto lists before deciding, so a
  // concurrent mark on today's carried copy cannot slip in (no double visit/invoice).
  const later = await client.query(
    `SELECT x.id, x.batch_id, x.status, x.carried_over_from FROM batch_customers x JOIN batches b2 ON b2.id = x.batch_id
     WHERE x.customer_id = $1 AND b2.start_date > $2::date ORDER BY x.id FOR UPDATE OF x`, [customerId, b.day]);
  if (later.rows.some((r) => r.status === 'serviced')) {
    return { ok: false, code: 'CONFLICT', error: 'This customer was already serviced on a later list.', currentStatus: bc.status };
  }

  const updated = await client.query(
    `UPDATE batch_customers SET status = $1, status_reason = $2, status_note = $3, status_lat = $4, status_lng = $5,
       status_at = ($8::timestamptz AT TIME ZONE 'UTC')
     WHERE batch_id = $6 AND customer_id = $7 RETURNING *`,
    [status, reason || null, note || null, lat || null, lng || null, batchId, customerId, capturedAt]
  );
  if (status === 'serviced') {
    // Resolved: drop the still-pending carried copies on later auto lists
    // and stop later misses from carrying again.
    const autoLater = await client.query(
      `SELECT x.id, x.batch_id, x.status, x.carried_over_from, b2.auto_generated FROM batch_customers x JOIN batches b2 ON b2.id = x.batch_id
       WHERE x.id = ANY($1::int[])`, [later.rows.map((r) => r.id)]);
    for (const r of autoLater.rows) {
      if (!r.auto_generated) continue;
      if (r.status === 'pending' && r.carried_over_from) {
        await client.query('DELETE FROM batch_customers WHERE id = $1', [r.id]);
        await client.query('UPDATE batches SET total_customers = GREATEST(total_customers - 1, 0) WHERE id = $1', [r.batch_id]);
      } else if (r.status === 'missed') {
        await client.query('UPDATE batch_customers SET carry_resolved_at = NOW() WHERE id = $1 AND carry_resolved_at IS NULL', [r.id]);
      }
    }
  }
  // Re-apply the close rule to yesterday's list: completed once nothing is
  // left unvisited.
  const left = (await client.query(
    `SELECT COUNT(*)::int AS n FROM batch_customers WHERE batch_id = $1 AND status = 'missed' AND status_reason = $2`, [batchId, AUTO_CLOSE_REASON])).rows[0].n;
  await client.query(
    `UPDATE batches SET status = $1::varchar, completed_at = CASE WHEN $1::varchar = 'completed' THEN COALESCE(completed_at, NOW()) ELSE completed_at END WHERE id = $2`,
    [left === 0 ? 'completed' : 'partially_completed', batchId]);
  return { ok: true, code: 'ACCEPTED', before: bc, after: updated.rows[0], late: true };
}

// Next batch number/code within (zone, cycle). Shared by manual batch
// creation/reschedule (routes/batches.js) and the daily-list generator.
async function generateBatchCode(client, zoneId, cycleId) {
  const numRow = await client.query(`SELECT COALESCE(MAX(batch_number), 0) + 1 AS n FROM batches WHERE zone_id = $1 AND cycle_id = $2`, [zoneId, cycleId]);
  const batchNumber = numRow.rows[0].n;
  return { batchNumber, batchCode: `Z${zoneId}-C${cycleId}-B${batchNumber}` };
}

module.exports = {
  generateBatchCode,
  validateResourceAssignment, validateDr7ForCollector, validateResourceEligibility,
  computeBatchCapacity, assertCapacityForAddition, assertCapacityForTruckAssignment,
  applyBatchCustomerStatusChange,
};
