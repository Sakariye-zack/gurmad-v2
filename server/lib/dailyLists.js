// Daily lists ("Today's list"). Every morning (company-local time >= 05:00)
// each active Sub Zone (routes) with a collector gets one auto-generated batch
// per customer type (+ commercial shift) for the day:
//   - customers of the Sub Zone whose effective work days contain today's
//     local weekday (customer.work_days if non-empty overrides the Sub Zone's
//     routes.work_days), plus
//   - customers whose latest list entry on an earlier AUTO batch ended
//     'missed' (marked missed, or never visited) -> carried over, any weekday.
// Before generating, earlier auto batches still open are closed: untouched
// pending customers become 'missed' (status_reason 'not visited', status_at
// at the end of that list's own day so today's map/billing never sees them).
//
// The batches are ordinary batches (auto_generated = true) so everything that
// already reads batches/batch_customers — collector app, status marking,
// daily auto-billing, map 'today' status, tracking gate — works unchanged.
// Idempotent: an existing auto batch for (Sub Zone, type, shift, day) is
// never touched again (supervisor edits stick; a cancelled one is not
// recreated) and a partial unique index is the hard guard.
const { pool, logAudit } = require('../db');
const { getTimezone, localParts, shiftDate } = require('./autoBilling');
const { generateBatchCode, validateDr7ForCollector, validateResourceEligibility } = require('./collectionValidation');
const { toPoint, nearestNeighbourOrder } = require('./geo');

const ADVISORY_LOCK_KEY = 74120031;
const RUN_FROM_HOUR = 5;
const JS_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const OPEN_STATUSES = ['draft', 'assigned', 'in_progress', 'partially_completed'];

function weekdayOf(date) {
  return JS_DAYS[new Date(date + 'T00:00:00Z').getUTCDay()];
}

function monthBounds(date) {
  const [y, m] = date.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const pad = (n) => String(n).padStart(2, '0');
  return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(last)}` };
}

function daysArray(v) {
  return Array.isArray(v) ? v : [];
}

// Close every auto batch whose day is before `date` and that is still open.
async function closePrevious(client, date, tz) {
  const open = await client.query(
    `SELECT b.*, (SELECT COUNT(*)::int FROM batch_customers bc WHERE bc.batch_id = b.id AND bc.status = 'pending') AS pending
     FROM batches b
     WHERE b.auto_generated AND COALESCE(b.end_date, b.start_date) < $1::date AND b.status = ANY($2::text[])
     ORDER BY b.id FOR UPDATE OF b`, [date, OPEN_STATUSES]);
  const closed = [];
  for (const b of open.rows) {
    if (b.status === 'partially_completed' && b.pending === 0) continue;
    // Existing close-cycle rule: completed only when nothing was left pending.
    const newStatus = b.pending === 0 ? 'completed' : 'partially_completed';
    await client.query(
      `UPDATE batch_customers SET status = 'missed', status_reason = 'not visited',
         status_at = ((COALESCE($2::date, $3::date) + TIME '23:59:59') AT TIME ZONE $4) AT TIME ZONE 'UTC'
       WHERE batch_id = $1 AND status = 'pending'`, [b.id, b.end_date, b.start_date, tz]);
    const upd = await client.query(
      `UPDATE batches SET status = $1::varchar, completed_at = CASE WHEN $1::varchar = 'completed' THEN NOW() ELSE completed_at END,
         updated_at = NOW(), auto_closed_at = COALESCE(auto_closed_at, NOW()) WHERE id = $2 RETURNING *`, [newStatus, b.id]);
    await client.query(`UPDATE tasks SET status = 'completed', completed_at = COALESCE(completed_at, NOW()) WHERE batch_id = $1 AND status <> 'completed'`, [b.id]);
    const { pending, ...before } = b;
    closed.push({ before, after: upd.rows[0], not_visited: pending });
  }
  return closed;
}

async function ensureAutoCycle(client, zoneId, date, createdBy) {
  const { start, end } = monthBounds(date);
  const ex = await client.query(`SELECT id FROM collection_cycles WHERE auto AND zone_id = $1 AND start_date = $2::date ORDER BY id LIMIT 1`, [zoneId, start]);
  if (ex.rows[0]) return ex.rows[0].id;
  const ins = await client.query(
    `INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date, auto, created_by) VALUES ($1, 'monthly', $2, $3, TRUE, $4) RETURNING id`,
    [zoneId, start, end, createdBy]);
  return ins.rows[0].id;
}

// Route order ("next house"): nearest-neighbour over the list's customers,
// starting from the Sub Zone's start point (routes.start_lat/lng), else the
// list collector's last known location, else the first located customer by
// id. Customers without a location go last, by id. Writes
// batch_customers.visit_order 1..n. Used at generation time and by the
// supervisor "Re-order" action — one implementation.
async function computeVisitOrder(client, batchId) {
  const rows = (await client.query(
    `SELECT bc.id, c.lat, c.lng FROM batch_customers bc JOIN customers c ON c.id = bc.customer_id WHERE bc.batch_id = $1 ORDER BY bc.id`,
    [batchId])).rows;
  if (rows.length === 0) return [];
  const startRow = (await client.query(
    `SELECT r.start_lat, r.start_lng, cl.lat AS col_lat, cl.lng AS col_lng
     FROM batches b
     LEFT JOIN routes r ON r.id = b.route_id
     LEFT JOIN LATERAL (
       SELECT l.lat, l.lng FROM tasks t JOIN task_resources tr ON tr.task_id = t.id AND tr.resource_type = 'collector'
       JOIN collector_locations l ON l.employee_id = tr.resource_id
       WHERE t.batch_id = b.id ORDER BY tr.id LIMIT 1
     ) cl ON TRUE
     WHERE b.id = $1`, [batchId])).rows[0] || {};
  const start = toPoint(startRow.start_lat, startRow.start_lng) || toPoint(startRow.col_lat, startRow.col_lng);
  const order = nearestNeighbourOrder(rows, start);
  await client.query(
    `UPDATE batch_customers bc SET visit_order = o.ord FROM unnest($1::int[]) WITH ORDINALITY AS o(id, ord) WHERE bc.id = o.id`,
    [order]);
  return order;
}

async function generate(client, date, triggeredBy) {
  const weekday = weekdayOf(date);
  const skipped = [];
  const created = [];
  let customersAdded = 0;

  const routes = (await client.query(
    `SELECT r.id, r.code, r.name, r.group_id, r.collector_user_id, r.truck_id, r.work_days, g.zone_id, e.id AS employee_id
     FROM routes r JOIN groups g ON g.id = r.group_id
     LEFT JOIN LATERAL (SELECT id FROM employees WHERE user_id = r.collector_user_id AND status <> 'archived' ORDER BY id LIMIT 1) e ON TRUE
     WHERE r.status = 'active' AND g.status = 'active'
     ORDER BY r.id`)).rows;
  if (routes.length === 0) return { created, customersAdded, skipped };

  const custs = (await client.query(
    `SELECT c.id, c.customer_number, c.name, c.customer_type, COALESCE(c.commercial_shift, 'day') AS shift, c.route_id, c.zone_id, c.work_days,
            lm.status AS last_status, lm.auto_generated AS last_auto, lm.carry_resolved_at AS last_resolved, to_char(lm.carried_from, 'YYYY-MM-DD') AS carried_from
     FROM customers c
     LEFT JOIN LATERAL (
       SELECT bc.status, b.auto_generated, bc.carry_resolved_at, COALESCE(bc.carried_over_from, b.start_date) AS carried_from
       FROM batch_customers bc JOIN batches b ON b.id = bc.batch_id
       WHERE bc.customer_id = c.id AND b.status <> 'cancelled' AND b.start_date < $1::date
       ORDER BY b.start_date DESC, bc.id DESC LIMIT 1
     ) lm ON TRUE
     WHERE c.status = 'active' AND c.route_id = ANY($2::int[])
     ORDER BY c.id`, [date, routes.map((r) => r.id)])).rows;

  // Customers already on another non-cancelled batch for this day, or pending
  // anywhere (one_open_batch_per_customer), are left where they are.
  const busy = new Set((await client.query(
    `SELECT DISTINCT bc.customer_id FROM batch_customers bc JOIN batches b ON b.id = bc.batch_id
     WHERE b.status <> 'cancelled' AND (bc.status = 'pending'
       OR (b.start_date <= $1::date AND COALESCE(b.end_date, b.start_date) >= $1::date))`, [date])).rows.map((r) => r.customer_id));

  const byRoute = new Map();
  for (const c of custs) {
    if (!byRoute.has(c.route_id)) byRoute.set(c.route_id, []);
    byRoute.get(c.route_id).push(c);
  }

  for (const route of routes) {
    const list = byRoute.get(route.id) || [];
    const own = daysArray(route.work_days);
    const picked = [];
    for (const c of list) {
      const override = daysArray(c.work_days);
      const scheduled = (override.length ? override : own).includes(weekday);
      const carried = c.last_status === 'missed' && c.last_auto === true && !c.last_resolved;
      if (!scheduled && !carried) continue;
      picked.push({ ...c, carried_over_from: carried ? c.carried_from : null });
    }
    if (picked.length === 0) continue;
    if (!route.collector_user_id) { skipped.push({ route_id: route.id, route: route.name || route.code, reason: 'no_collector', customers: picked.length }); continue; }
    if (!route.employee_id) { skipped.push({ route_id: route.id, route: route.name || route.code, reason: 'collector_no_employee', customers: picked.length }); continue; }

    // DR-7: one customer type (+ shift) per batch.
    const groups = new Map();
    for (const c of picked) {
      const key = c.customer_type === 'commercial' ? `commercial:${c.shift}` : 'residential';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    for (const [key, members] of groups) {
      const [customerType, shift = null] = key.split(':');
      // Everything for one Sub Zone/type runs inside a savepoint: an error
      // here is reported and skipped, never aborting the whole run.
      await client.query('SAVEPOINT daily_batch');
      try {
        const exists = await client.query(
          `SELECT id FROM batches WHERE auto_generated AND route_id = $1 AND start_date = $2::date AND customer_type = $3 AND COALESCE(commercial_shift, '-') = COALESCE($4::varchar, '-') LIMIT 1`,
          [route.id, date, customerType, shift]);
        if (exists.rows[0]) { await client.query('RELEASE SAVEPOINT daily_batch'); continue; } // already generated (possibly edited / cancelled)
        const free = [];
        for (const c of members) {
          if (busy.has(c.id)) skipped.push({ route_id: route.id, customer_id: c.id, customer_number: c.customer_number, name: c.name, reason: 'already_on_batch' });
          else free.push(c);
        }
        if (free.length === 0) { await client.query('RELEASE SAVEPOINT daily_batch'); continue; }

        // DR-7: the Sub Zone's collector must match the list's type/shift.
        // A mismatch creates nothing (supervisor fixes the Sub Zone).
        const dr7 = await validateDr7ForCollector(route.employee_id, { customer_type: customerType, commercial_shift: shift });
        if (!dr7.ok) {
          skipped.push({ route_id: route.id, route: route.name || route.code, reason: 'collector_type_mismatch', customer_type: customerType, commercial_shift: shift, customers: free.length, message: dr7.error });
          await client.query('RELEASE SAVEPOINT daily_batch');
          continue;
        }
        const truckOk = route.truck_id ? (await validateResourceEligibility('truck', route.truck_id)).ok : false;

        const cycleId = await ensureAutoCycle(client, route.zone_id, date, triggeredBy);
        const { batchNumber, batchCode } = await generateBatchCode(client, route.zone_id, cycleId);
        const b = (await client.query(
          `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, customer_type, commercial_shift, start_date, end_date, total_customers, status,
             created_by, notes, group_id, route_id, auto_generated, assigned_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,$7::date,$8,'assigned',$9,$10,$11,$12,TRUE,NOW()) RETURNING *`,
          [batchCode, route.zone_id, cycleId, batchNumber, customerType, shift, date, free.length, triggeredBy,
            `Today's list ${date} (auto-generated)`, route.group_id, route.id])).rows[0];
        for (const c of free) {
          await client.query(`INSERT INTO batch_customers (batch_id, customer_id, status, carried_over_from) VALUES ($1, $2, 'pending', $3::date)`, [b.id, c.id, c.carried_over_from]);
        }
        const task = (await client.query(`INSERT INTO tasks (batch_id, status, scheduled_at) VALUES ($1, 'pending', $2::date) RETURNING id`, [b.id, date])).rows[0];
        const resources = [['collector', route.employee_id]];
        if (truckOk) resources.push(['truck', route.truck_id]);
        for (const [type, rid] of resources) {
          await client.query(`INSERT INTO task_resources (task_id, resource_type, resource_id, role_note) VALUES ($1,$2,$3,'daily list')`, [task.id, type, rid]);
          await client.query(`INSERT INTO task_resource_history (task_id, resource_type, resource_id, action, performed_by) VALUES ($1,$2,$3,'assigned',$4)`, [task.id, type, rid, triggeredBy]);
        }
        await computeVisitOrder(client, b.id);
        await client.query('RELEASE SAVEPOINT daily_batch');
        for (const c of free) busy.add(c.id);
        created.push(b);
        customersAdded += free.length;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT daily_batch');
        await client.query('RELEASE SAVEPOINT daily_batch');
        skipped.push({ route_id: route.id, route: route.name || route.code, reason: 'error: ' + String(err.message || err) });
      }
    }
  }
  return { created, customersAdded, skipped };
}

// One run for a local date: close earlier open auto lists, then generate.
// A daily_list_runs row is written only when informative (something changed,
// manual run, first run of that date, or an error) so hourly ticks stay quiet.
async function runForDate({ date, triggeredBy = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('runForDate needs a date (YYYY-MM-DD).');
  const tz = await getTimezone();
  const startedAt = new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY]);
    const closed = await closePrevious(client, date, tz);
    const gen = await generate(client, date, triggeredBy);
    await client.query('COMMIT');
    const actor = { actorId: triggeredBy, actorUsername: triggeredBy ? null : 'system' };
    for (const c of closed) {
      await logAudit({ ...actor, action: 'daily_list.auto_close', entityType: 'batch', entityId: c.after.id, before: c.before, after: { ...c.after, not_visited: c.not_visited } }).catch(() => {});
    }
    for (const b of gen.created) {
      await logAudit({ ...actor, action: 'daily_list.create', entityType: 'batch', entityId: b.id, before: null, after: b }).catch(() => {});
    }
    const result = { date, created_batches: gen.created.length, customers: gen.customersAdded, closed_batches: closed.length, skipped: gen.skipped };
    const first = (await pool.query(`SELECT 1 FROM daily_list_runs WHERE run_date = $1::date AND error IS NULL LIMIT 1`, [date])).rows.length === 0;
    let runId = null;
    if (result.created_batches > 0 || result.closed_batches > 0 || triggeredBy || first) {
      runId = (await pool.query(
        `INSERT INTO daily_list_runs (run_date, started_at, finished_at, created_batches, customers, closed_batches, skipped, triggered_by)
         VALUES ($1::date, $2, NOW(), $3, $4, $5, $6, $7) RETURNING id`,
        [date, startedAt, result.created_batches, result.customers, result.closed_batches, JSON.stringify(result.skipped), triggeredBy])).rows[0].id;
    }
    return { ...result, run_id: runId };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    try {
      const msg = String(err.message || err);
      const last = await pool.query(`SELECT error FROM daily_list_runs WHERE run_date = $1::date ORDER BY id DESC LIMIT 1`, [date]);
      if (triggeredBy || !(last.rows[0] && last.rows[0].error === msg)) {
        await pool.query(`INSERT INTO daily_list_runs (run_date, started_at, finished_at, error, triggered_by) VALUES ($1::date, $2, NOW(), $3, $4)`, [date, startedAt, msg, triggeredBy]);
      }
    } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function todayLocal(now = new Date()) {
  const tz = await getTimezone();
  return localParts(now, tz);
}

async function schedulerTick(now = new Date()) {
  const local = await todayLocal(now);
  if (local.hour < RUN_FROM_HOUR) return null;
  try {
    return await runForDate({ date: local.date });
  } catch (e) {
    console.error('daily lists run failed:', e.message);
    return null;
  }
}

function startScheduler() {
  if (process.env.DAILY_LISTS === 'off') return null;
  const safeTick = () => schedulerTick().catch((e) => console.error('daily lists tick failed:', e && e.message));
  const first = setTimeout(safeTick, 45 * 1000);
  const timer = setInterval(safeTick, 60 * 60 * 1000);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return { first, timer };
}

module.exports = { computeVisitOrder, runForDate, schedulerTick, startScheduler, weekdayOf, todayLocal, shiftDate, RUN_FROM_HOUR };
