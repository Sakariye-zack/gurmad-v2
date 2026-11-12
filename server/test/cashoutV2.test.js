// Cashout V2: per-currency/per-method breakdown, tolerance + escalation,
// maker-checker, overlap guard, uncovered payments, deposits, settings,
// monitor dedupe, Word document. Every test uses its own cashier account so
// periods and payments never collide with cashout.test.js or each other.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, createInvoice, insertUser, tokenFor } = require('./helpers');
const calc = require('../lib/cashoutCalculations');

const num = (x) => Number(x);
const close = (a, b, eps = 1e-6) => Math.abs(num(a) - num(b)) <= eps;
const iso = (ms) => new Date(ms).toISOString();
const rnd = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

async function mkCashier(name, zoneName) {
  const id = await insertUser(name, 'cashier', zoneName);
  return { id, token: await tokenFor(name) };
}

async function rate(w) {
  const r = await db.query('SELECT rate FROM exchange_rates WHERE effective_from <= NOW() ORDER BY effective_from DESC LIMIT 1');
  if (r.rows.length) return Number(r.rows[0].rate);
  assert.equal((await api('POST', '/exchange-rates', { token: w.tokens.admin, body: { rate: 10000 } })).status, 201);
  return 10000;
}

async function pay(cashier, customer, amount, currency, method, extra = {}) {
  const invTotal = currency === 'SLSH' ? 50 : Math.max(amount, 1) + 1;
  const inv = await createInvoice(cashier.token, customer, invTotal);
  const r = await api('POST', '/payments', { token: cashier.token, body: { invoice_id: inv.id, amount, currency, method, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}

async function preview(w, cashierId, start, end) {
  const q = `cashier_id=${cashierId}&period_start=${encodeURIComponent(start)}&period_end=${encodeURIComponent(end)}`;
  const r = await api('GET', `/cashouts/reconciliation-preview?${q}`, { token: w.tokens.head });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
}

const v2Body = (w, cashierId, start, end, cashCount, extra = {}) => ({ zone_id: w.zoneA.id, cashier_id: cashierId, period_start: start, period_end: end, cash_count: cashCount, ...extra });
const signDoc = (id, by) => db.query("INSERT INTO cashout_attachments (cashout_id, document_type, original_filename, storage_path, uploaded_by) VALUES ($1,'signed_cashout_form','s.pdf','x/s.pdf',$2)", [id, by]);
const slip = async (id, by) => (await db.query("INSERT INTO cashout_attachments (cashout_id, document_type, original_filename, storage_path, uploaded_by) VALUES ($1,'deposit_slip','d.pdf','x/d.pdf',$2) RETURNING id", [id, by])).rows[0].id;

// ---------------- pure functions ----------------

test('pure: cash count validation and totals', () => {
  const ok = calc.normalizeCashCount({ USD: { mode: 'notes', notes: { 100: 2, 5: 3 } }, SLSH: { mode: 'notes', notes: { 1000: 4 } } });
  assert.deepEqual(ok.totals, { USD: 215, SLSH: 4000 });
  assert.ok(calc.normalizeCashCount({ USD: { mode: 'notes', notes: { 3: 1 } } }).error, 'not a denomination');
  assert.ok(calc.normalizeCashCount({ USD: { mode: 'notes', notes: { 100: 1.5 } } }).error, 'fractional note count');
  assert.ok(calc.normalizeCashCount({ USD: { mode: 'manual', total: 10 } }).error, 'manual needs a remark');
  assert.ok(calc.normalizeCashCount({ SLSH: { mode: 'manual', total: 10.5, remark: 'x' } }).error, 'SLSH whole numbers');
  assert.ok(calc.normalizeCashCount({ EUR: {} }).error, 'unknown currency');
  assert.deepEqual(calc.normalizeCashCount({}).totals, { USD: 0, SLSH: 0 }, 'missing currencies count as zero');
  assert.equal(calc.normalizeCashCount({ USD: { mode: 'manual', total: 12.34, remark: 'coins' } }).totals.USD, 12.34);
  assert.deepEqual(calc.DENOMINATIONS.USD, [100, 50, 20, 10, 5, 1]);
  assert.deepEqual(calc.DENOMINATIONS.SLSH, [50000, 20000, 10000, 5000, 1000, 500]);
});

test('pure: breakdown buckets methods per currency, electronic is auto-verified, debt is apart', () => {
  const exp = calc.foldExpected([
    { method: 'cash', currency: 'USD', amount: '10', amount_usd: '10', n: 2 },
    { method: 'slsh', currency: 'SLSH', amount: '20000', amount_usd: '2', n: 1 },
    { method: 'cash', currency: 'SLSH', amount: '10000', amount_usd: '1', n: 1 },
    { method: 'zaad', currency: 'USD', amount: '3', amount_usd: '3', n: 1 },
    { method: 'edahab', currency: 'SLSH', amount: '5000', amount_usd: '0.5', n: 1 },
    { method: 'debt', currency: 'USD', amount: '4', amount_usd: '4', n: 1 },
  ]);
  assert.equal(exp.lines.SLSH.cash.expected, 30000, "legacy 'slsh' method is SLSH cash");
  assert.equal(exp.debt.usd, 4);
  // exact count -> no difference, legacy columns sum to expected incl. debt
  const exact = calc.buildBreakdown({ ...exp, expectedAmount: 20.5 }, { cashTotals: { USD: 10, SLSH: 30000 }, rate: 10000 });
  assert.equal(exact.breakdown.currencies.USD.zaad.actual, 3);
  assert.equal(exact.breakdown.currencies.USD.zaad.auto_verified, true);
  assert.equal(exact.breakdown.currencies.SLSH.cash.diff, 0);
  assert.ok(close(exact.legacy.actual_amount, 20.5), JSON.stringify(exact.legacy));
  assert.ok(close(exact.legacy.cash_amount + exact.legacy.zaad_amount + exact.legacy.edahab_amount + exact.legacy.slsh_amount, 16.5));
  // short 10000 SLSH at 10000/USD -> $1 gross cash shortage
  const short = calc.buildBreakdown({ ...exp, expectedAmount: 20.5 }, { cashTotals: { USD: 10, SLSH: 20000 }, rate: 10000 });
  assert.equal(short.breakdown.currencies.SLSH.cash.diff, -10000);
  assert.ok(close(short.breakdown.gross_cash_shortage_usd, 1));
  assert.ok(close(short.legacy.actual_amount, 19.5));
  // a SLSH difference with no rate cannot be valued
  assert.equal(calc.buildBreakdown(exp, { cashTotals: { USD: 10, SLSH: 1 }, rate: null }).error.code, 'NO_EXCHANGE_RATE');
  // legacy mode: expected only
  const legacy = calc.buildBreakdown(exp);
  assert.equal(legacy.breakdown.mode, 'legacy');
  assert.equal(legacy.breakdown.currencies.USD.cash.actual, null);
  assert.equal(legacy.legacy, null);
});

test('pure: variance classification (tolerance, reason, admin threshold, currency swap)', () => {
  const controls = { tolerance_usd: 1, admin_threshold_usd: 10 };
  let v = calc.classifyVariance({ expectedAmount: 10, actualAmount: 9.5, controls });
  assert.deepEqual([v.status, v.reasonRequired, v.needsAdmin], ['balanced', false, false]);
  assert.ok(close(v.shortage, 0.5));
  v = calc.classifyVariance({ expectedAmount: 10, actualAmount: 8, controls });
  assert.deepEqual([v.status, v.reasonRequired, v.needsAdmin], ['shortage', true, false]);
  v = calc.classifyVariance({ expectedAmount: 30, actualAmount: 15, controls });
  assert.equal(v.needsAdmin, true);
  v = calc.classifyVariance({ expectedAmount: 10, actualAmount: 15, controls });
  assert.deepEqual([v.status, v.shortage, v.reasonRequired], ['surplus', 0, false]);
  // net balanced but USD short $5 hidden behind a SLSH overage -> still a shortage
  v = calc.classifyVariance({ expectedAmount: 10, actualAmount: 10, grossCashShortageUsd: 5, controls });
  assert.deepEqual([v.status, v.reasonRequired, v.shortage], ['shortage', true, 0]);
});

test('pure: deposit status', () => {
  const req = { USD: 20, SLSH: 10000 };
  assert.equal(calc.computeDepositStatus(req, []), 'not_deposited');
  assert.equal(calc.computeDepositStatus({ USD: 0, SLSH: 0 }, []), 'not_required');
  assert.equal(calc.computeDepositStatus(req, [{ currency: 'USD', amount: 20 }]), 'partial');
  assert.equal(calc.computeDepositStatus(req, [{ currency: 'USD', amount: 20 }, { currency: 'SLSH', amount: 10000 }]), 'deposited');
  assert.equal(calc.computeDepositStatus(req, [{ currency: 'USD', amount: 20, verified_at: 'x' }, { currency: 'SLSH', amount: 10000, verified_at: 'x' }]), 'verified');
  assert.equal(calc.computeDepositStatus(req, [{ currency: 'USD', amount: 25 }]), 'variance');
  assert.equal(calc.computeDepositStatus(req, [{ currency: 'USD', amount: 25, voided_at: 'x' }]), 'not_deposited', 'voided deposits ignored');
});

test('pure: monitor alert planning dedupes per item per day', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const pending = [
    { id: 1, cashout_number: 'CO-1', created_at: '2026-11-11T08:00:00Z' }, // 28 h
    { id: 2, cashout_number: 'CO-2', created_at: '2026-11-12T01:00:00Z' }, // 11 h
  ];
  const uncovered = [
    { cashier_id: 7, cashier_name: 'A', oldest_at: '2026-11-09T12:00:00Z', payment_count: 3 }, // 3 days
    { cashier_id: 8, cashier_name: 'B', oldest_at: '2026-11-11T12:00:00Z', payment_count: 1 }, // 1 day
  ];
  const first = calc.planCashoutAlerts({ pending, uncovered, now, today: '2026-11-12' });
  assert.deepEqual(first.map((a) => a.key).sort(), ['pending_overdue:1:2026-11-12', 'uncovered_stale:7:2026-11-12']);
  const again = calc.planCashoutAlerts({ pending, uncovered, now, today: '2026-11-12', sentKeys: new Set(first.map((a) => a.key)) });
  assert.equal(again.length, 0, 'same day: nothing re-sent');
  const nextDay = calc.planCashoutAlerts({ pending, uncovered, now: new Date('2026-11-13T12:00:00Z'), today: '2026-11-13', sentKeys: new Set(first.map((a) => a.key)) });
  assert.ok(nextDay.length >= 2, 'a new day may remind again');
});

// ---------------- API ----------------

test('breakdown: per currency/method, ZAAD matched by transaction code, legacy columns unchanged', async () => {
  const w = await setupWorld();
  const r = await rate(w);
  const c = await mkCashier('t_co2_brk', w.zoneA.name);
  const start = iso(Date.now() - 60 * 1000);
  const slshAmt = Math.round(2 * r);
  const zref = `ZTX${rnd()}`;
  const eref = `EDH${rnd()}`;
  await pay(c, w.custA, 5, 'USD', 'cash');
  await pay(c, w.custA, slshAmt, 'SLSH', 'cash');
  await pay(c, w.custA, 3, 'USD', 'zaad', { reference_code: zref });
  await pay(c, w.custA, 1, 'USD', 'edahab', { reference_code: eref });
  await pay(c, w.custA, 2, 'USD', 'debt');
  const end = iso(Date.now() + 30 * 1000);

  const p = await preview(w, c.id, start, end);
  const b = p.breakdown;
  assert.equal(b.currencies.USD.cash.expected, 5);
  assert.equal(b.currencies.SLSH.cash.expected, slshAmt);
  assert.equal(b.currencies.USD.zaad.expected, 3);
  assert.equal(b.currencies.USD.edahab.expected, 1);
  assert.equal(b.debt.USD, 2);
  assert.ok(p.electronic.some((e) => e.reference_code === zref && e.method === 'zaad'), 'ZAAD payment listed with its transaction code');
  assert.ok(p.electronic.some((e) => e.reference_code === eref && e.method === 'edahab'));
  const sumUsd = calc.CURRENCIES.reduce((s, cur) => s + calc.METHODS.reduce((t, m) => t + b.currencies[cur][m].expected_usd, 0), 0) + b.debt.usd;
  assert.ok(close(sumUsd, p.expectedAmount, 1e-5), `buckets ${sumUsd} vs legacy ${p.expectedAmount}`);

  const bad = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, { USD: { mode: 'notes', notes: { 5: 1 } }, SLSH: { mode: 'manual', total: slshAmt } }) });
  assert.equal(bad.status, 400, 'manual total needs a remark');

  const created = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, { USD: { mode: 'notes', notes: { 5: 1 } }, SLSH: { mode: 'manual', total: slshAmt, remark: 'bundle counted by hand' } }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const co = created.data;
  assert.equal(num(co.expected_amount), p.expectedAmount, 'expected_amount = legacy computation');
  assert.equal(num(co.shortage), 0, 'debt-marked payment is not a cashier shortage');
  assert.equal(num(co.surplus), 0);
  assert.ok(close(co.actual_amount, co.expected_amount, 1e-5));
  assert.ok(close(num(co.cash_amount), 5));
  assert.ok(close(num(co.zaad_amount), 3));
  assert.ok(close(num(co.edahab_amount), 1));
  assert.ok(close(num(co.slsh_amount), b.currencies.SLSH.cash.expected_usd));
  assert.equal(co.variance_status, 'balanced');
  assert.equal(co.needs_admin, false);
  assert.equal(co.breakdown.mode, 'counted');
  assert.equal(co.count_detail.USD.notes['5'], 1);
  assert.equal(co.count_detail.SLSH.mode, 'manual');

  const detail = await api('GET', `/cashouts/${co.id}`, { token: w.tokens.head });
  assert.equal(detail.status, 200);
  assert.ok(detail.data.electronic.some((e) => e.reference_code === zref));
  assert.ok(detail.data.timeline.some((t) => t.action === 'cashout.create'));
  assert.equal(detail.data.deposit_status, null, 'no deposit status before approval');
  const tx = await api('GET', `/cashouts/${co.id}/transactions`, { token: w.tokens.head });
  assert.ok(tx.data.some((x) => x.reference_code === zref), 'transactions carry reference codes');

  // Word document renders (zip container) with the V2 sections
  const res = await fetch(`${process.env.TEST_BASE}/api/v2/cashouts/${co.id}/document.docx`, { headers: { Authorization: 'Bearer ' + w.tokens.head } });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString(), 'PK');
});

test('legacy request body still works and stores an expected-only breakdown', async () => {
  const w = await setupWorld();
  const c = await mkCashier('t_co2_legacy', w.zoneA.name);
  const start = iso(Date.now() - 60 * 1000);
  await pay(c, w.custA, 7, 'USD', 'cash');
  const end = iso(Date.now() + 30 * 1000);
  const p = await preview(w, c.id, start, end);
  const r = await api('POST', '/cashouts', { token: w.tokens.head, body: { zone_id: w.zoneA.id, cashier_id: c.id, period_start: start, period_end: end, actual_amount: 7, cash_amount: 7, zaad_amount: 0, edahab_amount: 0, slsh_amount: 0 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(num(r.data.expected_amount), p.expectedAmount);
  assert.equal(r.data.breakdown.mode, 'legacy');
  assert.equal(r.data.breakdown.currencies.USD.cash.expected, 7);
  assert.equal(r.data.count_detail, null);
  const both = await api('POST', '/cashouts', { token: w.tokens.head, body: { ...v2Body(w, c.id, iso(Date.now() - 3600e3), iso(Date.now() - 3000e3), {}), actual_amount: 0 } });
  assert.equal(both.status, 400, 'cash_count and legacy fields together are rejected');
});

test('tolerance: within -> balanced without reason; above -> reason required; overlap guard ignores voided/rejected', async () => {
  const w = await setupWorld();
  const c = await mkCashier('t_co2_tol', w.zoneA.name);
  const start = iso(Date.now() - 60 * 1000);
  await pay(c, w.custA, 10, 'USD', 'cash');
  const end = iso(Date.now() + 30 * 1000);

  const within = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, { USD: { mode: 'manual', total: 9.5, remark: 'coins short' } }) });
  assert.equal(within.status, 201, JSON.stringify(within.body));
  assert.equal(within.data.variance_status, 'balanced');
  assert.ok(close(within.data.shortage, 0.5), 'legacy shortage still recorded exactly');
  const rec = await db.query('SELECT reason FROM cashout_shortages WHERE cashout_id = $1', [within.data.id]);
  assert.match(rec.rows[0].reason, /tolerance/i, 'shortage record kept with a system reason');

  const dup = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, { USD: { mode: 'notes', notes: { 10: 1 } } }) });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'PERIOD_OVERLAP', 'pending blocks the period');

  assert.equal((await api('PUT', `/cashouts/${within.data.id}/void`, { token: w.tokens.admin, body: { reason: 'recount' } })).status, 200);
  const noReason = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, { USD: { mode: 'notes', notes: { 5: 1, 1: 3 } } }) });
  assert.equal(noReason.status, 400, '$2 shortage > $1 tolerance needs a reason');
  const withReason = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, { USD: { mode: 'notes', notes: { 5: 1, 1: 3 } } }, { shortage_reason: 'cashier gave wrong change' }) });
  assert.equal(withReason.status, 201, 'voided cashout no longer blocks the period');
  assert.equal(withReason.data.variance_status, 'shortage');
  assert.equal(withReason.data.needs_admin, false);

  assert.equal((await api('PUT', `/cashouts/${withReason.data.id}/reject`, { token: w.tokens.gudoomiye, body: { reason: 'recount please' } })).status, 200);
  const redo = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, { USD: { mode: 'notes', notes: { 10: 1 } } }) });
  assert.equal(redo.status, 201, 'rejected cashout no longer blocks the period');
  assert.equal(num(redo.data.shortage), 0);
});

test('escalation: shortage above the admin threshold needs an admin; head and gudoomiye get NEEDS_ADMIN_APPROVAL; admins notified', async () => {
  const w = await setupWorld();
  const c = await mkCashier('t_co2_esc', w.zoneA.name);
  const start = iso(Date.now() - 60 * 1000);
  await pay(c, w.custA, 50, 'USD', 'cash');
  const end = iso(Date.now() + 30 * 1000);
  const r = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, { USD: { mode: 'notes', notes: { 20: 1, 10: 1 } } }, { shortage_reason: 'missing $20' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.data.needs_admin, true);
  assert.ok(close(r.data.control_shortage_usd, 20));
  const id = r.data.id;
  await signDoc(id, w.ids.t_head);
  const head = await api('PUT', `/cashouts/${id}/approve`, { token: w.tokens.head, body: {} });
  assert.equal(head.status, 403);
  assert.equal(head.body.error.code, 'NEEDS_ADMIN_APPROVAL');
  const gud = await api('PUT', `/cashouts/${id}/approve`, { token: w.tokens.gudoomiye, body: {} });
  assert.equal(gud.status, 403);
  assert.equal(gud.body.error.code, 'NEEDS_ADMIN_APPROVAL');
  const n = await db.query(`SELECT COUNT(*)::int AS n FROM v2_staff_notifications WHERE event_type = 'cashout.needs_admin' AND entity_id = $1`, [id]);
  assert.ok(n.rows[0].n >= 1, 'admins notified');
  assert.equal((await api('PUT', `/cashouts/${id}/approve`, { token: w.tokens.admin, body: {} })).status, 200);
  const list = await api('GET', '/cashouts?needs_admin=1', { token: w.tokens.admin });
  assert.ok(list.data.some((x) => x.id === id));
});

test('maker-checker: the cashier and the preparer can never approve or reject', async () => {
  const w = await setupWorld();
  const gudId = (await db.query(`SELECT id FROM v2_users WHERE username = 't_gudoomiye'`)).rows[0].id;
  const start = iso(Date.now() - 3600e3), end = iso(Date.now());
  // a cashout whose "cashier" is the gudoomiye account itself
  const r = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, gudId, start, end, {}) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await signDoc(r.data.id, w.ids.t_head);
  assert.equal((await api('PUT', `/cashouts/${r.data.id}/approve`, { token: w.tokens.gudoomiye, body: {} })).status, 403, 'cashier cannot approve own cashout');
  assert.equal((await api('PUT', `/cashouts/${r.data.id}/reject`, { token: w.tokens.gudoomiye, body: { reason: 'x' } })).status, 403);
  // preparer (admin as creator) cannot approve
  const c = await mkCashier('t_co2_mc', w.zoneA.name);
  const r2 = await api('POST', '/cashouts', { token: w.tokens.admin, body: v2Body(w, c.id, start, end, {}) });
  assert.equal(r2.status, 201);
  await signDoc(r2.data.id, w.ids.t_head);
  assert.equal((await api('PUT', `/cashouts/${r2.data.id}/approve`, { token: w.tokens.admin, body: {} })).status, 403);
  assert.equal((await api('PUT', `/cashouts/${r2.data.id}/approve`, { token: w.tokens.gudoomiye, body: {} })).status, 200, 'a different approver may');
});

test('V2 body: the period cannot end in the future', async () => {
  const w = await setupWorld();
  const c = await mkCashier('t_co2_future', w.zoneA.name);
  const r = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, iso(Date.now() - 3600e3), iso(Date.now() + 3600e3), {}) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'PERIOD_IN_FUTURE');
});

test('uncovered payments: per cashier, excludes debt/covered, zone-scoped, RBAC, stranded payments flagged', async () => {
  const w = await setupWorld();
  const r = await rate(w);
  const a = await mkCashier('t_co2_unc_a', w.zoneA.name);
  const b = await mkCashier('t_co2_unc_b', w.zoneB.name);
  const start = iso(Date.now() - 60 * 1000);
  const slshAmt = Math.round(r);
  await pay(a, w.custA, 4, 'USD', 'cash');
  await pay(a, w.custA, slshAmt, 'SLSH', 'cash');
  await pay(a, w.custA, 1, 'USD', 'debt');
  await pay(b, w.custB, 6, 'USD', 'cash');

  const head = await api('GET', '/cashouts/uncovered', { token: w.tokens.head });
  assert.equal(head.status, 200);
  const ra = head.data.find((x) => x.cashier_id === a.id);
  assert.ok(ra, 'cashier A listed');
  assert.equal(ra.payment_count, 2, 'debt-marked payment excluded');
  assert.equal(ra.amounts.USD, 4);
  assert.equal(ra.amounts.SLSH, slshAmt);
  assert.ok(ra.oldest_at);
  assert.ok(head.data.some((x) => x.cashier_id === b.id), 'head sees every district');

  const gud = await api('GET', '/cashouts/uncovered', { token: w.tokens.gudoomiye });
  assert.equal(gud.status, 200);
  assert.ok(gud.data.some((x) => x.cashier_id === a.id));
  assert.ok(!gud.data.some((x) => x.cashier_id === b.id), 'gudoomiye only sees own district');
  for (const role of ['cashier', 'collector']) assert.equal((await api('GET', '/cashouts/uncovered', { token: w.tokens[role] })).status, 403, role);

  // cover cashier A -> gone from the list
  const end = iso(Date.now() + 30 * 1000);
  const co = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, a.id, start, end, { USD: { mode: 'notes', notes: { 1: 4 } }, SLSH: { mode: 'manual', total: slshAmt, remark: 'one bundle' } }) });
  assert.equal(co.status, 201, JSON.stringify(co.body));
  const after = await api('GET', '/cashouts/uncovered', { token: w.tokens.head });
  assert.ok(!after.data.some((x) => x.cashier_id === a.id), 'covered payments disappear');

  // legacy body with a future end: a payment recorded afterwards is stranded
  const bStart = iso(Date.now() - 3600e3);
  const legacy = await api('POST', '/cashouts', { token: w.tokens.head, body: { zone_id: w.zoneB.id, cashier_id: b.id, period_start: bStart, period_end: iso(Date.now() + 2 * 3600e3), actual_amount: 6, cash_amount: 6, zaad_amount: 0, edahab_amount: 0, slsh_amount: 0 } });
  assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
  await pay(b, w.custB, 2, 'USD', 'cash');
  const s = (await api('GET', '/cashouts/uncovered', { token: w.tokens.head })).data.find((x) => x.cashier_id === b.id);
  assert.ok(s, 'payment recorded after the cashout was created is not covered by it');
  assert.equal(s.stranded_count, 1);
  assert.equal(s.payment_count, 1);
});

test('deposits: approved only, slip rules, admin-only verify (never own), variance, list filter', async () => {
  const w = await setupWorld();
  const r = await rate(w);
  const c = await mkCashier('t_co2_dep', w.zoneA.name);
  const start = iso(Date.now() - 60 * 1000);
  const slshAmt = Math.round(r);
  await pay(c, w.custA, 20, 'USD', 'cash');
  await pay(c, w.custA, slshAmt, 'SLSH', 'cash');
  const end = iso(Date.now() + 30 * 1000);
  const co = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, { USD: { mode: 'notes', notes: { 20: 1 } }, SLSH: { mode: 'manual', total: slshAmt, remark: 'bundle' } }) });
  assert.equal(co.status, 201, JSON.stringify(co.body));
  const id = co.data.id;

  assert.equal((await api('POST', '/cashouts/deposit-accounts', { token: w.tokens.head, body: { name: 'x', type: 'safe' } })).status, 403, 'only admin manages accounts');
  assert.equal((await api('POST', '/cashouts/deposit-accounts', { token: w.tokens.admin, body: { name: 'x', type: 'vault' } })).status, 400);
  const safe = await api('POST', '/cashouts/deposit-accounts', { token: w.tokens.admin, body: { name: `Main safe ${rnd()}`, type: 'safe' } });
  const bank = await api('POST', '/cashouts/deposit-accounts', { token: w.tokens.admin, body: { name: `Dahabshiil ${rnd()}`, type: 'bank', account_ref: '123' } });
  assert.equal(safe.status, 201); assert.equal(bank.status, 201);
  assert.equal((await api('POST', '/cashouts/deposit-accounts', { token: w.tokens.admin, body: { name: safe.data.name.toUpperCase(), type: 'safe' } })).status, 409, 'names are unique');

  const early = await api('POST', `/cashouts/${id}/deposits`, { token: w.tokens.head, body: { deposit_account_id: safe.data.id, currency: 'USD', amount: 20 } });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'NOT_APPROVED');

  await signDoc(id, w.ids.t_head);
  assert.equal((await api('PUT', `/cashouts/${id}/approve`, { token: w.tokens.gudoomiye, body: {} })).status, 200);
  let d = await api('GET', `/cashouts/${id}`, { token: w.tokens.head });
  assert.equal(d.data.deposit_status, 'not_deposited');
  assert.deepEqual([d.data.deposit_required.USD, d.data.deposit_required.SLSH], [20, slshAmt]);

  const noSlip = await api('POST', `/cashouts/${id}/deposits`, { token: w.tokens.head, body: { deposit_account_id: bank.data.id, currency: 'USD', amount: 10 } });
  assert.equal(noSlip.status, 400);
  assert.equal(noSlip.body.error.code, 'SLIP_REQUIRED');
  assert.equal((await api('POST', `/cashouts/${id}/deposits`, { token: w.tokens.gudoomiye, body: { deposit_account_id: safe.data.id, currency: 'USD', amount: 10 } })).status, 403, 'gudoomiye cannot record deposits');
  assert.equal((await api('POST', `/cashouts/${id}/deposits`, { token: w.tokens.head, body: { deposit_account_id: safe.data.id, currency: 'SLSH', amount: 1.5 } })).status, 400, 'SLSH whole numbers');

  const d1 = await api('POST', `/cashouts/${id}/deposits`, { token: w.tokens.head, body: { deposit_account_id: safe.data.id, currency: 'USD', amount: 10 } });
  assert.equal(d1.status, 201, JSON.stringify(d1.body));
  d = await api('GET', `/cashouts/${id}`, { token: w.tokens.head });
  assert.equal(d.data.deposit_status, 'partial');
  const slipId = await slip(id, w.ids.t_head);
  const d2 = await api('POST', `/cashouts/${id}/deposits`, { token: w.tokens.head, body: { deposit_account_id: bank.data.id, currency: 'USD', amount: 10, attachment_id: slipId, note: 'bank run' } });
  assert.equal(d2.status, 201, JSON.stringify(d2.body));
  const d3 = await api('POST', `/cashouts/${id}/deposits`, { token: w.tokens.head, body: { deposit_account_id: safe.data.id, currency: 'SLSH', amount: slshAmt } });
  assert.equal(d3.status, 201);
  d = await api('GET', `/cashouts/${id}`, { token: w.tokens.head });
  assert.equal(d.data.deposit_status, 'deposited');

  assert.equal((await api('PUT', `/cashouts/${id}/deposits/${d1.data.id}/verify`, { token: w.tokens.head, body: {} })).status, 403, 'only admin verifies');
  for (const dep of [d1, d2, d3]) assert.equal((await api('PUT', `/cashouts/${id}/deposits/${dep.data.id}/verify`, { token: w.tokens.admin, body: {} })).status, 200);
  d = await api('GET', `/cashouts/${id}`, { token: w.tokens.head });
  assert.equal(d.data.deposit_status, 'verified');
  assert.equal((await api('PUT', `/cashouts/${id}/deposits/${d1.data.id}/void`, { token: w.tokens.admin, body: { reason: 'x' } })).status, 409, 'verified deposit cannot be voided');
  assert.ok(d.data.timeline.some((t) => t.action === 'cashout.deposit_verify'), 'timeline shows deposit actions');
  const filtered = await api('GET', '/cashouts?deposit_status=verified', { token: w.tokens.head });
  assert.ok(filtered.data.some((x) => x.id === id));
  assert.equal((await api('GET', '/cashouts?deposit_status=bogus', { token: w.tokens.head })).status, 400);

  // over-deposit -> variance; admin recording then verifying own deposit -> 403; void works with reason
  const c2 = await mkCashier('t_co2_dep2', w.zoneA.name);
  const s2 = iso(Date.now() - 60 * 1000);
  await pay(c2, w.custA, 5, 'USD', 'cash');
  const co2 = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c2.id, s2, iso(Date.now() + 30 * 1000), { USD: { mode: 'notes', notes: { 5: 1 } } }) });
  await signDoc(co2.data.id, w.ids.t_head);
  assert.equal((await api('PUT', `/cashouts/${co2.data.id}/approve`, { token: w.tokens.gudoomiye, body: {} })).status, 200);
  const over = await api('POST', `/cashouts/${co2.data.id}/deposits`, { token: w.tokens.admin, body: { deposit_account_id: safe.data.id, currency: 'USD', amount: 6 } });
  assert.equal(over.status, 201);
  assert.equal((await api('GET', `/cashouts/${co2.data.id}`, { token: w.tokens.head })).data.deposit_status, 'variance');
  assert.equal((await api('PUT', `/cashouts/${co2.data.id}/deposits/${over.data.id}/verify`, { token: w.tokens.admin, body: {} })).status, 403, 'never verify your own deposit');
  assert.equal((await api('PUT', `/cashouts/${co2.data.id}/deposits/${over.data.id}/void`, { token: w.tokens.admin, body: {} })).status, 400, 'void needs a reason');
  assert.equal((await api('PUT', `/cashouts/${co2.data.id}/deposits/${over.data.id}/void`, { token: w.tokens.admin, body: { reason: 'typo' } })).status, 200);
  assert.equal((await api('GET', `/cashouts/${co2.data.id}`, { token: w.tokens.head })).data.deposit_status, 'not_deposited');

  // inactive account cannot be used
  assert.equal((await api('PUT', `/cashouts/deposit-accounts/${safe.data.id}`, { token: w.tokens.admin, body: { active: false } })).status, 200);
  assert.equal((await api('POST', `/cashouts/${co2.data.id}/deposits`, { token: w.tokens.head, body: { deposit_account_id: safe.data.id, currency: 'USD', amount: 5 } })).status, 400);
});

test('settings: cashout tolerance / threshold validation (admin only, tolerance <= threshold)', async () => {
  const w = await setupWorld();
  const put = (body, token = w.tokens.admin) => api('PUT', '/settings/company', { token, body });
  assert.equal((await put({ cashout_tolerance_usd: 2 }, w.tokens.head)).status, 403);
  assert.equal((await put({ cashout_tolerance_usd: -1 })).status, 400);
  assert.equal((await put({ cashout_tolerance_usd: '1' })).status, 400);
  assert.equal((await put({ cashout_tolerance_usd: 1.234 })).status, 400);
  assert.equal((await put({ cashout_tolerance_usd: 20, cashout_admin_threshold_usd: 10 })).status, 400);
  const ok = await put({ cashout_tolerance_usd: 2, cashout_admin_threshold_usd: 5 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.data.cashout_tolerance_usd, ok.data.cashout_admin_threshold_usd], [2, 5]);
  assert.equal((await put({ cashout_tolerance_usd: 6 })).status, 400, 'checked against the saved threshold');
  const meta = await api('GET', '/cashouts/meta', { token: w.tokens.head });
  assert.equal(meta.status, 200);
  assert.deepEqual(meta.data.controls, { tolerance_usd: 2, admin_threshold_usd: 5 });
  assert.deepEqual(meta.data.denominations.USD, [100, 50, 20, 10, 5, 1]);
  assert.equal((await put({ cashout_tolerance_usd: 1, cashout_admin_threshold_usd: 10 })).status, 200);
});

test('summary and list filters respond with the V2 fields', async () => {
  const w = await setupWorld();
  const s = await api('GET', '/cashouts/summary', { token: w.tokens.head });
  assert.equal(s.status, 200);
  for (const k of ['pending', 'needs_admin', 'with_shortage', 'not_deposited']) assert.equal(typeof s.data[k], 'number', k);
  assert.equal(typeof s.data.received_this_month.USD, 'number');
  assert.equal((await api('GET', '/cashouts/summary', { token: w.tokens.cashier })).status, 403);
  const l = await api('GET', `/cashouts?zone_id=${w.zoneA.id}&date_from=2020-01-01&date_to=2099-12-31`, { token: w.tokens.head });
  assert.equal(l.status, 200);
  assert.ok(l.data.every((x) => x.zone_id === w.zoneA.id));
  assert.equal((await api('GET', '/cashouts?date_from=nope', { token: w.tokens.head })).status, 400);
});

test('monitor: overdue pending cashout alerts once per day', async () => {
  const w = await setupWorld();
  const { checkOnce } = require('../lib/cashoutMonitor');
  const c = await mkCashier('t_co2_mon', w.zoneA.name);
  const r = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, iso(Date.now() - 3600e3), iso(Date.now()), {}) });
  assert.equal(r.status, 201);
  await db.query(`UPDATE cashouts SET created_at = NOW() - INTERVAL '30 hours' WHERE id = $1`, [r.data.id]);
  await checkOnce();
  const n1 = await db.query(`SELECT COUNT(*)::int AS n FROM v2_staff_notifications WHERE event_type = 'cashout.pending_overdue' AND entity_id = $1`, [r.data.id]);
  assert.ok(n1.rows[0].n >= 1, 'heads/admins notified');
  const second = await checkOnce();
  assert.equal(second.sent, 0, 'second hourly run sends nothing new');
  const n2 = await db.query(`SELECT COUNT(*)::int AS n FROM v2_staff_notifications WHERE event_type = 'cashout.pending_overdue' AND entity_id = $1`, [r.data.id]);
  assert.equal(n2.rows[0].n, n1.rows[0].n);
});
