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

module.exports = { recordLocationHistory, pruneLocationHistory, RETENTION_DAYS };
