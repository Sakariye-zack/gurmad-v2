// Cashout V2 — hourly overdue alerts.
//  1. a cashout still pending more than 24 h after it was created;
//  2. a staff member holding payments not covered by any live cashout whose
//     oldest is more than 2 days old.
// Recipients: active admins + active heads of cashiers. Each item alerts at
// most once per company-local day (cashout_alerts_sent), so the hourly tick
// never spams. Disabled with CASHOUT_MONITOR=off (the test suite drives
// checkOnce itself and unit-tests planCashoutAlerts).
const { pool } = require('../db');
const { createStaffNotification, logNotificationFailure } = require('./staffNotifications');
const { listUncoveredPayments, planCashoutAlerts, PENDING_OVERDUE_HOURS } = require('./cashoutCalculations');
const { getTimezone, localParts } = require('./autoBilling');

async function recipients(client = pool) {
  const r = await client.query(`SELECT id FROM v2_users WHERE is_active = TRUE AND role IN ('admin', 'head_of_cashiers') ORDER BY id`);
  return r.rows.map((x) => x.id);
}

async function claim(alert, today, client = pool) {
  const r = await client.query(
    `INSERT INTO cashout_alerts_sent (kind, ref_id, for_date) VALUES ($1, $2, $3)
     ON CONFLICT (kind, ref_id, for_date) DO NOTHING RETURNING id`, [alert.kind, alert.ref_id, today]);
  return r.rows.length > 0;
}

async function release(alert, today, client = pool) {
  await client.query('DELETE FROM cashout_alerts_sent WHERE kind = $1 AND ref_id = $2 AND for_date = $3', [alert.kind, alert.ref_id, today]);
}

function payloadFor(alert) {
  if (alert.kind === 'pending_overdue') {
    return {
      eventType: 'cashout.pending_overdue', entityType: 'cashout', entityId: alert.ref_id,
      title: `Cashout ${alert.cashout_number} pending for ${alert.hours} h`,
      body: `Cashout ${alert.cashout_number} has been waiting for approval for more than ${PENDING_OVERDUE_HOURS} hours.`,
    };
  }
  return {
    eventType: 'cashout.uncovered_stale', entityType: 'cashier', entityId: alert.ref_id,
    title: `${alert.cashier_name}: payments not cashed out for ${alert.days} days`,
    body: `${alert.payment_count} recorded payment(s) by ${alert.cashier_name} are not covered by any cashout yet.`,
  };
}

// Returns { planned, sent }.
async function checkOnce(now = new Date()) {
  const today = localParts(now, await getTimezone()).date;
  const pending = (await pool.query(
    `SELECT id, cashout_number, created_at FROM cashouts WHERE status = 'pending' ORDER BY id`)).rows;
  const uncovered = await listUncoveredPayments();
  const sentRows = (await pool.query('SELECT kind, ref_id FROM cashout_alerts_sent WHERE for_date = $1', [today])).rows;
  const sentKeys = new Set(sentRows.map((r) => `${r.kind}:${r.ref_id}:${today}`));
  const plan = planCashoutAlerts({ pending, uncovered, sentKeys, now, today });
  const to = await recipients();
  let sent = 0;
  for (const alert of plan) {
    if (!(await claim(alert, today))) continue;
    let delivered = 0;
    for (const id of to) {
      try { await createStaffNotification({ recipientId: id, ...payloadFor(alert) }); delivered += 1; } catch (e) { logNotificationFailure(alert.kind, e); }
    }
    // Nothing delivered: free the slot so the next hourly run retries.
    if (to.length > 0 && delivered === 0) { await release(alert, today); continue; }
    sent += 1;
  }
  return { planned: plan.length, sent };
}

function startMonitor() {
  if (process.env.CASHOUT_MONITOR === 'off') return null;
  const safe = () => checkOnce().catch((e) => console.error('cashout monitor tick failed:', e && e.message));
  const first = setTimeout(safe, 2 * 60 * 1000);
  const timer = setInterval(safe, 60 * 60 * 1000);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return { first, timer };
}

module.exports = { checkOnce, startMonitor };
