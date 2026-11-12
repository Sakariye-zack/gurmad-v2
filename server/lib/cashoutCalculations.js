const { pool } = require('../db');

// Module 7 — Cashout & Cash Reconciliation. Mirrors financialCalculations.js's
// role: every reconciliation figure has exactly one authoritative computation,
// never duplicated in a route handler or the frontend. Reads Module 6's
// `payments`/`invoices` tables READ-ONLY — no write, no schema change beyond
// the one approved debts.cashout_id column (see db.js's Module 7 comment).

const EPSILON = 0.005;

// The server-authoritative "what was actually collected" figure for a
// cashier over a period — computed from real recorded payments, never
// trusted from client input. This is what "Cashout must reconcile against
// actual existing payment/collection data" means concretely.
// `asOf` (optional): when set, only payments recorded BEFORE this instant
// are considered, in addition to falling inside [periodStart, periodEnd).
// This is what makes a cashout's own reconciliation figures a true,
// unchanging historical snapshot — without it, a payment recorded AFTER
// the cashout was created but whose own timestamp happens to fall inside
// an already-closed period would silently leak into every later view of
// that cashout's document, drifting from the actual_amount that was
// physically reconciled at the time. Callers computing a NEW cashout pass
// no asOf (asOf = now, implicitly, via the live query); callers re-
// displaying an EXISTING cashout pass its own created_at.
async function computeExpectedForPeriod(cashierId, periodStart, periodEnd, client = pool, asOf = null) {
  const asOfClause = asOf ? ' AND created_at < $4' : '';
  const params = asOf ? [cashierId, periodStart, periodEnd, asOf] : [cashierId, periodStart, periodEnd];

  const totalRes = await client.query(
    `SELECT COALESCE(SUM(amount_usd), 0) AS total, COUNT(*)::int AS transaction_count
     FROM payments
     WHERE cashier_id = $1 AND status = 'recorded' AND created_at >= $2 AND created_at < $3${asOfClause}`,
    params
  );
  const customersRes = await client.query(
    `SELECT COUNT(DISTINCT i.customer_id)::int AS customer_count
     FROM payments p JOIN invoices i ON p.invoice_id = i.id
     WHERE p.cashier_id = $1 AND p.status = 'recorded' AND p.created_at >= $2 AND p.created_at < $3${asOfClause.replace(/created_at/g, 'p.created_at')}`,
    params
  );
  const methodRes = await client.query(
    `SELECT method, COALESCE(SUM(amount_usd), 0) AS total
     FROM payments
     WHERE cashier_id = $1 AND status = 'recorded' AND created_at >= $2 AND created_at < $3${asOfClause}
     GROUP BY method`,
    params
  );
  // Collection-source breakdown (residential/commercial) — only where a real
  // ID link exists (invoices.batch_customer_id -> batch_customers -> batches
  // .customer_type, Module 5's own real classification, read-only). No
  // category invented beyond what Module 5 already defines; unlinked
  // invoices (walk-ins, no collection event) bucket as 'unlinked', not a
  // silently-dropped or made-up category.
  const sourceRes = await client.query(
    `SELECT COALESCE(b.customer_type, 'unlinked') AS source, COALESCE(SUM(p.amount_usd), 0) AS total
     FROM payments p
     JOIN invoices i ON p.invoice_id = i.id
     LEFT JOIN batch_customers bc ON i.batch_customer_id = bc.id
     LEFT JOIN batches b ON bc.batch_id = b.id
     WHERE p.cashier_id = $1 AND p.status = 'recorded' AND p.created_at >= $2 AND p.created_at < $3${asOfClause.replace(/created_at/g, 'p.created_at')}
     GROUP BY COALESCE(b.customer_type, 'unlinked')`,
    params
  );
  return {
    expectedAmount: parseFloat(totalRes.rows[0].total),
    transactionCount: totalRes.rows[0].transaction_count,
    customerCount: customersRes.rows[0].customer_count,
    methodBreakdown: methodRes.rows.map((r) => ({ method: r.method, total: parseFloat(r.total) })),
    sourceBreakdown: sourceRes.rows.map((r) => ({ source: r.source, total: parseFloat(r.total) })),
  };
}

// Double-counting guard: no two live cashouts for the same cashier may cover
// overlapping time. "Live" = pending or approved: a voided cashout never
// counted, and a rejected one was sent back, so its period must be
// re-doable (Cashout V2). Enforced here (application-level, read+check
// inside the caller's own locked transaction), not by a payments-table
// column, per the explicit "only debts.cashout_id" scope boundary.
async function hasOverlappingCashout(cashierId, periodStart, periodEnd, client, excludeCashoutId = null) {
  const params = [cashierId, periodStart, periodEnd];
  let sql = `SELECT id FROM cashouts WHERE cashier_id = $1 AND status NOT IN ('voided', 'rejected') AND period_start < $3 AND period_end > $2`;
  if (excludeCashoutId) { params.push(excludeCashoutId); sql += ` AND id != $${params.length}`; }
  const r = await client.query(sql, params);
  return r.rows.length > 0;
}

// ============================================================
// Cashout V2 — per-currency / per-method reconciliation, tolerance and
// escalation, denomination counts, deposits. Everything below is pure or
// read-only; the legacy USD-equivalent figures above stay the single
// authoritative computation for expected_amount and are never re-derived
// differently here.
// ============================================================

const CURRENCIES = ['USD', 'SLSH'];
const METHODS = ['cash', 'zaad', 'edahab'];
const ELECTRONIC_METHODS = ['zaad', 'edahab'];
// Per-currency "equal" tolerance for float noise (USD has cents, SLSH none).
const CURRENCY_EPS = { USD: 0.005, SLSH: 0.5 };
// THE one place the cash-count denominations live. The client reads them
// from GET /cashouts/meta, so there is no second copy to drift.
const DENOMINATIONS = Object.freeze({
  USD: Object.freeze([100, 50, 20, 10, 5, 1]),
  SLSH: Object.freeze([50000, 20000, 10000, 5000, 1000, 500]),
});
const DEFAULT_CONTROLS = Object.freeze({ tolerance_usd: 1, admin_threshold_usd: 10 });
const MAX_NOTE_COUNT = 1000000;

const round = (n, dp) => Number(Number(n).toFixed(dp));
const curOf = (c) => (c === 'SLSH' ? 'SLSH' : 'USD');

// Payment method -> reconciliation bucket. 'slsh' is the legacy "cash in
// shillings" method: it is physical cash, bucketed by the payment's own
// currency. 'debt' moves an invoice into a receivable — no money changed
// hands — so it never lands in a cash/electronic bucket (reported apart).
function bucketForMethod(method) {
  if (method === 'zaad' || method === 'edahab') return method;
  if (method === 'cash' || method === 'slsh') return 'cash';
  return null;
}

async function getCashoutControls(client = pool) {
  const r = await client.query('SELECT cashout_tolerance_usd, cashout_admin_threshold_usd FROM company_settings WHERE id = 1');
  const row = r.rows[0];
  const tol = row ? Number(row.cashout_tolerance_usd) : DEFAULT_CONTROLS.tolerance_usd;
  const thr = row ? Number(row.cashout_admin_threshold_usd) : DEFAULT_CONTROLS.admin_threshold_usd;
  return {
    tolerance_usd: Number.isFinite(tol) && tol >= 0 ? tol : DEFAULT_CONTROLS.tolerance_usd,
    admin_threshold_usd: Number.isFinite(thr) && thr >= 0 ? thr : DEFAULT_CONTROLS.admin_threshold_usd,
  };
}

async function getCurrentRate(client = pool) {
  const r = await client.query('SELECT rate FROM exchange_rates WHERE effective_from <= NOW() ORDER BY effective_from DESC LIMIT 1');
  return r.rows[0] ? Number(r.rows[0].rate) : null;
}

function emptyExpected() {
  const lines = {};
  for (const c of CURRENCIES) {
    lines[c] = {};
    for (const m of METHODS) lines[c][m] = { expected: 0, expected_usd: 0, count: 0 };
  }
  return { lines, debt: { USD: 0, SLSH: 0, usd: 0, count: 0 }, expectedAmount: 0, transactionCount: 0 };
}

// Folds grouped payment rows ({ method, currency, amount, amount_usd, n })
// into per-currency/per-method expected figures. Pure.
function foldExpected(rows) {
  const out = emptyExpected();
  for (const r of rows) {
    const cur = curOf(r.currency);
    const amount = Number(r.amount);
    const usd = Number(r.amount_usd);
    const n = Number(r.n);
    const bucket = bucketForMethod(r.method);
    if (!bucket) {
      out.debt[cur] += amount; out.debt.usd += usd; out.debt.count += n;
      continue;
    }
    const line = out.lines[cur][bucket];
    line.expected += amount; line.expected_usd += usd; line.count += n;
  }
  return out;
}

// One query for the whole breakdown AND the legacy total: GROUPING SETS adds
// a grand-total row computed by Postgres in exact NUMERIC — the same
// SUM(amount_usd) over the same WHERE as computeExpectedForPeriod, so the
// stored expected_amount is byte-identical to the legacy computation and
// can never disagree with the per-bucket figures (both come from one
// statement, one snapshot).
async function computeBreakdownForPeriod(cashierId, periodStart, periodEnd, client = pool, asOf = null) {
  const asOfClause = asOf ? ' AND created_at < $4' : '';
  const params = asOf ? [cashierId, periodStart, periodEnd, asOf] : [cashierId, periodStart, periodEnd];
  const r = await client.query(
    `SELECT method, currency, GROUPING(method, currency) AS g,
            COALESCE(SUM(amount), 0) AS amount, COALESCE(SUM(amount_usd), 0) AS amount_usd, COUNT(*)::int AS n
     FROM payments
     WHERE cashier_id = $1 AND status = 'recorded' AND created_at >= $2 AND created_at < $3${asOfClause}
     GROUP BY GROUPING SETS ((method, currency), ())`,
    params
  );
  const groups = r.rows.filter((x) => Number(x.g) === 0);
  const total = r.rows.find((x) => Number(x.g) !== 0);
  const folded = foldExpected(groups);
  folded.expectedAmount = total ? parseFloat(total.amount_usd) : 0;
  folded.transactionCount = total ? Number(total.n) : 0;
  return folded;
}

// The electronic (auto-verified) payments behind the ZAAD/eDahab buckets,
// with their gateway transaction / reference codes.
async function listElectronicPayments(cashierId, periodStart, periodEnd, client = pool, asOf = null) {
  const asOfClause = asOf ? ' AND p.created_at < $4' : '';
  const params = asOf ? [cashierId, periodStart, periodEnd, asOf] : [cashierId, periodStart, periodEnd];
  const r = await client.query(
    `SELECT p.id, p.method, p.currency, p.amount, p.amount_usd, p.reference_code, p.created_at,
            i.invoice_number, c.name AS customer_name, COALESCE(i.customer_number_snapshot, c.customer_number) AS customer_number
     FROM payments p
     JOIN invoices i ON i.id = p.invoice_id
     JOIN customers c ON c.id = i.customer_id
     WHERE p.cashier_id = $1 AND p.status = 'recorded' AND p.method IN ('zaad', 'edahab')
       AND p.created_at >= $2 AND p.created_at < $3${asOfClause}
     ORDER BY p.created_at ASC, p.id ASC`,
    params
  );
  return r.rows.map((x) => ({ ...x, amount: Number(x.amount), amount_usd: Number(x.amount_usd) }));
}

// Validates + totals the denomination count. Input per currency:
//   { mode: 'notes', notes: { '100': 3, ... } }  or
//   { mode: 'manual', total: 123.45, remark: '...' }
// A currency left out counts as zero notes. Returns { detail, totals } or
// { error }. Pure.
function normalizeCashCount(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'cash_count must be an object with USD / SLSH entries.' };
  for (const k of Object.keys(input)) if (!CURRENCIES.includes(k)) return { error: `cash_count has an unknown currency "${k}".` };
  const detail = {};
  const totals = {};
  for (const cur of CURRENCIES) {
    const e = input[cur] ?? { mode: 'notes', notes: {} };
    if (!e || typeof e !== 'object') return { error: `cash_count.${cur} must be an object.` };
    if (e.mode === 'manual') {
      const total = Number(e.total);
      const remark = typeof e.remark === 'string' ? e.remark.trim() : '';
      if (!Number.isFinite(total) || total < 0) return { error: `cash_count.${cur}.total must be a non-negative number.` };
      if (cur === 'SLSH' && !Number.isInteger(total)) return { error: 'SLSH cash must be a whole number.' };
      if (cur === 'USD' && Math.abs(total * 100 - Math.round(total * 100)) > 1e-6) return { error: 'USD cash can have at most 2 decimals.' };
      if (!remark) return { error: `A remark is required when the ${cur} cash total is entered manually.` };
      if (remark.length > 500) return { error: 'The manual-count remark can be at most 500 characters.' };
      detail[cur] = { mode: 'manual', total: round(total, 2), remark };
      totals[cur] = round(total, 2);
      continue;
    }
    if (e.mode !== undefined && e.mode !== 'notes') return { error: `cash_count.${cur}.mode must be "notes" or "manual".` };
    const notesIn = e.notes ?? {};
    if (typeof notesIn !== 'object' || Array.isArray(notesIn)) return { error: `cash_count.${cur}.notes must be an object.` };
    const notes = {};
    let total = 0;
    for (const [k, v] of Object.entries(notesIn)) {
      const d = Number(k);
      if (!DENOMINATIONS[cur].includes(d)) return { error: `${k} is not a ${cur} denomination.` };
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > MAX_NOTE_COUNT) return { error: `The number of ${cur} ${k} notes must be a whole number from 0 to ${MAX_NOTE_COUNT}.` };
      if (n > 0) { notes[String(d)] = n; total += d * n; }
    }
    detail[cur] = { mode: 'notes', notes, total };
    totals[cur] = total;
  }
  return { detail, totals };
}

// Builds the stored breakdown from the expected figures and (optionally)
// the counted cash. Electronic buckets are auto-verified: their actual is
// the matched payments themselves, never a typed number. Without counted
// cash (legacy request body) only the expected side is recorded.
// SLSH cash difference is converted to USD at `rate` (current SLSH per USD)
// for the legacy USD-equivalent columns; an exact SLSH match needs no rate.
// Returns { breakdown, legacy } or { error: { code, message } }. Pure.
function buildBreakdown(expected, { cashTotals = null, rate = null } = {}) {
  const counted = cashTotals !== null;
  const currencies = {};
  const totals = {};
  const legacy = { cash_amount: 0, zaad_amount: 0, edahab_amount: 0, slsh_amount: 0 };
  let grossCashShortageUsd = 0;
  for (const cur of CURRENCIES) {
    currencies[cur] = {};
    let tExp = 0; let tAct = 0;
    for (const m of METHODS) {
      const e = expected.lines[cur][m];
      const line = { expected: round(e.expected, 2), expected_usd: round(e.expected_usd, 6), count: e.count, auto_verified: ELECTRONIC_METHODS.includes(m) };
      if (!counted) {
        line.actual = null; line.diff = null;
      } else if (m === 'cash') {
        const actual = cashTotals[cur] || 0;
        const diff = actual - e.expected;
        line.actual = round(actual, 2);
        line.diff = Math.abs(diff) <= CURRENCY_EPS[cur] ? 0 : round(diff, 2);
        let actualUsd;
        if (line.diff === 0) actualUsd = e.expected_usd;
        else if (cur === 'USD') actualUsd = actual;
        else {
          if (!(rate > 0)) return { error: { code: 'NO_EXCHANGE_RATE', message: 'No exchange rate is configured — cannot value the SLSH cash difference in USD.' } };
          actualUsd = actual === 0 ? 0 : Math.max(0, e.expected_usd + diff / rate);
        }
        line.actual_usd = round(actualUsd, 6);
        if (line.diff < 0) grossCashShortageUsd += cur === 'USD' ? -line.diff : (-diff / rate);
        if (cur === 'USD') legacy.cash_amount += line.actual_usd; else legacy.slsh_amount += line.actual_usd;
      } else {
        line.actual = line.expected; line.diff = 0; line.actual_usd = line.expected_usd;
        legacy[`${m}_amount`] += line.expected_usd;
      }
      currencies[cur][m] = line;
      tExp += line.expected;
      if (counted) tAct += line.actual;
    }
    totals[cur] = { expected: round(tExp, 2), actual: counted ? round(tAct, 2) : null, diff: counted ? round(tAct - tExp, 2) : null };
  }
  const breakdown = {
    version: 2,
    mode: counted ? 'counted' : 'legacy',
    rate: rate > 0 ? rate : null,
    currencies,
    totals,
    debt: { USD: round(expected.debt.USD, 2), SLSH: round(expected.debt.SLSH, 2), usd: round(expected.debt.usd, 6), count: expected.debt.count },
    gross_cash_shortage_usd: round(grossCashShortageUsd, 6),
  };
  if (!counted) return { breakdown, legacy: null };
  for (const k of Object.keys(legacy)) legacy[k] = round(legacy[k], 6);
  // expected_amount (legacy formula, unchanged) includes debt-marked
  // payments, for which no money exists. They are "accounted for", not
  // missing: actual_amount includes them, so shortage stays the money that
  // is really missing and a debt-marked payment never becomes a cashier
  // shortage. The four method columns hold money only.
  legacy.debt_amount_usd = round(expected.debt.usd, 6);
  legacy.actual_amount = round(legacy.cash_amount + legacy.zaad_amount + legacy.edahab_amount + legacy.slsh_amount + legacy.debt_amount_usd, 6);
  return { breakdown, legacy };
}

// Tolerance / escalation classification. shortage/surplus are the LEGACY
// columns, computed exactly as before (expected - actual, EPSILON). The
// control figure is the larger of that net shortage and the gross
// per-currency cash shortage, so a USD shortfall cannot hide behind a SLSH
// overage. Pure.
function classifyVariance({ expectedAmount, actualAmount, grossCashShortageUsd = 0, controls }) {
  const diff = expectedAmount - actualAmount;
  const shortage = diff > EPSILON ? diff : 0;
  const surplus = diff < -EPSILON ? -diff : 0;
  const controlShortage = Math.max(shortage, grossCashShortageUsd || 0);
  const tol = controls.tolerance_usd;
  let status = 'balanced';
  if (controlShortage > tol + 1e-9) status = 'shortage';
  else if (surplus > tol + 1e-9) status = 'surplus';
  return {
    shortage, surplus,
    controlShortage: round(controlShortage, 6),
    status,
    reasonRequired: controlShortage > tol + 1e-9,
    needsAdmin: controlShortage > controls.admin_threshold_usd + 1e-9,
  };
}

// Deposit status of an APPROVED cashout: required cash per currency vs. the
// non-void deposits. Returns one of not_required | not_deposited | partial
// | deposited | verified | variance. Pure.
function computeDepositStatus(required, deposits) {
  const live = (deposits || []).filter((d) => !d.voided_at);
  const sums = { USD: 0, SLSH: 0 };
  for (const d of live) sums[curOf(d.currency)] += Number(d.amount);
  const needsAny = CURRENCIES.some((c) => Number(required[c] || 0) > CURRENCY_EPS[c]);
  if (live.length === 0) return needsAny ? 'not_deposited' : 'not_required';
  let allMatch = true;
  for (const c of CURRENCIES) {
    const req = Number(required[c] || 0);
    if (sums[c] > req + CURRENCY_EPS[c]) return 'variance';
    if (Math.abs(sums[c] - req) > CURRENCY_EPS[c]) allMatch = false;
  }
  if (!allMatch) return 'partial';
  return live.every((d) => d.verified_at) ? 'verified' : 'deposited';
}

// Cash that must be deposited for a cashout, per currency. V2 rows use the
// counted cash; legacy rows (no per-currency count) fall back to the USD
// cash column, and say so via `legacy: true`.
function requiredDeposit(cashout) {
  const b = cashout.breakdown;
  if (b && b.mode === 'counted' && b.currencies) {
    return { USD: Number(b.currencies.USD.cash.actual || 0), SLSH: Number(b.currencies.SLSH.cash.actual || 0), legacy: false };
  }
  return { USD: round(Number(cashout.cash_amount || 0), 2), SLSH: 0, legacy: true };
}

// "Not yet cashed out": per staff member, the recorded, non-debt payments
// no live (pending/approved) cashout covers. A payment is covered only when
// it falls inside the cashout's period AND was recorded before the cashout
// was created — exactly what that cashout's frozen figures include (asOf).
// Portal ZAAD payments (cashier_id NULL) never belong to a cashier.
// `stranded_count`: uncovered payments that sit inside a live cashout's
// period (recorded after it was created) — no non-overlapping new cashout
// can reach them; that cashout must be rejected/voided and redone.
// `suggested_end`: the start of the next live cashout after the oldest
// uncovered payment, so a prefilled period never overlaps (NULL = now).
async function listUncoveredPayments({ zoneName = null, cashierId = null, client = pool } = {}) {
  const params = [];
  const where = [];
  if (zoneName !== null) { params.push(zoneName); where.push(`u.zone = $${params.length}`); }
  if (cashierId !== null) { params.push(cashierId); where.push(`p.cashier_id = $${params.length}`); }
  const r = await client.query(
    `WITH unc AS (
       SELECT p.cashier_id, p.currency, p.amount, p.amount_usd, p.created_at,
              EXISTS (SELECT 1 FROM cashouts co2 WHERE co2.cashier_id = p.cashier_id AND co2.status IN ('pending', 'approved')
                      AND p.created_at >= co2.period_start AND p.created_at < co2.period_end) AS stranded
       FROM payments p
       JOIN v2_users u ON u.id = p.cashier_id
       WHERE p.status = 'recorded' AND p.method <> 'debt' AND p.cashier_id IS NOT NULL
         ${where.length ? `AND ${where.join(' AND ')}` : ''}
         AND NOT EXISTS (
           SELECT 1 FROM cashouts co WHERE co.cashier_id = p.cashier_id AND co.status IN ('pending', 'approved')
             AND p.created_at >= co.period_start AND p.created_at < co.period_end AND p.created_at < co.created_at)
     ), agg AS (
       SELECT cashier_id, COUNT(*)::int AS payment_count,
              COALESCE(SUM(amount) FILTER (WHERE currency = 'USD'), 0) AS usd,
              COALESCE(SUM(amount) FILTER (WHERE currency = 'SLSH'), 0) AS slsh,
              COALESCE(SUM(amount_usd), 0) AS usd_equiv,
              COUNT(*) FILTER (WHERE stranded)::int AS stranded_count,
              MIN(created_at) AS oldest_at, MAX(created_at) AS newest_at
       FROM unc GROUP BY cashier_id
     )
     SELECT a.*, u.username, u.full_name, u.role, u.zone, z.id AS zone_id,
            (SELECT MIN(co.period_start) FROM cashouts co WHERE co.cashier_id = a.cashier_id
               AND co.status IN ('pending', 'approved') AND co.period_start > a.oldest_at) AS suggested_end
     FROM agg a
     JOIN v2_users u ON u.id = a.cashier_id
     LEFT JOIN zones z ON z.name = u.zone
     ORDER BY a.oldest_at ASC, a.cashier_id ASC`,
    params
  );
  return r.rows.map((x) => ({
    cashier_id: x.cashier_id, cashier_name: x.full_name || x.username, username: x.username, role: x.role,
    zone: x.zone, zone_id: x.zone_id, payment_count: x.payment_count, stranded_count: x.stranded_count,
    amounts: { USD: round(Number(x.usd), 2), SLSH: round(Number(x.slsh), 2) }, usd_equiv: round(Number(x.usd_equiv), 2),
    oldest_at: x.oldest_at, newest_at: x.newest_at, suggested_start: x.oldest_at, suggested_end: x.suggested_end,
  }));
}

// Monitor planning (pure): which alerts to send now, given the overdue
// pending cashouts, the stale uncovered cashiers and the alert keys already
// sent today. Each item alerts at most once per company-local day.
const PENDING_OVERDUE_HOURS = 24;
const UNCOVERED_STALE_DAYS = 2;
function planCashoutAlerts({ pending = [], uncovered = [], sentKeys = new Set(), now = new Date(), today }) {
  const out = [];
  const nowMs = now.getTime();
  for (const c of pending) {
    const ageH = (nowMs - new Date(c.created_at).getTime()) / 3600000;
    if (ageH <= PENDING_OVERDUE_HOURS) continue;
    const key = `pending_overdue:${c.id}:${today}`;
    if (sentKeys.has(key)) continue;
    out.push({ key, kind: 'pending_overdue', ref_id: c.id, cashout_number: c.cashout_number, hours: Math.floor(ageH) });
  }
  for (const u of uncovered) {
    const ageD = (nowMs - new Date(u.oldest_at).getTime()) / 86400000;
    if (ageD <= UNCOVERED_STALE_DAYS) continue;
    const key = `uncovered_stale:${u.cashier_id}:${today}`;
    if (sentKeys.has(key)) continue;
    out.push({ key, kind: 'uncovered_stale', ref_id: u.cashier_id, cashier_name: u.cashier_name, days: Math.floor(ageD), payment_count: u.payment_count });
  }
  return out;
}

module.exports = {
  computeExpectedForPeriod, hasOverlappingCashout, EPSILON,
  CURRENCIES, METHODS, ELECTRONIC_METHODS, CURRENCY_EPS, DENOMINATIONS, DEFAULT_CONTROLS,
  bucketForMethod, getCashoutControls, getCurrentRate, foldExpected, computeBreakdownForPeriod, listElectronicPayments,
  normalizeCashCount, buildBreakdown, classifyVariance, computeDepositStatus, requiredDeposit,
  listUncoveredPayments, planCashoutAlerts, PENDING_OVERDUE_HOURS, UNCOVERED_STALE_DAYS,
};
