// F3 — Debt suspension (spec 2026-11-07-proof-route-debt-reports.md).
//
//  - Candidates: ACTIVE customers with at least one non-void invoice whose
//    outstanding balance is > EPSILON and whose company-local issue date
//    (invoices.created_at; invoices have no due date) is more than
//    company_settings.debt_suspend_days old. 0 days = feature off.
//  - Nothing is suspended automatically: an admin / gudoomiye approves.
//  - Approve: status 'suspended', suspended_reason 'debt', and the customer
//    is taken off every PENDING row of today's / future auto daily lists.
//  - Auto-reactivation: after a payment and in a nightly check, a customer
//    with suspended_reason 'debt' whose total outstanding (all invoices, each
//    currency) is <= EPSILON goes back to 'active'. Customers suspended for
//    any other reason are never touched here.
//
// Outstanding is the TRUE amount still owed, computed like
// paidInInvoiceCurrency(..., { excludeDebt: true }) in the invoice's own
// currency, set-based in SQL: a method='debt' payment moves money into a
// receivable, it is not money received, so it never counts as paid here.
const { pool, logAudit } = require('../db');
const { EPSILON } = require('./financialCalculations');
const { getTimezone, localParts } = require('./autoBilling');

const DEFAULT_DAYS = 90;
const DISMISS_DAYS = 30;
const SYSTEM_ACTOR = 'system';

// Per-invoice outstanding in the invoice's own currency. $1 = current
// exchange rate (numeric or NULL), used only for legacy SLSH-invoice payments
// that carry no frozen amount_invoice_currency — same rule as
// paidInInvoiceCurrency. Callers add their own WHERE on `i`.
const INVOICE_OUTSTANDING_SQL = `
  SELECT i.id, i.customer_id, CASE WHEN i.currency = 'SLSH' THEN 'SLSH' ELSE 'USD' END AS currency,
    i.created_at,
    (i.invoice_total - i.discount_amount) - COALESCE((
      SELECT SUM(CASE WHEN i.currency = 'SLSH'
                      THEN COALESCE(p.amount_invoice_currency,
                                    CASE WHEN p.currency = 'SLSH' THEN p.amount ELSE p.amount_usd * COALESCE(er.rate, $1::numeric) END)
                      ELSE p.amount_usd END)
      FROM payments p LEFT JOIN exchange_rates er ON er.id = p.exchange_rate_id
      WHERE p.invoice_id = i.id AND p.status = 'recorded' AND p.method <> 'debt'), 0) AS outstanding
  FROM invoices i
  WHERE i.status <> 'voided'`;

// "Group › District › Zone › Sub Zone" (same order as daily lists / invoices).
const PATH_SQL = `concat_ws(' › ', NULLIF(COALESCE(g.name, g.code), ''), NULLIF(z.name, ''), NULLIF(COALESCE(gz.name, gz.code), ''), NULLIF(COALESCE(r.name, r.code), ''))`;
const HIERARCHY_JOINS = `
  LEFT JOIN zones z ON z.id = c.zone_id
  LEFT JOIN groups g ON g.id = c.group_id
  LEFT JOIN routes r ON r.id = c.route_id
  LEFT JOIN group_zones gz ON gz.id = r.group_zone_id`;

async function currentRate(client = pool) {
  const r = await client.query(`SELECT rate FROM exchange_rates WHERE effective_from <= NOW() ORDER BY effective_from DESC LIMIT 1`);
  return r.rows[0] ? r.rows[0].rate : null;
}

async function getSuspendDays(client = pool) {
  const r = await client.query(`SELECT debt_suspend_days FROM company_settings WHERE id = 1`);
  const v = r.rows[0] ? Number(r.rows[0].debt_suspend_days) : DEFAULT_DAYS;
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_DAYS;
}

const num = (v) => (v === null || v === undefined ? 0 : Number(v));

// Candidates (optionally one district, optionally only some customer ids).
// Returns [] when the setting is 0.
async function listCandidates({ zoneId = null, customerIds = null, client = pool, now = new Date() } = {}) {
  const days = await getSuspendDays(client);
  if (days <= 0) return { days, rows: [] };
  const tz = await getTimezone();
  const today = localParts(now, tz).date;
  const rate = await currentRate(client);
  const params = [rate, tz, today, days, EPSILON];
  const where = [`c.status = 'active'`];
  let invFilter = '';
  if (zoneId !== null) { params.push(zoneId); where.push(`c.zone_id = $${params.length}`); }
  if (customerIds) { params.push(customerIds); invFilter = ` AND i.customer_id = ANY($${params.length}::int[])`; }
  const r = await client.query(`
    WITH inv AS (${INVOICE_OUTSTANDING_SQL}${invFilter}),
    open_inv AS (
      SELECT inv.*, (inv.created_at AT TIME ZONE 'UTC' AT TIME ZONE $2)::date AS issue_date
      FROM inv WHERE inv.outstanding > $5
    ),
    agg AS (
      SELECT customer_id,
        MIN(issue_date) AS oldest_unpaid,
        SUM(outstanding) FILTER (WHERE currency = 'USD') AS outstanding_usd,
        SUM(outstanding) FILTER (WHERE currency = 'SLSH') AS outstanding_slsh,
        COUNT(*)::int AS open_invoices
      FROM open_inv GROUP BY customer_id
    )
    SELECT c.id, c.customer_number, c.name, c.business_name, c.phone, c.zone_id, z.name AS zone_name,
      ${PATH_SQL} AS hierarchy,
      to_char(a.oldest_unpaid, 'YYYY-MM-DD') AS oldest_unpaid_date,
      ($3::date - a.oldest_unpaid) AS days,
      COALESCE(a.outstanding_usd, 0) AS outstanding_usd, COALESCE(a.outstanding_slsh, 0) AS outstanding_slsh,
      a.open_invoices
    FROM agg a JOIN customers c ON c.id = a.customer_id
    ${HIERARCHY_JOINS}
    WHERE ${where.join(' AND ')}
      AND ($3::date - a.oldest_unpaid) > $4::int
      AND NOT EXISTS (SELECT 1 FROM debt_suspension_dismissals d WHERE d.customer_id = c.id AND d.dismissed_until > NOW())
    ORDER BY days DESC, c.id`, params);
  return {
    days,
    rows: r.rows.map((x) => ({ ...x, days: Number(x.days), outstanding_usd: num(x.outstanding_usd), outstanding_slsh: num(x.outstanding_slsh) })),
  };
}

// Debts V2 (read-only): per customer, where they stand against the
// suspension rule — the same open-invoice / issue-date / setting logic as
// listCandidates, without the "already past the threshold" filter, so the
// Debts page can show "N days until suspension review". Returns
// { days, map: Map(customer_id -> { state, oldest_unpaid_date, days_open, days_left }) }
// state: 'suspended' | 'off' | 'none' (no open invoice) | 'review_due' | 'dismissed' | 'counting'.
async function suspensionInfo(customerIds, { client = pool, now = new Date() } = {}) {
  const map = new Map();
  const ids = [...new Set((customerIds || []).map(Number).filter(Number.isInteger))];
  const days = await getSuspendDays(client);
  if (!ids.length) return { days, map };
  const tz = await getTimezone();
  const today = localParts(now, tz).date;
  const rate = await currentRate(client);
  const r = await client.query(`
    WITH inv AS (${INVOICE_OUTSTANDING_SQL} AND i.customer_id = ANY($5::int[])),
    agg AS (
      SELECT customer_id, MIN((created_at AT TIME ZONE 'UTC' AT TIME ZONE $2)::date) AS oldest_unpaid
      FROM inv WHERE outstanding > $4 GROUP BY customer_id
    )
    SELECT c.id, c.status, c.suspended_reason, to_char(a.oldest_unpaid, 'YYYY-MM-DD') AS oldest_unpaid_date,
      ($3::date - a.oldest_unpaid) AS days_open,
      EXISTS (SELECT 1 FROM debt_suspension_dismissals d WHERE d.customer_id = c.id AND d.dismissed_until > NOW()) AS dismissed
    FROM customers c LEFT JOIN agg a ON a.customer_id = c.id
    WHERE c.id = ANY($5::int[])`, [rate, tz, today, EPSILON, ids]);
  for (const x of r.rows) {
    const daysOpen = x.days_open === null ? null : Number(x.days_open);
    let state;
    let daysLeft = null;
    if (x.status === 'suspended' && x.suspended_reason === 'debt') state = 'suspended';
    else if (days <= 0) state = 'off';
    else if (daysOpen === null) state = 'none';
    else {
      // listCandidates: candidate once days_open > setting.
      daysLeft = days + 1 - daysOpen;
      if (daysLeft <= 0) state = x.dismissed ? 'dismissed' : 'review_due';
      else state = 'counting';
    }
    map.set(x.id, { state, oldest_unpaid_date: x.oldest_unpaid_date, days_open: daysOpen, days_left: daysLeft });
  }
  return { days, map };
}

// Customers currently suspended for debt, with their outstanding.
async function listSuspended({ zoneId = null, client = pool } = {}) {
  const rate = await currentRate(client);
  const params = [rate, EPSILON];
  const where = [`c.status = 'suspended'`, `c.suspended_reason = 'debt'`];
  if (zoneId !== null) { params.push(zoneId); where.push(`c.zone_id = $${params.length}`); }
  const r = await client.query(`
    WITH inv AS (${INVOICE_OUTSTANDING_SQL}),
    agg AS (
      SELECT customer_id,
        SUM(outstanding) FILTER (WHERE currency = 'USD' AND outstanding > $2) AS outstanding_usd,
        SUM(outstanding) FILTER (WHERE currency = 'SLSH' AND outstanding > $2) AS outstanding_slsh
      FROM inv GROUP BY customer_id
    )
    SELECT c.id, c.customer_number, c.name, c.business_name, c.zone_id, z.name AS zone_name, ${PATH_SQL} AS hierarchy,
      c.suspended_at, c.suspended_by, u.username AS suspended_by_username,
      COALESCE(a.outstanding_usd, 0) AS outstanding_usd, COALESCE(a.outstanding_slsh, 0) AS outstanding_slsh
    FROM customers c
    ${HIERARCHY_JOINS}
    LEFT JOIN agg a ON a.customer_id = c.id
    LEFT JOIN v2_users u ON u.id = c.suspended_by
    WHERE ${where.join(' AND ')}
    ORDER BY c.suspended_at DESC NULLS LAST, c.id`, params);
  return r.rows.map((x) => ({ ...x, outstanding_usd: num(x.outstanding_usd), outstanding_slsh: num(x.outstanding_slsh) }));
}

// Total outstanding of one customer, per currency (all non-void invoices).
async function customerOutstanding(customerId, client = pool) {
  const rate = await currentRate(client);
  const r = await client.query(`
    WITH inv AS (${INVOICE_OUTSTANDING_SQL} AND i.customer_id = $2)
    SELECT COALESCE(SUM(outstanding) FILTER (WHERE currency = 'USD' AND outstanding > $3), 0) AS usd,
           COALESCE(SUM(outstanding) FILTER (WHERE currency = 'SLSH' AND outstanding > $3), 0) AS slsh
    FROM inv`, [rate, customerId, EPSILON]);
  return { USD: num(r.rows[0].usd), SLSH: num(r.rows[0].slsh) };
}

// Takes the customer off every PENDING row of the auto daily lists
// (non-cancelled): today's and future ones, and also past lists the morning
// run has not closed yet, so no stale row is later closed as 'missed' and
// carried over. batches.total_customers is kept in step, and any open
// carry-over from earlier auto-list misses is ended. Returns removed rows.
// A reactivated customer rejoins lists from the next daily generation.
async function removeFromPendingAutoLists(client, customerId) {
  const del = await client.query(
    `DELETE FROM batch_customers bc USING batches b
     WHERE bc.batch_id = b.id AND bc.customer_id = $1 AND bc.status = 'pending'
       AND b.auto_generated AND b.status <> 'cancelled'
     RETURNING bc.id, bc.batch_id`, [customerId]);
  for (const row of del.rows) {
    await client.query('UPDATE batches SET total_customers = GREATEST(total_customers - 1, 0), updated_at = NOW() WHERE id = $1', [row.batch_id]);
  }
  await client.query(
    `UPDATE batch_customers x SET carry_resolved_at = NOW() FROM batches pb
     WHERE x.batch_id = pb.id AND x.customer_id = $1 AND pb.auto_generated
       AND x.status = 'missed' AND x.carry_resolved_at IS NULL`, [customerId]);
  return del.rows;
}

// Approve suspension for the given customers. Each is re-checked as a
// current candidate inside the transaction (row-locked); non-candidates are
// returned in `skipped`. zoneId restricts a scoped approver to their district.
async function approve(customerIds, user, { zoneId = null } = {}) {
  const ids = [...new Set(customerIds)];
  const approved = [];
  const skipped = [];
  for (const id of ids) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = (await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!cur) { await client.query('ROLLBACK'); skipped.push({ customer_id: id, reason: 'not_found' }); continue; }
      if (zoneId !== null && cur.zone_id !== zoneId) { await client.query('ROLLBACK'); skipped.push({ customer_id: id, reason: 'forbidden' }); continue; }
      const cand = (await listCandidates({ customerIds: [id], client })).rows[0];
      if (!cand) { await client.query('ROLLBACK'); skipped.push({ customer_id: id, reason: 'not_a_candidate' }); continue; }
      const upd = await client.query(
        `UPDATE customers SET status = 'suspended', suspended_reason = 'debt', suspended_at = (NOW() AT TIME ZONE 'UTC'), suspended_by = $2, updated_at = NOW()
         WHERE id = $1 RETURNING *`, [id, user.id]);
      const removed = await removeFromPendingAutoLists(client, id);
      await client.query('DELETE FROM debt_suspension_dismissals WHERE customer_id = $1', [id]);
      await client.query('COMMIT');
      await logAudit({
        actorId: user.id, actorUsername: user.username, action: 'customer.debt_suspend', entityType: 'customer', entityId: id,
        before: { status: cur.status, suspended_reason: cur.suspended_reason },
        after: { status: 'suspended', suspended_reason: 'debt', oldest_unpaid_date: cand.oldest_unpaid_date, days: cand.days,
          outstanding_usd: cand.outstanding_usd, outstanding_slsh: cand.outstanding_slsh, removed_list_rows: removed.map((r) => r.id) },
      });
      approved.push({ ...upd.rows[0], removed_list_rows: removed.length });
    } catch (e) {
      // One customer's failure never blocks the rest of a bulk approval:
      // each id runs in its own transaction, rolled back on error.
      await client.query('ROLLBACK').catch(() => {});
      console.error('debt suspension approve failed for customer', id, e && e.message);
      skipped.push({ customer_id: id, reason: 'error' });
    } finally {
      client.release();
    }
  }
  return { approved, skipped };
}

// Snooze candidates for DISMISS_DAYS.
async function dismiss(customerIds, user, { zoneId = null } = {}) {
  const ids = [...new Set(customerIds)];
  const params = [ids];
  let zoneClause = '';
  if (zoneId !== null) { params.push(zoneId); zoneClause = ` AND zone_id = $${params.length}`; }
  const ok = (await pool.query(`SELECT id FROM customers WHERE id = ANY($1::int[])${zoneClause}`, params)).rows.map((r) => r.id);
  for (const id of ok) {
    const r = await pool.query(
      `INSERT INTO debt_suspension_dismissals (customer_id, dismissed_until, dismissed_by, dismissed_at)
       VALUES ($1, NOW() + ($2::int * INTERVAL '1 day'), $3, NOW())
       ON CONFLICT (customer_id) DO UPDATE SET dismissed_until = EXCLUDED.dismissed_until, dismissed_by = EXCLUDED.dismissed_by, dismissed_at = NOW()
       RETURNING dismissed_until`, [id, DISMISS_DAYS, user.id]);
    await logAudit({ actorId: user.id, actorUsername: user.username, action: 'customer.debt_dismiss', entityType: 'customer', entityId: id,
      before: null, after: { dismissed_until: r.rows[0].dismissed_until } });
  }
  return { dismissed: ok, skipped: ids.filter((id) => !ok.includes(id)) };
}

// Reactivate a debt-suspended customer once nothing is owed. Never touches a
// customer suspended for any other reason. Audited as system. Returns true
// when the customer was reactivated.
async function reactivateIfCleared(customerId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT id, status, suspended_reason, suspended_at FROM customers WHERE id = $1 FOR UPDATE', [customerId])).rows[0];
    if (!cur || cur.status !== 'suspended' || cur.suspended_reason !== 'debt') { await client.query('ROLLBACK'); return false; }
    const out = await customerOutstanding(customerId, client);
    if (out.USD > EPSILON || out.SLSH > EPSILON) { await client.query('ROLLBACK'); return false; }
    await client.query(
      `UPDATE customers SET status = 'active', suspended_reason = NULL, suspended_at = NULL, suspended_by = NULL, updated_at = NOW() WHERE id = $1`,
      [customerId]);
    await client.query('COMMIT');
    await logAudit({ actorId: null, actorUsername: SYSTEM_ACTOR, action: 'customer.debt_reactivate', entityType: 'customer', entityId: customerId,
      before: { status: 'suspended', suspended_reason: 'debt', suspended_at: cur.suspended_at }, after: { status: 'active', suspended_reason: null } });
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Best-effort hook for callers that just committed a payment: never throws.
async function afterPayment(customerId) {
  try { return await reactivateIfCleared(customerId); } catch (e) {
    console.error('debt reactivation check failed:', e && e.message);
    return false;
  }
}

// Nightly sweep over every debt-suspended customer.
async function nightlyCheck() {
  const r = await pool.query(`SELECT id FROM customers WHERE status = 'suspended' AND suspended_reason = 'debt' ORDER BY id`);
  const reactivated = [];
  for (const row of r.rows) {
    if (await afterPayment(row.id)) reactivated.push(row.id);
  }
  return { checked: r.rows.length, reactivated };
}

// Hourly tick; the sweep runs once per company-local day from 01:00.
const RUN_FROM_HOUR = 1;
let lastRunDate = null;
async function schedulerTick(now = new Date()) {
  const local = localParts(now, await getTimezone());
  if (local.hour < RUN_FROM_HOUR || lastRunDate === local.date) return null;
  lastRunDate = local.date;
  return nightlyCheck();
}

function startMonitor() {
  if (process.env.DEBT_MONITOR === 'off') return null;
  const safe = () => schedulerTick().catch((e) => console.error('debt monitor tick failed:', e && e.message));
  const first = setTimeout(safe, 90 * 1000);
  const timer = setInterval(safe, 60 * 60 * 1000);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return { first, timer };
}

// Dashboard Today panel: number of current candidates (zone-scoped).
async function countDebtCandidates({ zoneId = null } = {}) {
  const r = await listCandidates({ zoneId });
  return r.rows.length;
}

module.exports = {
  countDebtCandidates, listCandidates, listSuspended, suspensionInfo, customerOutstanding, approve, dismiss, reactivateIfCleared, afterPayment,
  nightlyCheck, schedulerTick, startMonitor, removeFromPendingAutoLists, getSuspendDays, DEFAULT_DAYS, DISMISS_DAYS,
};
