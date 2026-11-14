const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getInvoiceBalance, getCurrentExchangeRate, paidInInvoiceCurrency, EPSILON } = require('../lib/financialCalculations');
const { amountPrecisionError, PaymentError } = require('../lib/paymentRules');
const debtPayments = require('../lib/debtPayments');
const debtSuspension = require('../lib/debtSuspension');
const autoBilling = require('../lib/autoBilling');
const { toCsv } = require('../lib/csvImportExport'); // toCsv applies csvFormulaSafe to every cell
const { zaadStateFor } = require('../lib/zaadAttempts');
const paymentsRouter = require('./payments');

const router = express.Router();

// Debts V2. The debts REGISTER: receivables owed by customers, separate
// from invoice balances.
//  - AUTO debts (source 'auto_invoice') mirror the debt-marked / unpaid part
//    of one invoice and are kept in sync by routes/payments.js. Collecting
//    one = an invoice payment (recordPaymentCore, collectDebt mode).
//  - STANDALONE debts (invoice_id NULL) are collected with real payments on
//    the debt itself (lib/debtPayments.js) — they reach Transactions,
//    Cashout and revenue like any payment.
//  - MANUAL debts linked to an invoice (API-only legacy) are not collectable
//    here: take the payment on the invoice, then settle the debt.
// Every total below counts the debts register only — never invoice
// balances — and per currency, never mixed.

// 'cashier' added (user-reported live, Phase 10) — same gap/fix as
// invoices.js and payments.js: this file's own zone checks already
// existed, only the role list was missing 'cashier'.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'cashier'];
const VIEW_ROLES = ['admin', 'cashier', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'];
const CREATE_ROLES = ['admin', 'cashier', 'gudoomiye'];
const SETTLE_ROLES = ['admin', 'cashier'];
const COLLECT_ROLES = ['admin', 'cashier'];
const COLLECT_METHODS = ['cash', 'zaad', 'edahab', 'slsh'];
const FOLLOWUP_KINDS = ['call', 'visit', 'message', 'other'];
const STATES = ['open', 'unpaid', 'partial', 'paid', 'written_off'];
const AGE_BUCKETS = ['0_30', '31_60', '61_90', '90_plus', 'over_60'];
const PROMISE_STATES = ['due_today', 'broken', 'upcoming', 'none', 'any'];
const SORTS = { created_at: 'dv.created_at', age: 'dv.age_days', amount: null, customer: 'dv.customer_name', promise: 'dv.promise_date', status: 'dv.state' };
const CUSTOMER_SORTS = { oldest: 'oldest_age', customer: 'customer_name', count: 'debt_count', last_followup: 'last_followup_at', usd: 'usd', slsh: 'slsh' };
const CSV_MAX_ROWS = 20000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseStrictId(raw) {
  if (!/^\d+$/.test(raw)) return null;
  return parseInt(raw, 10);
}
const bad = (res, message, code = 'VALIDATION', status = 400) => res.status(status).json({ error: { message, code } });
const curOf = (c) => (c === 'SLSH' ? 'SLSH' : 'USD');
const validDate = (d) => DATE_RE.test(String(d)) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

// Zone scope for every read and write in this file. A zone-scoped role whose
// zone is missing or unresolvable sees / touches nothing (fail closed).
async function resolveScope(user) {
  const scoped = ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase());
  const zoneId = await resolveUserZoneId(user);
  return { zoneId, denied: scoped && zoneId === null };
}
async function customerInScope(scope, customerId) {
  if (scope.denied) return false;
  if (scope.zoneId === null) return true;
  const r = await pool.query('SELECT zone_id FROM customers WHERE id = $1', [customerId]);
  return !!r.rows[0] && r.rows[0].zone_id === scope.zoneId;
}

// ---------------------------------------------------------------------
// The debt view: one row per debt with every derived figure, computed in
// ONE place. $1 = company timezone, $2 = company-local today (YYYY-MM-DD).
//  - paid_amount: recorded payments on a STANDALONE debt (debt currency);
//    NULL for invoice-linked debts (their payments live on the invoice; an
//    auto debt's amount is itself the mirrored remaining).
//  - remaining: open debts only (0 once paid / written off).
//  - state: unpaid | partial (standalone, something paid) | paid |
//    written_off. An auto debt whose invoice was voided before Debts V2
//    closed such debts on void counts as written_off (invoice_voided).
//  - age_days: company-local days since the debt was created.
//  - promise: the latest follow-up promise for this debt (or a customer-
//    level one); broken = promise date before today on a still-open debt.
// ---------------------------------------------------------------------
function debtViewSql(scopeWhere) {
  return `WITH b AS (
    SELECT d.id, d.customer_id, d.invoice_id, d.amount, CASE WHEN d.currency = 'SLSH' THEN 'SLSH' ELSE 'USD' END AS currency,
      d.description, d.status, d.source, d.created_at, d.created_by, d.settled_at, d.settled_by, d.settlement_override_reason,
      d.written_off_at, d.written_off_by, d.written_off_reason, d.cashout_id, d.updated_at,
      c.name AS customer_name, c.business_name, c.customer_number AS customer_number_current,
      COALESCE(i.customer_number_snapshot, c.customer_number) AS customer_number,
      c.phone, c.whatsapp, c.alternate_phone, c.status AS customer_status, c.suspended_reason,
      c.zone_id, c.group_id, c.route_id, r.group_zone_id,
      z.name AS zone_name, g.code AS group_code, g.name AS group_name, gz.name AS group_zone_name, gz.code AS group_zone_code,
      r.name AS route_name, r.code AS route_code,
      i.invoice_number, i.status AS invoice_status,
      COALESCE(cu.full_name, cu.username) AS created_by_name,
      COALESCE(pp.paid, 0) AS standalone_paid, COALESCE(pp.n, 0) AS payment_count,
      (($2::text)::date - (d.created_at::timestamptz AT TIME ZONE $1)::date) AS age_days,
      pr.promise_date, pr.promise_amount, pr.promise_currency, lf.last_followup_at
    FROM debts d
    JOIN customers c ON c.id = d.customer_id
    LEFT JOIN invoices i ON i.id = d.invoice_id
    LEFT JOIN zones z ON z.id = c.zone_id
    LEFT JOIN groups g ON g.id = c.group_id
    LEFT JOIN routes r ON r.id = c.route_id
    LEFT JOIN group_zones gz ON gz.id = r.group_zone_id
    LEFT JOIN v2_users cu ON cu.id = d.created_by
    LEFT JOIN LATERAL (SELECT SUM(p.amount_debt_currency) AS paid, COUNT(*)::int AS n FROM payments p
                       WHERE p.debt_id = d.id AND p.status = 'recorded') pp ON TRUE
    LEFT JOIN LATERAL (SELECT f.promise_date, f.promise_amount, f.promise_currency FROM debt_followups f
                       WHERE f.promise_date IS NOT NULL AND (f.debt_id = d.id OR (f.debt_id IS NULL AND f.customer_id = d.customer_id))
                       ORDER BY f.created_at DESC, f.id DESC LIMIT 1) pr ON TRUE
    LEFT JOIN LATERAL (SELECT MAX(f.created_at) AS last_followup_at FROM debt_followups f WHERE f.customer_id = d.customer_id) lf ON TRUE
    ${scopeWhere.length ? `WHERE ${scopeWhere.join(' AND ')}` : ''}
  ), x AS (
    SELECT b.*,
      (b.source = 'auto_invoice' AND b.status = 'unpaid' AND b.invoice_status = 'voided') AS invoice_voided,
      CASE WHEN b.status = 'written_off' OR (b.source = 'auto_invoice' AND b.status = 'unpaid' AND b.invoice_status = 'voided') THEN 'written_off'
           WHEN b.status = 'paid' THEN 'paid'
           WHEN b.invoice_id IS NULL AND b.standalone_paid > ${EPSILON} THEN 'partial'
           ELSE 'unpaid' END AS state,
      CASE WHEN b.invoice_id IS NULL THEN b.standalone_paid ELSE NULL END AS paid_amount,
      CASE WHEN b.status <> 'unpaid' OR (b.source = 'auto_invoice' AND b.invoice_status = 'voided') THEN 0
           WHEN b.invoice_id IS NULL THEN GREATEST(b.amount - b.standalone_paid, 0)
           ELSE b.amount END AS remaining
    FROM b
  ), dv AS (
    SELECT x.*,
      CASE WHEN x.age_days <= 30 THEN '0_30' WHEN x.age_days <= 60 THEN '31_60' WHEN x.age_days <= 90 THEN '61_90' ELSE '90_plus' END AS age_bucket,
      CASE WHEN x.state NOT IN ('unpaid', 'partial') OR x.promise_date IS NULL THEN 'none'
           WHEN x.promise_date < ($2::text)::date THEN 'broken'
           WHEN x.promise_date = ($2::text)::date THEN 'due_today'
           ELSE 'upcoming' END AS promise_state,
      CASE WHEN x.state IN ('unpaid', 'partial') THEN x.remaining ELSE x.amount END AS display_amount,
      CASE WHEN x.invoice_id IS NULL THEN 'standalone' WHEN x.source = 'auto_invoice' THEN 'invoice' ELSE 'manual_invoice' END AS collect_target
    FROM x
  )`;
}

async function viewContext(req) {
  const tz = await autoBilling.getTimezone();
  const today = autoBilling.localParts(new Date(), tz).date;
  const scope = await resolveScope(req.user);
  const params = [tz, today];
  const scopeWhere = [];
  if (scope.denied) scopeWhere.push('FALSE');
  if (scope.zoneId !== null) { params.push(scope.zoneId); scopeWhere.push(`c.zone_id = $${params.length}`); }
  return { tz, today, scope, params, scopeWhere };
}

// List / export / by-customer filters on the debt view. Returns { where } or { error }.
function buildFilters(q, params) {
  const where = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  if (q.customer_id !== undefined && q.customer_id !== '') {
    const cid = parseStrictId(String(q.customer_id));
    if (cid === null) return { error: 'Invalid customer_id filter.' };
    where.push(`dv.customer_id = ${push(cid)}`);
  }
  if (q.status) {
    if (!STATES.includes(q.status)) return { error: `status must be one of: ${STATES.join(', ')}.` };
    if (q.status === 'open') where.push(`dv.state IN ('unpaid', 'partial')`);
    else where.push(`dv.state = ${push(q.status)}`);
  }
  if (q.source) {
    if (!['auto', 'manual'].includes(q.source)) return { error: 'source must be auto or manual.' };
    where.push(q.source === 'auto' ? `dv.source = 'auto_invoice'` : `dv.source <> 'auto_invoice'`);
  }
  if (q.currency) {
    const cur = String(q.currency).toUpperCase();
    if (!['USD', 'SLSH'].includes(cur)) return { error: 'currency must be USD or SLSH.' };
    where.push(`dv.currency = ${push(cur)}`);
  }
  if (q.age) {
    if (!AGE_BUCKETS.includes(q.age)) return { error: `age must be one of: ${AGE_BUCKETS.join(', ')}.` };
    if (q.age === 'over_60') where.push('dv.age_days > 60');
    else where.push(`dv.age_bucket = ${push(q.age)}`);
  }
  if (q.promise) {
    if (!PROMISE_STATES.includes(q.promise)) return { error: `promise must be one of: ${PROMISE_STATES.join(', ')}.` };
    if (q.promise === 'any') where.push(`dv.promise_state <> 'none'`);
    else where.push(`dv.promise_state = ${push(q.promise)}`);
  }
  for (const [key, col] of [['zone_id', 'dv.zone_id'], ['group_id', 'dv.group_id'], ['group_zone_id', 'dv.group_zone_id'], ['route_id', 'dv.route_id']]) {
    if (q[key] === undefined || q[key] === '') continue;
    const v = parseStrictId(String(q[key]));
    if (v === null) return { error: `Invalid ${key} filter.` };
    where.push(`${col} = ${push(v)}`);
  }
  for (const [key, op] of [['amount_min', '>='], ['amount_max', '<=']]) {
    if (q[key] === undefined || q[key] === '') continue;
    const v = Number(q[key]);
    if (!Number.isFinite(v) || v < 0) return { error: `${key} must be a non-negative number.` };
    where.push(`dv.display_amount ${op} ${push(v)}`);
  }
  if (q.q) {
    const s = String(q.q).trim();
    if (s.length >= 2) {
      const p = push(`%${s}%`);
      const parts = [`dv.customer_name ILIKE ${p}`, `dv.business_name ILIKE ${p}`, `dv.customer_number ILIKE ${p}`, `dv.customer_number_current ILIKE ${p}`,
        `dv.invoice_number ILIKE ${p}`, `dv.phone ILIKE ${p}`, `dv.whatsapp ILIKE ${p}`, `dv.alternate_phone ILIKE ${p}`];
      // Phone typed in any style ("063 4259981", "+252 63...") matches the stored digits.
      let digits = s.replace(/\D/g, '');
      if (digits.startsWith('00252')) digits = digits.slice(5);
      else if (digits.startsWith('252') && digits.length > 9) digits = digits.slice(3);
      digits = digits.replace(/^0+/, '');
      if (digits.length >= 4) {
        const dp = push(`%${digits}%`);
        for (const col of ['phone', 'whatsapp', 'alternate_phone']) parts.push(`regexp_replace(COALESCE(dv.${col}, ''), '\\D', '', 'g') LIKE ${dp}`);
      }
      where.push(`(${parts.join(' OR ')})`);
    }
  }
  return { where };
}

const pageArgs = (q) => {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(q.page_size, 10) || 25));
  return { page, pageSize };
};
const whereSql = (w) => (w.length ? `WHERE ${w.join(' AND ')}` : '');

// Order for the debt list. 'amount' compares across currencies by the USD
// value at the CURRENT rate (ordering only — never a displayed total).
async function orderFor(q, params) {
  const key = q.sort || 'created_at';
  if (!Object.prototype.hasOwnProperty.call(SORTS, key)) return { error: `sort must be one of: ${Object.keys(SORTS).join(', ')}.` };
  const dir = String(q.dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  let expr = SORTS[key];
  if (key === 'amount') {
    const rate = await getCurrentExchangeRate();
    params.push(rate ? parseFloat(rate.rate) : null);
    expr = `(CASE WHEN dv.currency = 'SLSH' THEN dv.display_amount / NULLIF($${params.length}::numeric, 0) ELSE dv.display_amount END)`;
  }
  return { sql: `ORDER BY ${expr} ${dir} NULLS LAST, dv.id ${dir}` };
}

function shapeRow(r) {
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    ...r,
    amount: n(r.amount), remaining: n(r.remaining), paid_amount: n(r.paid_amount), display_amount: n(r.display_amount),
    standalone_paid: undefined, age_days: n(r.age_days), promise_amount: n(r.promise_amount),
    promise_date: r.promise_date ? toDateStr(r.promise_date) : null,
  };
}
function toDateStr(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

async function attachSuspension(rows) {
  const ids = [...new Set(rows.map((r) => r.customer_id))];
  if (!ids.length) return;
  const info = await debtSuspension.suspensionInfo(ids);
  for (const r of rows) r.suspension = info.map.get(r.customer_id) || null;
}

// ---------------------------------------------------------------------
// GET /summary — register totals per currency (never mixed, never invoice
// balances): outstanding, overdue > 60 / > 90 days, customers owing,
// collected this month on debts, promises due today, broken promises.
// ---------------------------------------------------------------------
router.get('/summary', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const ctx = await viewContext(req);
    const r = (await pool.query(
      `${debtViewSql(ctx.scopeWhere)}
       SELECT dv.currency,
         COALESCE(SUM(dv.remaining) FILTER (WHERE dv.state IN ('unpaid', 'partial')), 0) AS outstanding,
         COUNT(*) FILTER (WHERE dv.state IN ('unpaid', 'partial'))::int AS open_count,
         COALESCE(SUM(dv.remaining) FILTER (WHERE dv.state IN ('unpaid', 'partial') AND dv.age_days > 60), 0) AS over60,
         COUNT(*) FILTER (WHERE dv.state IN ('unpaid', 'partial') AND dv.age_days > 60)::int AS over60_count,
         COALESCE(SUM(dv.remaining) FILTER (WHERE dv.state IN ('unpaid', 'partial') AND dv.age_days > 90), 0) AS over90,
         COUNT(*) FILTER (WHERE dv.state IN ('unpaid', 'partial') AND dv.age_days > 90)::int AS over90_count,
         COUNT(*) FILTER (WHERE dv.state IN ('unpaid', 'partial') AND dv.source = 'auto_invoice')::int AS auto_open,
         COUNT(*) FILTER (WHERE dv.state IN ('unpaid', 'partial') AND dv.source <> 'auto_invoice')::int AS manual_open,
         COUNT(*) FILTER (WHERE dv.promise_state = 'due_today')::int AS promises_due_today,
         COUNT(*) FILTER (WHERE dv.promise_state = 'broken')::int AS broken_promises,
         COUNT(*) FILTER (WHERE dv.state = 'written_off')::int AS written_off_count
       FROM dv GROUP BY dv.currency`, ctx.params)).rows;
    const owing = (await pool.query(
      `${debtViewSql(ctx.scopeWhere)} SELECT COUNT(DISTINCT dv.customer_id)::int AS n FROM dv WHERE dv.state IN ('unpaid', 'partial')`, ctx.params)).rows[0].n;

    // Collected this month on debts: real payments on standalone debts plus
    // invoice payments taken from the Debts page for an auto debt, per
    // payment currency (company-local month).
    const cp = [ctx.tz, ctx.today.slice(0, 7)];
    const cw = [`p.status = 'recorded'`, `(p.debt_id IS NOT NULL OR p.collected_via_debt_id IS NOT NULL)`,
      `p.created_at >= (((($2 || '-01')::date)::timestamp AT TIME ZONE $1)::timestamp)`,
      `p.created_at < ((((($2 || '-01')::date + interval '1 month')::date)::timestamp AT TIME ZONE $1)::timestamp)`];
    if (ctx.scope.denied) cw.push('FALSE');
    if (ctx.scope.zoneId !== null) { cp.push(ctx.scope.zoneId); cw.push(`c.zone_id = $${cp.length}`); }
    const col = (await pool.query(
      `SELECT p.currency, COALESCE(SUM(p.amount), 0) AS amount, COUNT(*)::int AS n
       FROM payments p LEFT JOIN invoices i ON i.id = p.invoice_id LEFT JOIN debts pd ON pd.id = p.debt_id
       JOIN customers c ON c.id = COALESCE(i.customer_id, pd.customer_id)
       WHERE ${cw.join(' AND ')} GROUP BY p.currency`, cp)).rows;

    const blank = () => ({ USD: 0, SLSH: 0 });
    const out = {
      outstanding: blank(), over_60: blank(), over_90: blank(), collected_this_month: blank(),
      open_count: 0, over_60_count: 0, over_90_count: 0, collected_count: 0, customers_owing: owing,
      auto_open: 0, manual_open: 0, promises_due_today: 0, broken_promises: 0, written_off_count: 0,
      date: ctx.today, timezone: ctx.tz,
    };
    for (const row of r) {
      const c = curOf(row.currency);
      out.outstanding[c] += Number(row.outstanding);
      out.over_60[c] += Number(row.over60);
      out.over_90[c] += Number(row.over90);
      out.open_count += row.open_count; out.over_60_count += row.over60_count; out.over_90_count += row.over90_count;
      out.auto_open += row.auto_open; out.manual_open += row.manual_open;
      out.promises_due_today += row.promises_due_today; out.broken_promises += row.broken_promises; out.written_off_count += row.written_off_count;
    }
    for (const row of col) { out.collected_this_month[curOf(row.currency)] += Number(row.amount); out.collected_count += row.n; }
    for (const k of ['outstanding', 'over_60', 'over_90', 'collected_this_month']) {
      out[k].USD = Number(out[k].USD.toFixed(2));
      out[k].SLSH = Number(out[k].SLSH.toFixed(2));
    }
    res.json({ data: out });
  } catch (err) {
    console.error('debts summary failed:', err && err.message);
    res.status(500).json({ error: { message: 'Failed to load the debts summary.', code: 'INTERNAL' } });
  }
});

// ---------------------------------------------------------------------
// GET /export.csv — the filtered list as CSV (formula-safe). Over
// CSV_MAX_ROWS -> 413, never a silently truncated file.
// ---------------------------------------------------------------------
router.get('/export.csv', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const ctx = await viewContext(req);
    const f = buildFilters(req.query, ctx.params);
    if (f.error) return bad(res, f.error);
    const ord = await orderFor(req.query, ctx.params);
    if (ord.error) return bad(res, ord.error);
    const rows = (await pool.query(
      `${debtViewSql(ctx.scopeWhere)} SELECT dv.* FROM dv ${whereSql(f.where)} ${ord.sql} LIMIT ${CSV_MAX_ROWS + 1}`, ctx.params)).rows;
    if (rows.length > CSV_MAX_ROWS) {
      return res.status(413).json({ error: { message: `More than ${CSV_MAX_ROWS.toLocaleString('en-US')} debts match — narrow the filters and export again.`, code: 'TOO_MANY_ROWS' } });
    }
    const pathOf = (r) => [r.group_code || r.group_name, r.zone_name, r.group_zone_name || r.group_zone_code, r.route_name || r.route_code].filter(Boolean).join(' > ');
    const columns = [
      { key: 'id', label: 'Debt #' }, { key: 'created', label: 'Created' }, { key: 'age_days', label: 'Age (days)' }, { key: 'age_bucket', label: 'Age bucket' },
      { key: 'customer_number', label: 'Customer #' }, { key: 'customer_name', label: 'Customer' }, { key: 'phone', label: 'Phone' }, { key: 'path', label: 'Group > District > Zone > Sub Zone' },
      { key: 'source_label', label: 'Source' }, { key: 'invoice_number', label: 'Invoice' }, { key: 'description', label: 'Description' },
      { key: 'currency', label: 'Currency' }, { key: 'amount_fmt', label: 'Amount' }, { key: 'paid_fmt', label: 'Paid' }, { key: 'remaining_fmt', label: 'Remaining' },
      { key: 'state', label: 'Status' }, { key: 'promise', label: 'Promise date' }, { key: 'promise_state', label: 'Promise state' },
      { key: 'last_followup', label: 'Last follow-up' }, { key: 'created_by_name', label: 'Created by' }, { key: 'written_off_reason', label: 'Write-off reason' },
    ];
    const money = (v, cur) => (v === null || v === undefined ? '' : (cur === 'SLSH' ? String(Math.round(Number(v))) : Number(v).toFixed(2)));
    const csv = toCsv(rows.map((r) => ({
      ...r,
      created: toDateStr(r.created_at), path: pathOf(r), source_label: r.source === 'auto_invoice' ? 'Auto (invoice)' : 'Manual',
      amount_fmt: money(r.amount, r.currency), paid_fmt: money(r.paid_amount, r.currency), remaining_fmt: money(r.remaining, r.currency),
      promise: r.promise_date ? toDateStr(r.promise_date) : '', last_followup: r.last_followup_at ? new Date(r.last_followup_at).toISOString().slice(0, 16).replace('T', ' ') : '',
    })), columns);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="debts-${ctx.today}.csv"`);
    res.send('﻿' + csv);
  } catch (err) {
    console.error('debts export failed:', err && err.message);
    res.status(500).json({ error: { message: 'Failed to export debts.', code: 'INTERNAL' } });
  }
});

// ---------------------------------------------------------------------
// Follow-ups (calls / visits / messages, optional promise to pay). Anyone
// who can view debts can log one, inside their own zone.
// ---------------------------------------------------------------------
router.get('/followups', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const cid = req.query.customer_id ? parseStrictId(String(req.query.customer_id)) : null;
  const did = req.query.debt_id ? parseStrictId(String(req.query.debt_id)) : null;
  if (cid === null && did === null) return bad(res, 'customer_id or debt_id is required.');
  try {
    const scope = await resolveScope(req.user);
    let customerId = cid;
    if (did !== null) {
      const d = (await pool.query('SELECT customer_id FROM debts WHERE id = $1', [did])).rows[0];
      if (!d) return bad(res, 'Debt not found.', 'NOT_FOUND', 404);
      if (cid !== null && cid !== d.customer_id) return bad(res, 'debt_id belongs to another customer.');
      customerId = d.customer_id;
    }
    if (!(await customerInScope(scope, customerId))) return bad(res, 'You do not have access to this customer.', 'FORBIDDEN', 403);
    const params = [customerId];
    let extra = '';
    if (did !== null) { params.push(did); extra = ` AND (f.debt_id = $2 OR f.debt_id IS NULL)`; }
    const rows = (await pool.query(
      `SELECT f.*, to_char(f.promise_date, 'YYYY-MM-DD') AS promise_date, COALESCE(u.full_name, u.username) AS created_by_name
       FROM debt_followups f LEFT JOIN v2_users u ON u.id = f.created_by
       WHERE f.customer_id = $1${extra} ORDER BY f.created_at DESC, f.id DESC LIMIT 200`, params)).rows;
    res.json({ data: rows.map((r) => ({ ...r, promise_amount: r.promise_amount === null ? null : Number(r.promise_amount) })) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load follow-ups.', code: 'INTERNAL' } });
  }
});

router.post('/followups', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const b = req.body || {};
  if (!FOLLOWUP_KINDS.includes(b.kind)) return bad(res, `kind must be one of: ${FOLLOWUP_KINDS.join(', ')}.`);
  const note = typeof b.note === 'string' ? b.note.trim() : '';
  if (note.length > 1000) return bad(res, 'note can be at most 1000 characters.');
  let debtId = null;
  if (b.debt_id !== undefined && b.debt_id !== null && b.debt_id !== '') {
    debtId = parseStrictId(String(b.debt_id));
    if (debtId === null) return bad(res, 'Invalid debt_id.');
  }
  let customerId = null;
  if (b.customer_id !== undefined && b.customer_id !== null && b.customer_id !== '') {
    customerId = parseStrictId(String(b.customer_id));
    if (customerId === null) return bad(res, 'Invalid customer_id.');
  }
  if (customerId === null && debtId === null) return bad(res, 'customer_id or debt_id is required.');
  const promiseDate = b.promise_date ? String(b.promise_date) : null;
  if (promiseDate !== null && !validDate(promiseDate)) return bad(res, 'promise_date must be YYYY-MM-DD.');
  if (!note && promiseDate === null) return bad(res, 'Write a note or set a promise date.');
  try {
    const scope = await resolveScope(req.user);
    let debt = null;
    if (debtId !== null) {
      debt = (await pool.query('SELECT id, customer_id, currency, status FROM debts WHERE id = $1', [debtId])).rows[0];
      if (!debt) return bad(res, 'Debt not found.', 'NOT_FOUND', 404);
      if (customerId !== null && customerId !== debt.customer_id) return bad(res, 'debt_id belongs to another customer.');
      customerId = debt.customer_id;
    } else {
      const c = (await pool.query('SELECT id FROM customers WHERE id = $1', [customerId])).rows[0];
      if (!c) return bad(res, 'Customer not found.', 'NOT_FOUND', 404);
    }
    if (!(await customerInScope(scope, customerId))) return bad(res, 'You do not have access to this customer.', 'FORBIDDEN', 403);

    const tz = await autoBilling.getTimezone();
    const today = autoBilling.localParts(new Date(), tz).date;
    if (promiseDate !== null && promiseDate < today) return bad(res, 'promise_date cannot be in the past.');
    let promiseAmount = null;
    let promiseCurrency = null;
    if (b.promise_amount !== undefined && b.promise_amount !== null && b.promise_amount !== '') {
      if (promiseDate === null) return bad(res, 'promise_amount needs a promise_date.');
      promiseAmount = Number(b.promise_amount);
      promiseCurrency = String(b.promise_currency || (debt ? curOf(debt.currency) : 'USD')).toUpperCase();
      if (!['USD', 'SLSH'].includes(promiseCurrency)) return bad(res, 'promise_currency must be USD or SLSH.');
      if (!Number.isFinite(promiseAmount) || promiseAmount <= 0) return bad(res, 'promise_amount must be a positive number.');
      const pe = amountPrecisionError(promiseAmount, promiseCurrency);
      if (pe) return bad(res, pe);
    }
    const row = (await pool.query(
      `INSERT INTO debt_followups (customer_id, debt_id, kind, note, promise_date, promise_amount, promise_currency, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *, to_char(promise_date, 'YYYY-MM-DD') AS promise_date`,
      [customerId, debtId, b.kind, note || null, promiseDate, promiseAmount, promiseCurrency, req.user.id ?? null])).rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'debt.followup', entityType: debtId ? 'debt' : 'customer', entityId: debtId || customerId, before: null, after: row });
    res.status(201).json({ data: { ...row, promise_amount: row.promise_amount === null ? null : Number(row.promise_amount) } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to save the follow-up.', code: 'INTERNAL' } });
  }
});

// ---------------------------------------------------------------------
// GET / — the register. Filters (buildFilters), sort, pagination
// (page_size 25, max 100). view=customer groups the filtered debts per
// customer (totals per currency, debt count, oldest age, last follow-up).
// ---------------------------------------------------------------------
router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const ctx = await viewContext(req);
    const f = buildFilters(req.query, ctx.params);
    if (f.error) return bad(res, f.error);
    const { page, pageSize } = pageArgs(req.query);
    const offset = (page - 1) * pageSize;
    const w = whereSql(f.where);

    if (req.query.view === 'customer') {
      const key = req.query.sort || 'oldest';
      if (!Object.prototype.hasOwnProperty.call(CUSTOMER_SORTS, key)) return bad(res, `sort must be one of: ${Object.keys(CUSTOMER_SORTS).join(', ')}.`);
      const dir = String(req.query.dir || (key === 'customer' ? 'asc' : 'desc')).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const grouped = `${debtViewSql(ctx.scopeWhere)}, f AS (SELECT dv.* FROM dv ${w}), g AS (
          SELECT f.customer_id, f.customer_name, f.business_name, f.customer_number_current AS customer_number, f.phone, f.whatsapp, f.alternate_phone,
            f.customer_status, f.suspended_reason, f.zone_name, f.group_code, f.group_name, f.group_zone_name, f.group_zone_code, f.route_name, f.route_code, f.route_id,
            COALESCE(SUM(f.remaining) FILTER (WHERE f.currency = 'USD'), 0) AS usd,
            COALESCE(SUM(f.remaining) FILTER (WHERE f.currency = 'SLSH'), 0) AS slsh,
            COUNT(*)::int AS debt_count,
            COUNT(*) FILTER (WHERE f.state IN ('unpaid', 'partial'))::int AS open_count,
            COALESCE(MAX(f.age_days) FILTER (WHERE f.state IN ('unpaid', 'partial')), MAX(f.age_days)) AS oldest_age,
            MAX(f.last_followup_at) AS last_followup_at,
            COUNT(*) FILTER (WHERE f.promise_state = 'broken')::int AS broken_promises,
            COUNT(*) FILTER (WHERE f.promise_state = 'due_today')::int AS promises_due_today
          FROM f
          GROUP BY f.customer_id, f.customer_name, f.business_name, f.customer_number_current, f.phone, f.whatsapp, f.alternate_phone,
            f.customer_status, f.suspended_reason, f.zone_name, f.group_code, f.group_name, f.group_zone_name, f.group_zone_code, f.route_name, f.route_code, f.route_id)`;
      const total = (await pool.query(`${grouped} SELECT COUNT(*)::int AS n FROM g`, ctx.params)).rows[0].n;
      const rows = (await pool.query(
        `${grouped} SELECT g.* FROM g ORDER BY ${CUSTOMER_SORTS[key]} ${dir} NULLS LAST, g.customer_id ${dir} LIMIT ${pageSize} OFFSET ${offset}`, ctx.params)).rows
        .map((r) => ({ ...r, usd: Number(r.usd), slsh: Number(r.slsh), oldest_age: r.oldest_age === null ? null : Number(r.oldest_age), totals: { USD: Number(r.usd), SLSH: Number(r.slsh) } }));
      await attachSuspension(rows);
      return res.json({ data: rows, meta: { view: 'customer', page, page_size: pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) } });
    }

    const countParams = [...ctx.params];
    const ord = await orderFor(req.query, ctx.params);
    if (ord.error) return bad(res, ord.error);
    const total = (await pool.query(`${debtViewSql(ctx.scopeWhere)} SELECT COUNT(*)::int AS n FROM dv ${w}`, countParams)).rows[0].n;
    const rows = (await pool.query(
      `${debtViewSql(ctx.scopeWhere)} SELECT dv.* FROM dv ${w} ${ord.sql} LIMIT ${pageSize} OFFSET ${offset}`, ctx.params)).rows.map(shapeRow);
    await attachSuspension(rows);
    res.json({ data: rows, meta: { page, page_size: pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) } });
  } catch (err) {
    console.error('debts list failed:', err && err.message);
    res.status(500).json({ error: { message: 'Failed to list debts.', code: 'INTERNAL' } });
  }
});

// POST / — standalone or invoice-linked. Matches the reference system's
// own POST /api/debts, which never required an invoice (OD-1: invoice_id
// nullable).
router.post('/', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  const { customer_id, invoice_id, amount, currency, description } = req.body;
  const custId = parseStrictId(String(customer_id ?? ''));
  if (custId === null) return res.status(400).json({ error: { message: 'customer_id is required.', code: 'VALIDATION' } });
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: { message: 'amount must be a positive number.', code: 'VALIDATION' } });
  const cur = String(currency || 'USD').toUpperCase();
  if (!['USD', 'SLSH'].includes(cur)) return res.status(400).json({ error: { message: 'currency must be USD or SLSH.', code: 'VALIDATION' } });
  const precision = amountPrecisionError(amt, cur);
  if (precision) return res.status(400).json({ error: { message: precision, code: 'VALIDATION' } });
  const desc = typeof description === 'string' ? description.trim() : '';
  if (desc.length > 500) return res.status(400).json({ error: { message: 'description can be at most 500 characters.', code: 'VALIDATION' } });

  let invId = null;
  if (invoice_id !== undefined && invoice_id !== null && invoice_id !== '') {
    invId = parseStrictId(String(invoice_id));
    if (invId === null) return res.status(400).json({ error: { message: 'Invalid invoice_id.', code: 'VALIDATION' } });
  }

  try {
    const custRes = await pool.query('SELECT id, zone_id FROM customers WHERE id = $1', [custId]);
    if (custRes.rows.length === 0) return res.status(404).json({ error: { message: 'Customer not found.', code: 'NOT_FOUND' } });
    const scope = await resolveScope(req.user);
    if (scope.denied || (scope.zoneId !== null && custRes.rows[0].zone_id !== scope.zoneId)) {
      return res.status(403).json({ error: { message: 'You cannot create a debt for a customer outside your zone.', code: 'FORBIDDEN' } });
    }
    if (invId !== null) {
      const invRes = await pool.query('SELECT id, customer_id FROM invoices WHERE id = $1', [invId]);
      if (invRes.rows.length === 0) return res.status(400).json({ error: { message: 'invoice_id does not reference an existing invoice.', code: 'VALIDATION' } });
      if (invRes.rows[0].customer_id !== custId) return res.status(400).json({ error: { message: 'The referenced invoice belongs to a different customer.', code: 'VALIDATION' } });
    }

    const inserted = await pool.query(
      `INSERT INTO debts (customer_id, invoice_id, amount, currency, description, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'unpaid',$6) RETURNING *`,
      [custId, invId, amt, cur, desc || null, req.user.id]
    );
    const debt = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'debt.create', entityType: 'debt', entityId: debt.id, before: null, after: debt });
    res.status(201).json({ data: debt });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to create debt.', code: 'INTERNAL' } });
  }
});

// ---------------------------------------------------------------------
// GET /:id — one debt with its payment history, follow-ups, the customer's
// suspension state and what "Collect payment" will do.
// ---------------------------------------------------------------------
router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return bad(res, 'Invalid debt id.');
  try {
    const ctx = await viewContext(req);
    ctx.params.push(id);
    const row = (await pool.query(`${debtViewSql([...ctx.scopeWhere, `d.id = $${ctx.params.length}`])} SELECT dv.* FROM dv`, ctx.params)).rows[0];
    if (!row) {
      const exists = (await pool.query('SELECT 1 FROM debts WHERE id = $1', [id])).rows.length > 0;
      return exists ? bad(res, 'You do not have access to this debt.', 'FORBIDDEN', 403) : bad(res, 'Debt not found.', 'NOT_FOUND', 404);
    }
    const debt = shapeRow(row);
    const payCols = `p.id, p.invoice_id, p.debt_id, p.collected_via_debt_id, p.amount, p.currency, p.method, p.amount_usd, p.status, p.reference_code, p.channel,
      p.cashier_id, p.created_at, p.reversed_at, p.reversed_reason, p.amount_debt_currency, p.amount_invoice_currency,
      COALESCE(u.full_name, u.username) AS cashier_name, COALESCE(ru.full_name, ru.username) AS reversed_by_name`;
    const payments = debt.invoice_id === null
      ? (await pool.query(`SELECT ${payCols} FROM payments p LEFT JOIN v2_users u ON u.id = p.cashier_id LEFT JOIN v2_users ru ON ru.id = p.reversed_by
                           WHERE p.debt_id = $1 ORDER BY p.created_at ASC, p.id ASC`, [id])).rows
      : (await pool.query(`SELECT ${payCols} FROM payments p LEFT JOIN v2_users u ON u.id = p.cashier_id LEFT JOIN v2_users ru ON ru.id = p.reversed_by
                           WHERE p.invoice_id = $1 ORDER BY p.created_at ASC, p.id ASC`, [debt.invoice_id])).rows;
    const followups = (await pool.query(
      `SELECT f.*, to_char(f.promise_date, 'YYYY-MM-DD') AS promise_date, COALESCE(u.full_name, u.username) AS created_by_name
       FROM debt_followups f LEFT JOIN v2_users u ON u.id = f.created_by
       WHERE f.customer_id = $1 AND (f.debt_id = $2 OR f.debt_id IS NULL) ORDER BY f.created_at DESC, f.id DESC LIMIT 100`,
      [debt.customer_id, id])).rows;
    const info = await debtSuspension.suspensionInfo([debt.customer_id]);
    debt.suspension = info.map.get(debt.customer_id) || null;

    // What Collect payment does, and the most it can take.
    const rate = await getCurrentExchangeRate();
    const collect = { target: debt.collect_target, currency: debt.currency, max: debt.remaining, rate: rate ? { id: rate.id, rate: Number(rate.rate) } : null, zaad_push: false };
    if (debt.collect_target === 'invoice' && debt.invoice_id !== null) {
      const bal = await getInvoiceBalance(debt.invoice_id);
      const invCur = bal ? bal.currency : debt.currency;
      const trueOutstanding = bal ? Math.max(bal.netTotal - await paidInInvoiceCurrency(debt.invoice_id, invCur, pool, { excludeDebt: true }), 0) : 0;
      const zs = (await zaadStateFor([debt.invoice_id])).get(debt.invoice_id);
      Object.assign(collect, {
        currency: invCur, max: debt.state === 'unpaid' ? trueOutstanding : 0, invoice_outstanding: bal ? bal.outstanding : null,
        invoice_status: bal ? bal.status : null, zaad_push: true,
        zaad_in_progress: !!(zs && zs.in_progress), zaad_blocked_until: (zs && zs.blocked_until) || null,
      });
    }
    res.json({ data: { ...debt, payments: payments.map((p) => ({ ...p, via_this_debt: p.debt_id === id || p.collected_via_debt_id === id })), followups, collect } });
  } catch (err) {
    console.error('debt detail failed:', err && err.message);
    res.status(500).json({ error: { message: 'Failed to load the debt.', code: 'INTERNAL' } });
  }
});

// PUT /:id — description edit only (creator or admin). Amounts, currency,
// customer, invoice and status are immutable here (money moves only through
// payments, write-off, or the invoice). Audited.
router.put('/:id', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return bad(res, 'Invalid debt id.');
  const body = req.body || {};
  const immutable = ['amount', 'currency', 'customer_id', 'invoice_id', 'status', 'source'].filter((k) => body[k] !== undefined);
  if (immutable.length) return bad(res, `Debt ${immutable.join(', ')} cannot be changed — amounts are immutable. Record a payment or write the debt off instead.`, 'IMMUTABLE');
  if (body.description === undefined) return bad(res, 'description is required.');
  if (body.description !== null && typeof body.description !== 'string') return bad(res, 'description must be text.');
  const desc = body.description === null ? '' : body.description.trim();
  if (desc.length > 500) return bad(res, 'description can be at most 500 characters.');
  try {
    const cur = (await pool.query('SELECT * FROM debts WHERE id = $1', [id])).rows[0];
    if (!cur) return bad(res, 'Debt not found.', 'NOT_FOUND', 404);
    const scope = await resolveScope(req.user);
    if (!(await customerInScope(scope, cur.customer_id))) return bad(res, 'You do not have access to this debt.', 'FORBIDDEN', 403);
    if ((req.user.role || '').toLowerCase() !== 'admin' && cur.created_by !== req.user.id) {
      return bad(res, 'Only the person who created this debt, or an admin, can edit it.', 'FORBIDDEN', 403);
    }
    const upd = (await pool.query('UPDATE debts SET description = $1, updated_at = NOW() WHERE id = $2 RETURNING *', [desc || null, id])).rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'debt.update', entityType: 'debt', entityId: id, before: { description: cur.description }, after: { description: upd.description } });
    res.json({ data: upd });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update the debt.', code: 'INTERNAL' } });
  }
});

// ---------------------------------------------------------------------
// POST /:id/collect — record a REAL payment on a debt (replaces the bare
// Settle in the UI). Standalone debt -> payment on the debt; auto debt ->
// payment on its invoice (collectDebt mode). ZAAD API push for an auto debt
// goes through POST /payments/zaad-request with debt_id (all its guards).
// ---------------------------------------------------------------------
router.post('/:id/collect', authenticateToken, requireRole(...COLLECT_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return bad(res, 'Invalid debt id.');
  const { amount, currency, method, reference_code } = req.body || {};
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return bad(res, 'amount must be a positive number.');
  const cur = String(currency || 'USD').toUpperCase();
  if (!['USD', 'SLSH'].includes(cur)) return bad(res, 'currency must be USD or SLSH.');
  if (!COLLECT_METHODS.includes(method)) return bad(res, `method must be one of: ${COLLECT_METHODS.join(', ')}.`);
  if (method === 'slsh' && cur !== 'SLSH') return bad(res, 'SLSH cash is always recorded in SLSH.');
  const precision = amountPrecisionError(amt, cur);
  if (precision) return bad(res, precision);
  const ref = reference_code === undefined || reference_code === null ? '' : String(reference_code).trim();
  if (ref.length > 50) return bad(res, 'reference_code can be at most 50 characters.');
  if (method === 'zaad' && !ref) return bad(res, 'reference_code (the ZAAD transaction code) is required for a ZAAD payment.');
  if (method === 'edahab' && !ref) return bad(res, 'reference_code (the eDahab transaction code) is required for an eDahab payment.');

  let debt;
  let scope;
  try {
    scope = await resolveScope(req.user);
    debt = (await pool.query('SELECT * FROM debts WHERE id = $1', [id])).rows[0];
    if (!debt) return bad(res, 'Debt not found.', 'NOT_FOUND', 404);
    if (!(await customerInScope(scope, debt.customer_id))) return bad(res, 'You do not have access to this debt.', 'FORBIDDEN', 403);
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to record the payment.', code: 'INTERNAL' } });
  }
  if (debt.invoice_id !== null && debt.source !== 'auto_invoice') {
    return bad(res, 'This manual debt is linked to an invoice: take the payment on that invoice in Billing, then settle this debt.', 'MANUAL_INVOICE_DEBT', 409);
  }
  if (debt.invoice_id !== null) {
    const blocked = debtPayments.checkAutoDebtForCollection(debt);
    if (blocked) return bad(res, blocked.message, blocked.code, blocked.status);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (debt.invoice_id === null) {
      const out = await debtPayments.recordDebtPaymentCore(client, req.user, { debtId: id, amt, cur, method, referenceCode: ref || null, zoneId: scope.zoneId });
      await client.query('COMMIT');
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'payment.create', entityType: 'payment', entityId: out.payment.id, before: null, after: out.payment });
      if (out.debt.status === 'paid') {
        await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'debt.settle', entityType: 'debt', entityId: id, before: out.debtBefore, after: { ...out.debt, settled_by_payment_id: out.payment.id } });
      }
      return res.status(201).json({ data: { target: 'debt', payment: out.payment, debt: { id, status: out.debt.status, currency: out.currency, paid: out.paid, remaining: out.remaining } } });
    }
    const rec = await paymentsRouter.recordPaymentCore(client, req.user, {
      invoiceId: debt.invoice_id, amt, cur, method, referenceCode: ref || null, collectDebt: true, viaDebtId: id,
    });
    await client.query('COMMIT');
    await debtSuspension.afterPayment(rec.invoice.customer_id);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'payment.create', entityType: 'payment', entityId: rec.payment.id, before: null, after: rec.payment });
    if (rec.conversion) await paymentsRouter.auditConversion(req.user, rec.payment, rec.conversion);
    const after = await debtPayments.autoDebtStateForInvoice(debt.invoice_id);
    return res.status(201).json({ data: {
      target: 'invoice', payment: rec.payment, invoice_status: rec.recalculated.status, outstanding: rec.recalculated.outstanding,
      outstanding_currency: rec.recalculated.currency, debt: after, conversion: rec.conversion || null,
    } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof PaymentError || err instanceof paymentsRouter.PaymentError) return bad(res, err.message, err.code, err.status);
    if (err && err.code === '23505') return bad(res, `A ${method === 'edahab' ? 'eDahab' : 'ZAAD'} payment with this transaction code is already recorded.`, 'DUPLICATE_REFERENCE', 409);
    console.error('debt collect failed:', err && err.message);
    return res.status(500).json({ error: { message: 'Failed to record the payment.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// PUT /:id/write-off — admin only, reason required, audited. Allowed only
// for manual / standalone debts: an auto debt mirrors its invoice, so the
// invoice must be voided or adjusted instead (409). The written-off
// remainder leaves every total; recorded payments stay as they are.
router.put('/:id/write-off', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return bad(res, 'Invalid debt id.');
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) return bad(res, 'A reason is required to write off a debt.');
  if (reason.length > 1000) return bad(res, 'reason can be at most 1000 characters.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT * FROM debts WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!cur) { await client.query('ROLLBACK'); return bad(res, 'Debt not found.', 'NOT_FOUND', 404); }
    if (cur.source === 'auto_invoice') {
      await client.query('ROLLBACK');
      return bad(res, 'This debt is the unpaid part of an invoice and follows it automatically. Void or adjust the invoice instead of writing the debt off.', 'AUTO_DEBT_WRITE_OFF', 409);
    }
    if (cur.status !== 'unpaid') {
      await client.query('ROLLBACK');
      return bad(res, cur.status === 'paid' ? 'This debt is already paid.' : 'This debt is already written off.', 'CONFLICT', 409);
    }
    const paid = cur.invoice_id === null ? await debtPayments.debtPaidAmount(id, client) : 0;
    const remaining = Math.max(parseFloat(cur.amount) - paid, 0);
    const upd = (await client.query(
      `UPDATE debts SET status = 'written_off', written_off_at = NOW(), written_off_by = $1, written_off_reason = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [req.user.id, reason, id])).rows[0];
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'debt.write_off', entityType: 'debt', entityId: id,
      before: { status: cur.status, amount: cur.amount, currency: cur.currency, paid }, after: { status: 'written_off', reason, remaining_written_off: remaining, currency: curOf(cur.currency) } });
    res.json({ data: { ...upd, remaining_written_off: remaining } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: { message: 'Failed to write off the debt.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// PUT /:id/status — LEGACY settle to 'paid' (kept for API compatibility; the
// Debts page no longer offers it except for manual debts linked to an
// invoice). OD-1's soft-block-with-reason: if the linked invoice is still
// outstanding, settlement_override_reason is required. Settling a standalone
// debt here records NO payment — the audit entry says so explicitly; use
// POST /:id/collect for money actually received.
router.put('/:id/status', authenticateToken, requireRole(...SETTLE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid debt id.', code: 'VALIDATION' } });
  const { status, settlement_override_reason } = req.body;
  if (status !== 'paid') return res.status(400).json({ error: { message: "Only status 'paid' may be set via this endpoint.", code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM debts WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Debt not found.', code: 'NOT_FOUND' } });
    }
    const debt = existing.rows[0];
    if (debt.status === 'paid') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'This debt is already settled.', code: 'CONFLICT' } });
    }
    if (debt.status === 'written_off') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'This debt is written off.', code: 'CONFLICT' } });
    }

    let overrideReason = null;
    if (debt.invoice_id !== null) {
      const balance = await getInvoiceBalance(debt.invoice_id, client);
      if (balance && balance.outstanding > EPSILON) {
        const reason = (settlement_override_reason || '').trim();
        if (!reason) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: {
              message: `Cannot settle this debt: the originating invoice #${debt.invoice_id} still has an outstanding balance of ${balance.currency === 'SLSH' ? Math.round(balance.outstanding).toLocaleString('en-US') + ' SLSH' : '$' + balance.outstanding.toFixed(2)}. Provide settlement_override_reason to settle anyway.`,
              code: 'INVOICE_STILL_OUTSTANDING',
            },
          });
        }
        overrideReason = reason;
      }
    }
    const unpaidRemainder = debt.invoice_id === null ? Math.max(parseFloat(debt.amount) - await debtPayments.debtPaidAmount(id, client), 0) : null;

    const updated = await client.query(
      `UPDATE debts SET status = 'paid', settled_at = NOW(), settled_by = $1, settlement_override_reason = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [req.user.id, overrideReason, id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'debt.settle', entityType: 'debt', entityId: id, before: debt,
      after: { ...updated.rows[0], ...(unpaidRemainder !== null && unpaidRemainder > EPSILON ? { settled_without_payment: true, unpaid_remainder: unpaidRemainder } : {}) } });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to settle debt.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

module.exports = router;
