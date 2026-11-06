const { pool } = require('../db');

// Live trucks — collector_location_history. One row per accepted
// POST /v2/collection-sync/location ping (the write-side eligibility gate
// lives in that route). Kept for 3 days only: enough for "route today" on
// the Map plus a little slack around midnight, never a long-term movement
// archive. Pruning is a cheap indexed DELETE run at most once an hour from
// the ping path itself (no separate scheduler to keep alive).
const RETENTION_DAYS = 3;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

async function pruneLocationHistory({ force = false, now = Date.now() } = {}) {
  if (!force && now - lastPruneAt < PRUNE_EVERY_MS) return null;
  lastPruneAt = now;
  const r = await pool.query(
    `DELETE FROM collector_location_history WHERE recorded_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`
  );
  return r.rowCount;
}

async function recordLocationHistory(employeeId, lat, lng) {
  await pool.query(
    'INSERT INTO collector_location_history (employee_id, lat, lng) VALUES ($1, $2, $3)',
    [employeeId, lat, lng]
  );
  // Never let housekeeping fail the ping itself.
  pruneLocationHistory().catch(() => {});
}

// "Working today" — the single rule for tracking (ping gate) and for what
// the live map reports (truck, progress, batch list, district scope): the
// collector is on a task that is not completed, of an assigned/in_progress
// batch whose date window contains today's company-local date. Expects
// aliases trc (task_resources), tk (tasks), b (batches); empExpr/todayExpr
// are SQL expressions (e.g. '$1', '$2::date').
function activeWorkWhere(empExpr, todayExpr) {
  return `trc.resource_type = 'collector' AND trc.resource_id = ${empExpr}
         AND b.status IN ('assigned', 'in_progress') AND tk.status <> 'completed'
         AND b.start_date <= ${todayExpr} AND (b.end_date IS NULL OR b.end_date >= ${todayExpr})`;
}
const ACTIVE_WORK_FROM = `task_resources trc
         JOIN tasks tk ON tk.id = trc.task_id
         JOIN batches b ON b.id = tk.batch_id`;

module.exports = { recordLocationHistory, pruneLocationHistory, activeWorkWhere, ACTIVE_WORK_FROM, RETENTION_DAYS };
