const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { recalculateInvoiceStatus, getCurrentExchangeRate, paidInInvoiceCurrency, EPSILON } = require('../lib/financialCalculations');
// Called as zaadService.requestZaadPayment(...) (module property, not a
// destructured binding) so the test server's preload can stub the gateway.
const zaadService = require('../lib/zaadService');
const debtSuspension = require('../lib/debtSuspension');
const autoBilling = require('../lib/autoBilling');
const { toCsv } = require('../lib/csvImportExport');
const zaadAttempts = require('../lib/zaadAttempts');

const router = express.Router();

// 'cashier' added (user-reported live, Phase 10) — same gap and same
// fix as invoices.js: every check in this file (GET /, POST /) already
// structurally enforces resolveUserZoneId()'s result, only the role
// list was missing 'cashier', letting them record payment on any
// customer's invoice company-wide instead of their own zone only.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'cashier'];
const VIEW_ROLES = ['admin', 'cashier', 'gudoomiye', 'zone_accountant'];
const RECORD_ROLES = ['admin', 'cashier'];
const VALID_METHODS = ['cash', 'zaad', 'edahab', 'slsh', 'debt'];

function parseStrictId(raw) {
  if (!/^\d+$/.test(raw)) return null;
  return parseInt(raw, 10);
}

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

// Structured, expected rejection (404/409/403/...) — distinct from an
// unexpected 500, so both POST / and POST /zaad-request below can map it
// straight back to the right HTTP status without duplicating the
// if/else chain that used to live inline in POST / alone.
class PaymentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Amount precision (finance redesign fix round): SLSH has no subunit, USD
// has cents. Returns an error message or null.
function amountPrecisionError(amt, cur) {
  if (cur === 'SLSH') return Number.isInteger(amt) ? null : 'SLSH amounts must be whole numbers.';
  return Math.abs(amt * 100 - Math.round(amt * 100)) < 1e-6 ? null : 'USD amounts can have at most 2 decimals.';
}

const SLSH_TOLERANCE_USD = 0.005; // half a cent, expressed in SLSH via the rate

const fmtMoney = (cur, n) => cur === 'SLSH' ? `${Math.round(n).toLocaleString('en-US')} SLSH` : `$${n.toFixed(2)}`;

// Size one payment in the invoice's own currency and check it against the
// outstanding balance. A USD payment on an SLSH invoice is converted at the
// current rate and tolerates half a cent (rate x 0.005 SLSH): within that
// band of the outstanding it is accepted and SNAPPED to exactly the
// outstanding, so a whole-cent USD amount can always close an SLSH invoice.
// Returns { error } (status/code/outstanding/attempted/invCur) or
// { attempted, aic, conversionRateId }.
function sizePayment({ invCur, cur, amt, amountUsd, outstanding, rate }) {
  if (invCur !== 'SLSH') {
    if (amountUsd > outstanding + EPSILON) return { error: { status: 409, code: 'OVERPAYMENT', outstanding, attempted: amountUsd, invCur } };
    return { attempted: amountUsd, aic: amountUsd, conversionRateId: null };
  }
  if (cur === 'SLSH') {
    if (amt > outstanding + EPSILON) return { error: { status: 409, code: 'OVERPAYMENT', outstanding, attempted: amt, invCur } };
    return { attempted: amt, aic: amt, conversionRateId: null };
  }
  if (!rate) return { error: { status: 409, code: 'NO_EXCHANGE_RATE', message: 'No exchange rate is configured — cannot apply a USD payment to a SLSH invoice.' } };
  const r = parseFloat(rate.rate);
  const attempted = amt * r;
  const tol = r * SLSH_TOLERANCE_USD;
  if (attempted > outstanding + tol) return { error: { status: 409, code: 'OVERPAYMENT', outstanding, attempted, invCur } };
  const aic = attempted >= outstanding - tol ? outstanding : attempted;
  return { attempted, aic, conversionRateId: rate.id };
}

// Read-only pre-check shared with POST /zaad-request (runs BEFORE any
// gateway call). Returns null when OK, else { status, code, message }.
async function precheckPayment(client, invoice, { amt, cur }) {
  const invCur = invoice.currency === 'SLSH' ? 'SLSH' : 'USD';
  // A cross-currency payment needs the current rate in both directions: USD
  // on a SLSH invoice is sized in SLSH; SLSH on a USD invoice is converted to
  // USD exactly as recordPaymentCore does (amt / rate) — checked BEFORE any
  // gateway call so an overpaying push never reaches the customer's phone.
  const rate = cur !== invCur ? await getCurrentExchangeRate(client) : null;
  if (cur !== invCur && !rate) {
    return { status: 409, code: 'NO_EXCHANGE_RATE', message: `No exchange rate is configured — cannot apply a ${cur} payment to a ${invCur} invoice.` };
  }
  const amountUsd = cur === 'SLSH' && invCur === 'USD' ? amt / parseFloat(rate.rate) : amt;
  const netTotal = parseFloat(invoice.invoice_total) - parseFloat(invoice.discount_amount);
  const outstanding = netTotal - await paidInInvoiceCurrency(invoice.id, invCur, client, { rate: invCur === 'SLSH' ? rate : undefined });
  const sized = sizePayment({ invCur, cur, amt, amountUsd, outstanding, rate });
  if (sized.error) {
    return { status: 409, code: sized.error.code, message: sized.error.message || `Amount exceeds outstanding balance. Outstanding: ${fmtMoney(invCur, outstanding)}.` };
  }
  return null;
}

// The single source of truth for "record one payment against one
// invoice" — every financial-integrity rule from the approved spec
// lives here: row-locked invoice, balance computed inside the same
// transaction, overpayment structurally blocked, amount_usd captured
// and stored (never recomputed later). Extracted out of POST / (Phase
// 10) so POST /zaad-request below can reuse the EXACT same rules after
// a WAAFI-confirmed payment, instead of a second, drift-prone copy.
// Caller owns the transaction (BEGIN/COMMIT/ROLLBACK) and audit logging.
async function recordPaymentCore(client, user, { invoiceId, amt, cur, method, referenceCode, channel = null }) {
  // Lock the invoice FIRST — deterministic lock order across every
  // Module 6 route (OD-7 / non-negotiable rule #7), so two concurrent
  // payment attempts against the same invoice can never both read a
  // stale outstanding balance.
  const invRes = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
  if (invRes.rows.length === 0) throw new PaymentError(404, 'NOT_FOUND', 'Invoice not found.');
  const invoice = invRes.rows[0];
  if (invoice.status === 'voided') throw new PaymentError(409, 'CONFLICT', 'Cannot record a payment against a voided invoice.');

  // FOR SHARE (lock order invoice -> customer): serialises with a debt
  // suspension approval (lib/debtSuspension.js locks the customer FOR UPDATE),
  // so an approval never misses a payment committing at the same moment.
  const custRes = await client.query('SELECT zone_id FROM customers WHERE id = $1 FOR SHARE', [invoice.customer_id]);
  const myZoneId = await resolveUserZoneId(user);
  if (myZoneId !== null && custRes.rows[0]?.zone_id !== myZoneId) {
    throw new PaymentError(403, 'FORBIDDEN', 'You do not have access to this invoice.');
  }

  let exchangeRateId = null;
  let amountUsd = amt;
  if (cur === 'SLSH') {
    const rate = await getCurrentExchangeRate(client);
    if (!rate) throw new PaymentError(409, 'NO_EXCHANGE_RATE', 'No exchange rate is configured — cannot record a SLSH payment.');
    exchangeRateId = rate.id;
    amountUsd = amt / parseFloat(rate.rate);
  }

  // Outstanding balance computed INSIDE the lock, in the INVOICE'S OWN
  // currency, using the same paidInInvoiceCurrency logic
  // recalculateInvoiceStatus itself uses — never a second, independently-
  // derived copy. For USD invoices this is the historical amount_usd sum.
  const invCur = invoice.currency === 'SLSH' ? 'SLSH' : 'USD';
  const netTotal = parseFloat(invoice.invoice_total) - parseFloat(invoice.discount_amount);
  const currentRate = invCur === 'SLSH' ? await getCurrentExchangeRate(client) : null;
  const alreadyPaid = await paidInInvoiceCurrency(invoiceId, invCur, client, { rate: currentRate });
  const outstanding = netTotal - alreadyPaid;

  // This payment's size in the invoice's currency (frozen on the row).
  const sized = sizePayment({ invCur, cur, amt, amountUsd, outstanding, rate: currentRate });
  if (sized.error) {
    const e = sized.error;
    throw new PaymentError(e.status, e.code, e.message ||
      `Payment amount exceeds outstanding balance. Outstanding: ${fmtMoney(invCur, e.outstanding)}. Attempted: ${fmtMoney(invCur, e.attempted)}.`);
  }

  const inserted = await client.query(
    `INSERT INTO payments (invoice_id, amount, currency, method, amount_usd, exchange_rate_id, cashier_id, reference_code, status, amount_invoice_currency, conversion_rate_id, channel)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'recorded',$9,$10,$11) RETURNING *`,
    [invoiceId, amt, cur, method, amountUsd, exchangeRateId, user.id ?? null, referenceCode || null, sized.aic, sized.conversionRateId, channel]
  );
  const payment = inserted.rows[0];

  const recalculated = await recalculateInvoiceStatus(invoiceId, client);

  // Auto-track the remaining balance as a Debt — user-reported gap
  // ('qaabkeebu partial iyo debt ba u diiwaan galin karaa'). Two
  // scenarios, one rule: (a) a normal partial payment leaves a real
  // remaining balance the Debts module never reflected; (b) a payment
  // recorded with method='debt' means no actual cash changed hands —
  // recalculateInvoiceStatus (frozen, Module 6) still counts it toward
  // "paid" for invoice-closing purposes (an invoice resolved into a
  // formal receivable is the existing precedent — see cashout
  // shortages' own comment on Debts being that mechanism), so a
  // SEPARATE local sum here excludes method='debt' payments to get the
  // TRUE amount still actually owed, regardless of what the invoice's
  // own status says. One auto-tracked debt row per invoice
  // (source='auto_invoice', distinct from manually-created ones) is
  // kept in sync: created/updated while something is still owed,
  // auto-settled the moment it reaches zero. Never touches a
  // manually-created debt (source='manual').
  const trueOutstanding = netTotal - await paidInInvoiceCurrency(invoiceId, invCur, client, { excludeDebt: true, rate: currentRate });
  const existingAutoDebt = await client.query(
    `SELECT * FROM debts WHERE invoice_id = $1 AND source = 'auto_invoice' AND status = 'unpaid' LIMIT 1`,
    [invoiceId]
  );
  if (trueOutstanding > EPSILON) {
    if (existingAutoDebt.rows.length > 0) {
      await client.query(`UPDATE debts SET amount = $1, currency = $3 WHERE id = $2`, [trueOutstanding, existingAutoDebt.rows[0].id, invCur]);
    } else {
      await client.query(
        `INSERT INTO debts (customer_id, invoice_id, amount, currency, description, status, source, created_by)
         VALUES ($1,$2,$3,$6,$4,'unpaid','auto_invoice',$5)`,
        [invoice.customer_id, invoiceId, trueOutstanding, `Auto-tracked remaining balance on ${invoice.invoice_number}`, user.id ?? null, invCur]
      );
    }
  } else if (existingAutoDebt.rows.length > 0) {
    await client.query(
      `UPDATE debts SET status = 'paid', settled_at = NOW(), settled_by = $1 WHERE id = $2`,
      [user.id ?? null, existingAutoDebt.rows[0].id]
    );
  }

  return { payment, recalculated, invoice };
}

// Shared ZAAD collect flow (staff POST /zaad-request and the customer
// portal's POST /invoices/:id/pay-zaad). The caller has already validated
// input, checked access and run precheckPayment. This pushes the WAAFI
// request, then records the payment through recordPaymentCore in its own
// transaction. `actor` is { id, username, role, zone } — a staff user, or
// the portal actor { id: null, username: 'portal:<customer_number>' }.
// Returns one of:
//   { kind: 'declined', zaadResult }
//   { kind: 'ok', payment, recalculated, zaadResult }
//   { kind: 'reconciliation', zaadResult, error }  (WAAFI approved, record failed)
// Throws only on a gateway transport error.
async function runZaadCollect({ invoice, amt, cur, phoneDigits, actor, channel = null, reference = null, auditExtra = {} }) {
  const zaadResult = await zaadService.requestZaadPayment({ phone: phoneDigits, amount: amt, currency: cur, reference: reference || invoice.invoice_number });
  // A gateway timeout is an UNKNOWN outcome, not a decline.
  if (!zaadResult.ok && zaadResult.timedOut) return { kind: 'unknown', zaadResult };
  if (!zaadResult.ok) return { kind: 'declined', zaadResult };

  let recorded;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    recorded = await recordPaymentCore(client, actor, {
      invoiceId: invoice.id, amt, cur, method: 'zaad', referenceCode: zaadResult.transactionId, channel,
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // WAAFI already approved and moved the money — this is not a normal
    // failure path. Logged distinctly so it surfaces in the Audit Center.
    await logAudit({
      actorId: actor.id ?? null, actorUsername: actor.username, action: 'payment.zaad_reconciliation_required',
      entityType: 'invoice', entityId: invoice.id,
      before: null,
      after: { ...auditExtra, invoice_id: invoice.id, amount: amt, currency: cur, channel, zaad_transaction_id: zaadResult.transactionId, zaad_raw: zaadResult.raw, reason: err.message },
    }).catch(() => {});
    return { kind: 'reconciliation', zaadResult, error: err };
  } finally {
    client.release();
  }
  const { payment, recalculated } = recorded;
  await debtSuspension.afterPayment(invoice.customer_id);
  await logAudit({ actorId: actor.id ?? null, actorUsername: actor.username, action: 'payment.create', entityType: 'payment', entityId: payment.id, before: null, after: { ...payment, ...auditExtra, zaad_raw: zaadResult.raw } })
    .catch((e) => console.error('payment.create audit failed:', e && e.message));
  return { kind: 'ok', payment, recalculated, zaadResult };
}

const reconciliationMessage = (txId, reason) =>
  `ZAAD approved this payment (transaction ${txId}) but it could not be recorded against the invoice: ${reason}. The money has already been received into the merchant account — record it manually with reference code ${txId} once resolved.`;

// ---------------------------------------------------------------------
// Transactions listing (finance redesign) — READ-ONLY views over the
// payments ledger: GET /transactions (filtered + paginated),
// GET /transactions/summary (today / this month / filtered aggregates)
// and GET /transactions.csv. Nothing here writes or recomputes a balance.
//
// Scope (same roles as GET / above):
//  - admin: every payment.
//  - gudoomiye / zone_accountant: payments on customers in their zone
//    (resolveUserZoneId — identical rule to GET /).
//  - cashier: only payments they recorded themselves (cashier_id = me),
//    additionally zone-bound like every other cashier read. Portal ZAAD
//    payments (cashier_id NULL) are therefore never in a cashier's list,
//    matching how cashout math already treats them.
// "Received" totals exclude method='debt' rows (no money changed hands)
// and reversed rows.
// ---------------------------------------------------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (d) => DATE_RE.test(String(d)) && !isNaN(new Date(d + 'T00:00:00Z').getTime()) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
const TX_METHODS = ['cash', 'zaad', 'edahab', 'slsh', 'debt'];
// payments.created_at is a naive TIMESTAMP written by CURRENT_TIMESTAMP, i.e.
// in the DB session's timezone (UTC in production, EAT on some dev hosts).
// Both expressions below go through the session timezone, so they are right
// whatever it is.
const LOCAL_TS = `(p.created_at::timestamptz AT TIME ZONE $1)`;
// Sargable date bounds: local (company-timezone) midnight of a YYYY-MM-DD
// parameter, as a naive timestamp comparable with payments.created_at, so
// filters hit idx_payments_created_at.
const localMidnight = (expr) => `((((${expr})::date)::timestamp AT TIME ZONE $1)::timestamp)`;
const ZONE_SCOPED_TX_ROLES = ['gudoomiye', 'zone_accountant'];
const TX_CSV_MAX_ROWS = 20000;

async function txScope(user, params, where) {
  const myZoneId = await resolveUserZoneId(user);
  // Fail closed (new endpoints only): a zone-scoped role whose zone is
  // missing or unresolvable sees nothing, never everything.
  if (myZoneId === null && ZONE_SCOPED_TX_ROLES.includes((user.role || '').toLowerCase())) where.push('FALSE');
  if (myZoneId !== null) { params.push(myZoneId); where.push(`c.zone_id = $${params.length}`); }
  if ((user.role || '').toLowerCase() === 'cashier') {
    params.push(user.id ?? -1);
    where.push(`p.cashier_id = $${params.length}`);
  }
}

// Builds the WHERE clause for the transactions endpoints. $1 is always the
// company timezone (used by LOCAL_TS). Returns { error } on bad input.
async function buildTxQuery(req, { withFilters = true } = {}) {
  const tz = await autoBilling.getTimezone();
  const params = [tz];
  // Always reference $1 (pg rejects a bound parameter the SQL never uses).
  const where = [`$1::text <> ''`];
  await txScope(req.user, params, where);
  if (!withFilters) return { tz, params, where };
  const q = req.query;
  if (q.date_from) {
    if (!validDate(q.date_from)) return { error: 'date_from must be YYYY-MM-DD.' };
    params.push(q.date_from); where.push(`p.created_at >= ${localMidnight(`$${params.length}`)}`);
  }
  if (q.date_to) {
    if (!validDate(q.date_to)) return { error: 'date_to must be YYYY-MM-DD.' };
    params.push(q.date_to); where.push(`p.created_at < ${localMidnight(`$${params.length}::date + 1`)}`);
  }
  if (q.method) {
    if (!TX_METHODS.includes(q.method)) return { error: `method must be one of: ${TX_METHODS.join(', ')}.` };
    params.push(q.method); where.push(`p.method = $${params.length}`);
  }
  if (q.currency) {
    const cur = String(q.currency).toUpperCase();
    if (!['USD', 'SLSH'].includes(cur)) return { error: 'currency must be USD or SLSH.' };
    params.push(cur); where.push(`p.currency = $${params.length}`);
  }
  if (q.channel) {
    if (q.channel === 'portal') where.push(`p.channel = 'portal_zaad'`);
    else if (q.channel === 'staff') where.push(`p.channel IS NULL`);
    else return { error: 'channel must be staff or portal.' };
  }
  if (q.status) {
    if (!['recorded', 'reversed'].includes(q.status)) return { error: 'status must be recorded or reversed.' };
    params.push(q.status); where.push(`p.status = $${params.length}`);
  }
  if (q.q) {
    const s = String(q.q).trim();
    if (s.length >= 2) {
      params.push(`%${s}%`);
      const i = params.length;
      where.push(`(i.invoice_number ILIKE $${i} OR c.name ILIKE $${i} OR c.customer_number ILIKE $${i} OR i.customer_number_snapshot ILIKE $${i} OR p.reference_code ILIKE $${i})`);
    }
  }
  return { tz, params, where };
}

const TX_FROM = `FROM payments p
  JOIN invoices i ON i.id = p.invoice_id
  JOIN customers c ON c.id = i.customer_id
  LEFT JOIN v2_users u ON u.id = p.cashier_id`;
const TX_COLS = `p.id, p.invoice_id, p.amount, p.currency, p.method, p.amount_usd, p.status, p.reference_code, p.channel,
  p.cashier_id, p.created_at, p.reversed_at, p.reversed_reason,
  i.invoice_number, i.currency AS invoice_currency, i.customer_id,
  c.name AS customer_name, COALESCE(i.customer_number_snapshot, c.customer_number) AS customer_number,
  COALESCE(u.full_name, u.username) AS cashier_name`;
const whereSql = (where) => (where.length ? `WHERE ${where.join(' AND ')}` : '');
const badTx = (res, message) => res.status(400).json({ error: { message, code: 'VALIDATION' } });

router.get('/transactions', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const built = await buildTxQuery(req);
    if (built.error) return badTx(res, built.error);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 25));
    const w = whereSql(built.where);
    const total = (await pool.query(`SELECT COUNT(*)::int AS n ${TX_FROM} ${w}`, built.params)).rows[0].n;
    const rows = (await pool.query(
      `SELECT ${TX_COLS} ${TX_FROM} ${w} ORDER BY p.created_at DESC, p.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      built.params
    )).rows;
    res.json({ data: rows, meta: { page, page_size: pageSize, total } });
  } catch (err) {
    console.error('transactions list failed:', err && err.message);
    res.status(500).json({ error: { message: 'Failed to load transactions.', code: 'INTERNAL' } });
  }
});

// One aggregate block: received (recorded, non-debt) split by currency,
// method and channel; plus debt-marked and reversed totals for context.
async function aggregate(params, where) {
  const w = whereSql(where);
  const rows = (await pool.query(
    `SELECT p.status, p.method, p.currency, (p.channel = 'portal_zaad') AS portal,
            COUNT(*)::int AS n, COALESCE(SUM(p.amount), 0) AS amount, COALESCE(SUM(p.amount_usd), 0) AS usd
     ${TX_FROM} ${w} GROUP BY 1, 2, 3, 4`, params)).rows;
  const out = {
    count: 0, total_usd: 0, by_currency: { USD: 0, SLSH: 0 },
    by_method: { cash: 0, zaad: 0, edahab: 0, slsh: 0 }, by_channel: { staff: 0, portal: 0 },
    debt_usd: 0, reversed_usd: 0, reversed_count: 0,
  };
  for (const r of rows) {
    const usd = parseFloat(r.usd);
    if (r.status === 'reversed') { out.reversed_usd += usd; out.reversed_count += r.n; continue; }
    if (r.method === 'debt') { out.debt_usd += usd; continue; }
    out.count += r.n;
    out.total_usd += usd;
    out.by_currency[r.currency === 'SLSH' ? 'SLSH' : 'USD'] += parseFloat(r.amount);
    out.by_method[r.method] = (out.by_method[r.method] || 0) + usd;
    out.by_channel[r.portal ? 'portal' : 'staff'] += usd;
  }
  return out;
}

router.get('/transactions/summary', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const built = await buildTxQuery(req);
    if (built.error) return badTx(res, built.error);
    const base = await buildTxQuery(req, { withFilters: false });
    const today = autoBilling.localParts(new Date(), base.tz);
    const todayP = [...base.params, today.date];
    const monthP = [...base.params, today.period];
    const [t, m, f] = await Promise.all([
      aggregate(todayP, [...base.where, `p.created_at >= ${localMidnight(`$${todayP.length}`)}`, `p.created_at < ${localMidnight(`$${todayP.length}::date + 1`)}`]),
      aggregate(monthP, [...base.where, `p.created_at >= ${localMidnight(`$${monthP.length} || '-01'`)}`, `p.created_at < ${localMidnight(`($${monthP.length} || '-01')::date + interval '1 month'`)}`]),
      aggregate(built.params, built.where),
    ]);
    res.json({ data: { today: t, month: m, filtered: f, date: today.date, period: today.period, timezone: base.tz } });
  } catch (err) {
    console.error('transactions summary failed:', err && err.message);
    res.status(500).json({ error: { message: 'Failed to load transactions summary.', code: 'INTERNAL' } });
  }
});

router.get('/transactions.csv', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const built = await buildTxQuery(req);
    if (built.error) return badTx(res, built.error);
    const rows = (await pool.query(
      `SELECT ${TX_COLS}, to_char(${LOCAL_TS}, 'YYYY-MM-DD HH24:MI') AS local_time
       ${TX_FROM} ${whereSql(built.where)} ORDER BY p.created_at DESC, p.id DESC LIMIT ${TX_CSV_MAX_ROWS + 1}`, built.params)).rows;
    // Never hand out a silently truncated export: over the cap -> 413.
    if (rows.length > TX_CSV_MAX_ROWS) {
      return res.status(413).json({ error: { message: `More than ${TX_CSV_MAX_ROWS.toLocaleString('en-US')} transactions match — narrow the date range or filters and export again.`, code: 'TOO_MANY_ROWS' } });
    }
    const columns = [
      { key: 'local_time', label: 'Date' }, { key: 'invoice_number', label: 'Invoice' },
      { key: 'customer_number', label: 'Customer #' }, { key: 'customer_name', label: 'Customer' },
      { key: 'method', label: 'Method' }, { key: 'reference_code', label: 'Reference / ZAAD transaction' },
      { key: 'channel_label', label: 'Channel' }, { key: 'amount', label: 'Amount' }, { key: 'currency', label: 'Currency' },
      { key: 'amount_usd_fmt', label: 'USD value' }, { key: 'recorded_by', label: 'Recorded by' }, { key: 'status', label: 'Status' },
      { key: 'reversed_reason', label: 'Reversal reason' },
    ];
    const csv = toCsv(rows.map((r) => ({
      ...r,
      channel_label: r.channel === 'portal_zaad' ? 'Customer portal' : 'Staff',
      amount_usd_fmt: parseFloat(r.amount_usd).toFixed(2),
      recorded_by: r.channel === 'portal_zaad' ? 'Customer portal (ZAAD)' : (r.cashier_name || (r.cashier_id ? `#${r.cashier_id}` : '')),
    })), columns);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + csv);
  } catch (err) {
    console.error('transactions export failed:', err && err.message);
    res.status(500).json({ error: { message: 'Failed to export transactions.', code: 'INTERNAL' } });
  }
});

// GET /?invoice_id=X — payment history for one invoice.
router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const invoiceId = parseStrictId(req.query.invoice_id || '');
  if (invoiceId === null) return res.status(400).json({ error: { message: 'invoice_id is required.', code: 'VALIDATION' } });
  try {
    const invRes = await pool.query('SELECT customer_id FROM invoices WHERE id = $1', [invoiceId]);
    if (invRes.rows.length === 0) return res.status(404).json({ error: { message: 'Invoice not found.', code: 'NOT_FOUND' } });
    const custRes = await pool.query('SELECT zone_id FROM customers WHERE id = $1', [invRes.rows[0].customer_id]);
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && custRes.rows[0]?.zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this invoice.', code: 'FORBIDDEN' } });
    }
    const result = await pool.query('SELECT * FROM payments WHERE invoice_id = $1 ORDER BY created_at ASC', [invoiceId]);
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load payments.', code: 'INTERNAL' } });
  }
});

// POST / — record a payment (manual entry — cash/zaad/edahab/slsh/debt,
// no gateway call). See recordPaymentCore() above for every rule.
router.post('/', authenticateToken, requireRole(...RECORD_ROLES), async (req, res) => {
  const { invoice_id, amount, currency, method, reference_code } = req.body;
  const invoiceId = parseStrictId(String(invoice_id ?? ''));
  if (invoiceId === null) return res.status(400).json({ error: { message: 'invoice_id is required.', code: 'VALIDATION' } });
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: { message: 'amount must be a positive number.', code: 'VALIDATION' } });
  const cur = (currency || 'USD').toUpperCase();
  if (!['USD', 'SLSH'].includes(cur)) return res.status(400).json({ error: { message: 'currency must be USD or SLSH.', code: 'VALIDATION' } });
  if (!VALID_METHODS.includes(method)) return res.status(400).json({ error: { message: `method must be one of: ${VALID_METHODS.join(', ')}.`, code: 'VALIDATION' } });
  const precision = amountPrecisionError(amt, cur);
  if (precision) return res.status(400).json({ error: { message: precision, code: 'VALIDATION' } });
  const ref = reference_code === undefined || reference_code === null ? '' : String(reference_code).trim();
  if (ref.length > 50) return res.status(400).json({ error: { message: 'reference_code can be at most 50 characters.', code: 'VALIDATION' } });
  // A manually recorded ZAAD payment must carry the ZAAD transaction code.
  if (method === 'zaad' && !ref) return res.status(400).json({ error: { message: 'reference_code (the ZAAD transaction code) is required for a ZAAD payment.', code: 'VALIDATION' } });
  // Cashout V2: an eDahab payment carries its eDahab transaction code too —
  // the Head of Cashiers confirms it against the merchant statement.
  if (method === 'edahab' && !ref) return res.status(400).json({ error: { message: 'reference_code (the eDahab transaction code) is required for an eDahab payment.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { payment, recalculated, invoice } = await recordPaymentCore(client, req.user, { invoiceId, amt, cur, method, referenceCode: ref || null });
    await client.query('COMMIT');
    // F3: a debt-suspended customer whose balance is now cleared is reactivated (best-effort, never fails the payment).
    await debtSuspension.afterPayment(invoice.customer_id);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'payment.create', entityType: 'payment', entityId: payment.id, before: null, after: payment });
    res.status(201).json({ data: { ...payment, invoice_status: recalculated.status, outstanding: recalculated.outstanding, outstanding_currency: recalculated.currency } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err instanceof PaymentError) return res.status(err.status).json({ error: { message: err.message, code: err.code } });
    if (err && err.code === '23505') return res.status(409).json({ error: { message: `A ${method === 'edahab' ? 'eDahab' : 'ZAAD'} payment with this transaction code is already recorded.`, code: 'DUPLICATE_REFERENCE' } });
    res.status(500).json({ error: { message: 'Failed to record payment.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// POST /zaad-request — user-requested (Phase 10): 'customerka
// numberkiisa galiyo si loogu diro' — push a real ZAAD payment request
// to the customer's own phone via the WAAFI gateway (ported from the
// user's previous system's own working integration — see
// lib/zaadService.js's header comment). WAAFI's API_PURCHASE call is
// synchronous: this HTTP request does not return until the customer has
// approved (funds already moved into ZAAD_MERCHANT_UID) or the request
// has been declined/timed out — there is no separate webhook/poll step.
//
// Financial-safety design: the outstanding-balance check happens twice.
// A read-only PRE-check here avoids ever bothering WAAFI (and the
// customer's phone) with a request that would overpay the invoice. The
// real, row-locked check inside recordPaymentCore() is what actually
// protects against a concurrent payment racing in during the WAAFI
// round-trip (a DB lock is deliberately NOT held across that external
// HTTP call — that would block on WAAFI's latency, not just this
// process's own work).
//
// If WAAFI approves but recordPaymentCore() then rejects (the race just
// described, however rare), the money has ALREADY left the customer's
// wallet into the merchant account — this is surfaced as a distinct,
// loud 409 with a reconciliation code and a dedicated audit log entry
// carrying the WAAFI transaction id, never silently swallowed as a
// generic 500. A human must record that payment manually (via POST /
// with method=zaad and the given reference code) once the invoice's
// current state is reviewed.
//
// Per-invoice guard (finance redesign fix round), shared with the customer
// portal through lib/zaadAttempts.js: one pending attempt per invoice across
// BOTH flows (in-process lock + partial unique index), 409 ZAAD_IN_PROGRESS
// while one is pending, 409 PAYMENT_UNCONFIRMED for 15 minutes after an
// unknown outcome or a reconciliation-required one, a per-attempt WAAFI
// reference (<invoice_number>-A<attemptId>), and every unknown outcome is
// audited + notified to admins.
router.post('/zaad-request', authenticateToken, requireRole(...RECORD_ROLES), async (req, res) => {
  const { invoice_id, phone, amount, currency } = req.body;
  const invoiceId = parseStrictId(String(invoice_id ?? ''));
  if (invoiceId === null) return res.status(400).json({ error: { message: 'invoice_id is required.', code: 'VALIDATION' } });
  const phoneDigits = String(phone || '').replace(/\D/g, '');
  if (phoneDigits.length < 7 || phoneDigits.length > 15) return res.status(400).json({ error: { message: 'A valid phone number is required.', code: 'VALIDATION' } });
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: { message: 'amount must be a positive number.', code: 'VALIDATION' } });
  const cur = (currency || 'USD').toUpperCase();
  if (!['USD', 'SLSH'].includes(cur)) return res.status(400).json({ error: { message: 'currency must be USD or SLSH.', code: 'VALIDATION' } });
  const precision = amountPrecisionError(amt, cur);
  if (precision) return res.status(400).json({ error: { message: precision, code: 'VALIDATION' } });

  let attemptId = null;
  let locked = false;
  try {
    // Read-only pre-check — not the authoritative guard, just avoids pinging
    // WAAFI/the customer for a request certain to be rejected anyway.
    const invRes = await pool.query('SELECT * FROM invoices WHERE id = $1', [invoiceId]);
    if (invRes.rows.length === 0) return res.status(404).json({ error: { message: 'Invoice not found.', code: 'NOT_FOUND' } });
    const invoice = invRes.rows[0];
    if (invoice.status === 'voided') return res.status(409).json({ error: { message: 'Cannot record a payment against a voided invoice.', code: 'CONFLICT' } });
    const custRes = await pool.query('SELECT zone_id, customer_number FROM customers WHERE id = $1', [invoice.customer_id]);
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && custRes.rows[0]?.zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this invoice.', code: 'FORBIDDEN' } });
    }
    const blocked = await precheckPayment(pool, invoice, { amt, cur });
    if (blocked) return res.status(blocked.status).json({ error: { message: blocked.message, code: blocked.code } });

    if (zaadAttempts.ZAAD_INFLIGHT.has(invoiceId)) return zaadInProgress(res);
    zaadAttempts.ZAAD_INFLIGHT.add(invoiceId);
    locked = true;

    await zaadAttempts.sweepStaleZaadAttempts();
    const recent = await pool.query(
      `SELECT 1 FROM portal_zaad_attempts WHERE invoice_id = $1 AND status IN ('unknown', 'reconciliation_required')
         AND COALESCE(finished_at, created_at) > NOW() - make_interval(mins => $2) LIMIT 1`,
      [invoiceId, zaadAttempts.ZAAD_UNKNOWN_BLOCK_MIN]
    );
    if (recent.rows.length) {
      return res.status(409).json({ error: { code: 'PAYMENT_UNCONFIRMED', message: `A recent ZAAD payment on this invoice could not be confirmed. Do not send another request: an admin must check the merchant account first (blocked for ${zaadAttempts.ZAAD_UNKNOWN_BLOCK_MIN} minutes).` } });
    }

    let reference;
    try {
      const ins = await pool.query(
        `INSERT INTO portal_zaad_attempts (customer_id, invoice_id, amount, currency, phone, source, staff_user_id)
         VALUES ($1,$2,$3,$4,$5,'staff',$6) RETURNING id`,
        [invoice.customer_id, invoiceId, amt, cur, phoneDigits, req.user.id ?? null]
      );
      attemptId = ins.rows[0].id;
      reference = `${invoice.invoice_number}-A${attemptId}`;
      await pool.query('UPDATE portal_zaad_attempts SET reference = $2 WHERE id = $1', [attemptId, reference]);
    } catch (e) {
      if (e.code === '23505') return zaadInProgress(res);
      throw e;
    }
    const attemptRow = {
      id: attemptId, invoice_id: invoiceId, amount: amt, currency: cur, phone: phoneDigits, reference, source: 'staff',
      staff_user_id: req.user.id, staff_username: req.user.username, invoice_number: invoice.invoice_number, customer_number: custRes.rows[0]?.customer_number,
    };
    const auditExtra = { target_phone: phoneDigits, attempt_id: attemptId, reference };

    let r;
    try {
      r = await runZaadCollect({ invoice, amt, cur, phoneDigits, actor: req.user, reference, auditExtra });
    } catch (e) {
      // Transport error: the request may already have reached WAAFI.
      await zaadAttempts.finishZaadAttempt(attemptId, 'unknown', { errorCode: 'GATEWAY_ERROR' });
      await zaadAttempts.flagUnknownAttempt(attemptRow, 'gateway transport error');
      return res.status(502).json({ error: { message: 'Could not reach ZAAD to process this payment request. The outcome is unknown: do not send another request; an admin must check the merchant account.', code: 'GATEWAY_ERROR' } });
    }
    if (r.kind === 'unknown') {
      await zaadAttempts.finishZaadAttempt(attemptId, 'unknown', { errorCode: 'UNKNOWN' });
      await zaadAttempts.flagUnknownAttempt(attemptRow, 'gateway timeout - outcome unknown');
      return res.status(504).json({ error: { message: 'ZAAD did not answer in time, so the outcome is unknown. Check the merchant account before requesting again.', code: 'ZAAD_UNKNOWN' } });
    }
    if (r.kind === 'declined') {
      const code = r.zaadResult.notConfigured ? 'NOT_CONFIGURED' : 'ZAAD_DECLINED';
      await zaadAttempts.finishZaadAttempt(attemptId, 'failed', { errorCode: code });
      return res.status(402).json({ error: { message: r.zaadResult.message, code } });
    }
    if (r.kind === 'reconciliation') {
      const txId = r.zaadResult.transactionId;
      await zaadAttempts.finishZaadAttempt(attemptId, 'reconciliation_required', { transactionId: txId, errorCode: 'RECONCILIATION_REQUIRED' });
      await zaadAttempts.notifyAdmins({
        invoiceId,
        title: `ZAAD payment needs reconciliation — ${invoice.invoice_number}`,
        body: `Cashier ${req.user.username} collected ${zaadAttempts.fmtAmt(amt, cur)} via ZAAD (transaction ${txId}, attempt ${attemptId}, phone ${phoneDigits}) on invoice ${invoice.invoice_number}, but it could not be recorded: ${r.error.message}. Review the invoice and record it manually with reference code ${txId}.`,
      });
      return res.status(409).json({ error: { message: reconciliationMessage(txId, r.error.message), code: 'RECONCILIATION_REQUIRED', transaction_id: txId } });
    }
    const { payment, recalculated } = r;
    await zaadAttempts.finishZaadAttempt(attemptId, 'ok', { transactionId: r.zaadResult.transactionId, paymentId: payment.id });
    res.status(201).json({ data: { ...payment, invoice_status: recalculated.status, outstanding: recalculated.outstanding, outstanding_currency: recalculated.currency, attempt_reference: reference } });
  } catch (err) {
    console.error('zaad-request failed:', err && err.message);
    if (attemptId) {
      // Unexpected failure after the attempt row exists: never assume nothing
      // happened at the gateway — treat as unknown so the invoice is blocked.
      await zaadAttempts.finishZaadAttempt(attemptId, 'unknown', { errorCode: 'INTERNAL' });
      await zaadAttempts.flagUnknownAttempt({ id: attemptId, invoice_id: invoiceId, amount: amt, currency: cur, phone: phoneDigits, source: 'staff', staff_user_id: req.user.id, staff_username: req.user.username, invoice_number: String(invoiceId) }, 'internal error').catch(() => {});
      return res.status(502).json({ error: { message: 'The ZAAD request failed unexpectedly. The outcome is unknown: do not send another request; an admin must check the merchant account.', code: 'GATEWAY_ERROR' } });
    }
    res.status(500).json({ error: { message: 'Failed to process the ZAAD request.', code: 'INTERNAL' } });
  } finally {
    if (locked) zaadAttempts.ZAAD_INFLIGHT.delete(invoiceId);
  }
});

const zaadInProgress = (res) => res.status(409).json({ error: { code: 'ZAAD_IN_PROGRESS', message: 'A ZAAD request for this invoice is already in progress. Wait for it to finish.' } });

// PUT /:id/reverse — Admin only. Preserves the original row; reversal is a
// status flip + required actor/reason/timestamp, never a DELETE.
router.put('/:id/reverse', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid payment id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'A reason is required to reverse a payment.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const payRes = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
    if (payRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Payment not found.', code: 'NOT_FOUND' } });
    }
    const payment = payRes.rows[0];
    if (payment.status === 'reversed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'This payment is already reversed.', code: 'CONFLICT' } });
    }
    // Lock order: invoice first, then payment — consistent across every
    // Module 6 route (§11 of the Implementation Spec) to prevent a
    // deadlock between concurrent operations on the same invoice. The
    // invoice was not yet locked above, so lock it now before writing.
    // (full row, not just id — the auto-debt sync below needs
    // customer_id/invoice_total/discount_amount/invoice_number.)
    const invLockRes = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [payment.invoice_id]);
    const lockedInvoice = invLockRes.rows[0];

    const updated = await client.query(
      `UPDATE payments SET status = 'reversed', reversed_at = NOW(), reversed_by = $1, reversed_reason = $2 WHERE id = $3 RETURNING *`,
      [req.user.id, reason, id]
    );
    const recalculated = await recalculateInvoiceStatus(payment.invoice_id, client);

    // Keep the auto-tracked debt (source='auto_invoice') in sync after a
    // reversal too — same rule as POST / above, see its own comment.
    // Without this it would only self-correct on the invoice's NEXT
    // payment, leaving it stale (understated) in the meantime.
    const netTotal = parseFloat(lockedInvoice.invoice_total) - parseFloat(lockedInvoice.discount_amount);
    const lockedCur = lockedInvoice.currency === 'SLSH' ? 'SLSH' : 'USD';
    const trueOutstanding = netTotal - await paidInInvoiceCurrency(payment.invoice_id, lockedCur, client, { excludeDebt: true });
    const existingAutoDebt = await client.query(
      `SELECT * FROM debts WHERE invoice_id = $1 AND source = 'auto_invoice' AND status = 'unpaid' LIMIT 1`,
      [payment.invoice_id]
    );
    if (trueOutstanding > EPSILON) {
      if (existingAutoDebt.rows.length > 0) {
        await client.query(`UPDATE debts SET amount = $1, currency = $3 WHERE id = $2`, [trueOutstanding, existingAutoDebt.rows[0].id, lockedCur]);
      } else {
        await client.query(
          `INSERT INTO debts (customer_id, invoice_id, amount, currency, description, status, source, created_by)
           VALUES ($1,$2,$3,$6,$4,'unpaid','auto_invoice',$5)`,
          [lockedInvoice.customer_id, payment.invoice_id, trueOutstanding, `Auto-tracked remaining balance on ${lockedInvoice.invoice_number}`, req.user.id, lockedCur]
        );
      }
    } else if (existingAutoDebt.rows.length > 0) {
      await client.query(`UPDATE debts SET status = 'paid', settled_at = NOW(), settled_by = $1 WHERE id = $2`, [req.user.id, existingAutoDebt.rows[0].id]);
    }

    // Debt-integrity check (§6 of the Implementation Spec): a reversal
    // can move an invoice from paid back to partial/unpaid. If a linked
    // debt already shows Paid, do NOT silently revert it — surface a
    // warning and log it distinctly, so a human resolves the
    // contradiction deliberately.
    let warning = null;
    const debtRes = await client.query(`SELECT * FROM debts WHERE invoice_id = $1 AND status = 'paid'`, [payment.invoice_id]);
    if (debtRes.rows.length > 0 && recalculated.status !== 'paid') {
      warning = `Linked debt #${debtRes.rows[0].id} is marked Paid but this invoice is no longer fully paid — review its settlement.`;
      await logAudit({
        actorId: req.user.id, actorUsername: req.user.username, action: 'debt.integrity_warning',
        entityType: 'debt', entityId: debtRes.rows[0].id,
        before: { invoice_id: payment.invoice_id, invoice_status: 'paid' },
        after: { invoice_id: payment.invoice_id, invoice_status: recalculated.status, triggered_by_payment_id: id },
      });
    }

    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'payment.reverse', entityType: 'payment', entityId: id, before: payment, after: updated.rows[0] });
    const response = { data: { ...updated.rows[0], invoice_status: recalculated.status, outstanding: recalculated.outstanding, outstanding_currency: recalculated.currency } };
    if (warning) response.warnings = [warning];
    res.json(response);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to reverse payment.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.precheckPayment = precheckPayment;
router.runZaadCollect = runZaadCollect;
router.reconciliationMessage = reconciliationMessage;
module.exports = router;
