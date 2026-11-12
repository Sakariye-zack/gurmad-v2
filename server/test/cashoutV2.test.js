// Cashout V2 (incl. the independent-review fix round): breakdown with
// gateway vs manually recorded electronic money, tolerance + cumulative
// escalation, maker-checker, state rules, shortage cancellation, overlap
// guard, covered payment ids, uncovered payments + cut-off, deposits,
// settings, monitor, reports, eDahab reference codes. Every test uses its
// own cashier account so periods and payments never collide.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, createInvoice, insertUser, tokenFor } = require('./helpers');
const calc = require('../lib/cashoutCalculations');

const num = (x) => Number(x);
const close = (a, b, eps = 1e-6) => Math.abs(num(a) - num(b)) <= eps;
const iso = (ms) => new Date(ms).toISOString();
const rnd = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const soon = () => iso(Date.now() + 30 * 1000);
const magicPhone = () => `069901${String(Date.now()).slice(-4)}`;

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
  const ref = (method === 'zaad' || method === 'edahab') && !extra.reference_code ? { reference_code: `${method.toUpperCase()}${rnd()}` } : {};
  const r = await api('POST', '/payments', { token: cashier.token, body: { invoice_id: inv.id, amount, currency, method, ...ref, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}
// Gateway-confirmed ZAAD (staff push through the stubbed WAAFI gateway).
async function payGateway(cashier, customer, amount) {
  const inv = await createInvoice(cashier.token, customer, amount + 1);
  const r = await api('POST', '/payments/zaad-request', { token: cashier.token, body: { invoice_id: inv.id, phone: magicPhone(), amount, currency: 'USD' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}

async function preview(w, cashierId, start, end) {
  const q = `cashier_id=${cashierId}&period_start=${encodeURIComponent(start)}&period_end=${encodeURIComponent(end)}`;
  const r = await api('GET', `/cashouts/reconciliation-preview?${q}`, { token: w.tokens.head });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
}

// Exact count + confirmations from a preview; `adjust` changes single lines.
function exact(p, adjust = {}) {
  const b = p.breakdown.currencies;
  const cash_count = {};
  const electronic_confirm = {};
  for (const cur of ['USD', 'SLSH']) {
    cash_count[cur] = { mode: 'manual', total: adjust[`${cur}.cash`] ?? b[cur].cash.expected, remark: 'counted' };
    for (const m of ['zaad', 'edahab']) {
      if (b[cur][m].manual_expected > 0 || adjust[`${cur}.${m}`] !== undefined) {
        electronic_confirm[cur] = electronic_confirm[cur] || {};
        electronic_confirm[cur][m] = { total: adjust[`${cur}.${m}`] ?? b[cur][m].manual_expected, confirmed: true };
      }
    }
  }
  return { cash_count, electronic_confirm };
}

const v2Body = (w, cashierId, start, end, counts, extra = {}) => ({ zone_id: w.zoneA.id, cashier_id: cashierId, period_start: start, period_end: end, ...counts, ...extra });
const signDoc = (id, by) => db.query("INSERT INTO cashout_attachments (cashout_id, document_type, original_filename, storage_path, uploaded_by) VALUES ($1,'signed_cashout_form','s.pdf','x/s.pdf',$2)", [id, by]);
const slip = async (id, by) => (await db.query("INSERT INTO cashout_attachments (cashout_id, document_type, original_filename, storage_path, uploaded_by) VALUES ($1,'deposit_slip','d.pdf','x/d.pdf',$2) RETURNING id", [id, by])).rows[0].id;
const usdCash = (total) => ({ cash_count: { USD: { mode: 'manual', total, remark: 'counted' } } });

// ---------------- pure functions ----------------

test('pure: cash count + electronic confirmation validation', () => {
  const ok = calc.normalizeCashCount({ USD: { mode: 'notes', notes: { 100: 2, 5: 3 } }, SLSH: { mode: 'notes', notes: { 1000: 4 } } });
  assert.deepEqual(ok.totals, { USD: 215, SLSH: 4000 });
  assert.ok(calc.normalizeCashCount({ USD: { mode: 'notes', notes: { 3: 1 } } }).error, 'not a denomination');
  assert.ok(calc.normalizeCashCount({ USD: { mode: 'manual', total: 10 } }).error, 'manual needs a remark');
  assert.ok(calc.normalizeCashCount({ USD: { mode: 'manual', total: '', remark: 'x' } }).error, 'empty manual total is an error, not 0');
  assert.ok(calc.normalizeCashCount({ SLSH: { mode: 'manual', total: 10.5, remark: 'x' } }).error, 'SLSH whole numbers');
  assert.deepEqual(calc.normalizeCashCount({}).totals, { USD: 0, SLSH: 0 });
  assert.deepEqual(calc.DENOMINATIONS.USD, [100, 50, 20, 10, 5, 1]);
  assert.deepEqual(calc.DENOMINATIONS.SLSH, [50000, 20000, 10000, 5000, 1000, 500]);
  assert.equal(calc.normalizeElectronicConfirm({ USD: { zaad: { total: 3 } } }).code, 'ELECTRONIC_CONFIRM_REQUIRED', 'must be explicitly confirmed');
  assert.ok(calc.normalizeElectronicConfirm({ USD: { cash: { total: 3, confirmed: true } } }).error, 'electronic methods only');
  assert.deepEqual(calc.normalizeElectronicConfirm({ USD: { edahab: { total: 4.5, confirmed: true } } }).totals, { USD: { edahab: 4.5 } });
});

test('pure: only gateway ZAAD is auto-verified; manual electronic needs a statement total and differences count', () => {
  const exp = calc.foldExpected([
    { method: 'cash', currency: 'USD', gw: false, amount: '10', amount_usd: '10', n: 2 },
    { method: 'zaad', currency: 'USD', gw: true, amount: '3', amount_usd: '3', n: 1 },
    { method: 'zaad', currency: 'USD', gw: false, amount: '2', amount_usd: '2', n: 1 },
    { method: 'edahab', currency: 'USD', gw: false, amount: '4', amount_usd: '4', n: 1 },
    { method: 'debt', currency: 'USD', gw: false, amount: '1', amount_usd: '1', n: 1 },
  ]);
  const e = { ...exp, expectedAmount: 20 };
  assert.equal(calc.buildBreakdown(e, { cashTotals: { USD: 10, SLSH: 0 } }).error.code, 'ELECTRONIC_CONFIRM_REQUIRED');
  const ok = calc.buildBreakdown(e, { cashTotals: { USD: 10, SLSH: 0 }, electronicTotals: { USD: { zaad: 2, edahab: 4 } } });
  const z = ok.breakdown.currencies.USD.zaad;
  assert.deepEqual([z.gateway_expected, z.manual_expected, z.actual, z.diff, z.auto_verified], [3, 2, 5, 0, false]);
  assert.ok(close(ok.legacy.actual_amount, 20), 'debt counted as accounted for');
  const short = calc.buildBreakdown(e, { cashTotals: { USD: 10, SLSH: 0 }, electronicTotals: { USD: { zaad: 2, edahab: 1 } } });
  assert.equal(short.breakdown.currencies.USD.edahab.diff, -3);
  assert.ok(close(short.breakdown.gross_shortage_usd, 3));
  assert.ok(close(short.legacy.actual_amount, 17));
  const gwOnly = calc.buildBreakdown(calc.foldExpected([{ method: 'zaad', currency: 'USD', gw: true, amount: '3', amount_usd: '3', n: 1 }]), { cashTotals: { USD: 0, SLSH: 0 } });
  assert.equal(gwOnly.breakdown.currencies.USD.zaad.auto_verified, true, 'gateway-only line needs no confirmation');
  assert.equal(calc.buildBreakdown(exp, { cashTotals: { USD: 10, SLSH: 1 }, electronicTotals: { USD: { zaad: 2, edahab: 4 } }, rate: null }).error.code, 'NO_EXCHANGE_RATE');
});

test('pure: variance — tolerance, reason, cumulative admin threshold, currency swap', () => {
  const controls = { tolerance_usd: 1, admin_threshold_usd: 10 };
  let v = calc.classifyVariance({ expectedAmount: 10, actualAmount: 9.5, controls });
  assert.deepEqual([v.status, v.reasonRequired, v.needsAdmin], ['balanced', false, false]);
  v = calc.classifyVariance({ expectedAmount: 10, actualAmount: 8, controls });
  assert.deepEqual([v.status, v.reasonRequired, v.needsAdmin], ['shortage', true, false]);
  v = calc.classifyVariance({ expectedAmount: 10, actualAmount: 4, priorUnpaidUsd: 6, controls });
  assert.deepEqual([v.needsAdmin, v.cumulativeShortage], [true, 12], 'split shortages add up');
  v = calc.classifyVariance({ expectedAmount: 10, actualAmount: 10, priorUnpaidUsd: 50, controls });
  assert.equal(v.needsAdmin, false, 'no new shortage -> no escalation of this cashout');
  v = calc.classifyVariance({ expectedAmount: 10, actualAmount: 10, grossShortageUsd: 5, controls });
  assert.deepEqual([v.status, v.reasonRequired], ['shortage', true]);
});

test('pure: deposit status and legacy required deposit', () => {
  const req = { USD: 20, SLSH: 10000 };
  assert.equal(calc.computeDepositStatus(req, []), 'not_deposited');
  assert.equal(calc.computeDepositStatus({ USD: 0, SLSH: 0 }, []), 'not_required');
  assert.equal(calc.computeDepositStatus(req, [{ currency: 'USD', amount: 20 }]), 'partial');
  assert.equal(calc.computeDepositStatus(req, [{ currency: 'USD', amount: 20 }, { currency: 'SLSH', amount: 10000 }]), 'deposited');
  assert.equal(calc.computeDepositStatus(req, [{ currency: 'USD', amount: 20, verified_at: 'x' }, { currency: 'SLSH', amount: 10000, verified_at: 'x' }]), 'verified');
  assert.equal(calc.computeDepositStatus(req, [{ currency: 'USD', amount: 25 }]), 'variance');
  const exempt = calc.requiredDeposit({ deposit_exempt: true, cash_amount: 50 });
  assert.equal(calc.computeDepositStatus(exempt, []), 'not_required', 'pre-V2 approved cashouts never count as not deposited');
  assert.deepEqual(calc.requiredDeposit({ cash_amount: 12, slsh_amount: 0 }), { USD: 12, SLSH: 0, legacy: true });
  assert.equal(calc.requiredDeposit({ cash_amount: 12, slsh_amount: 2 }, 11000).SLSH, 22000, 'legacy SLSH valued at the creation-time rate');
  assert.equal(calc.requiredDeposit({ cash_amount: 12, slsh_amount: 2 }, null).slsh_unvalued, true);
});

test('pure: monitor plan dedupes per item per day (pending, uncovered, unverified deposits)', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const pending = [{ id: 1, cashout_number: 'CO-1', created_at: '2026-11-11T08:00:00Z' }, { id: 2, cashout_number: 'CO-2', created_at: '2026-11-12T01:00:00Z' }];
  const uncovered = [{ cashier_id: 7, cashier_name: 'A', oldest_at: '2026-11-09T12:00:00Z', payment_count: 3 }, { cashier_id: 8, cashier_name: 'B', oldest_at: '2026-11-11T12:00:00Z', payment_count: 1 }];
  const deposits = [{ id: 5, cashout_id: 1, cashout_number: 'CO-1', deposited_at: '2026-11-10T12:00:00Z' }, { id: 6, cashout_id: 1, cashout_number: 'CO-1', deposited_at: '2026-11-12T10:00:00Z' }];
  const first = calc.planCashoutAlerts({ pending, uncovered, deposits, now, today: '2026-11-12' });
  assert.deepEqual(first.map((a) => a.key).sort(), ['deposit_unverified:5:2026-11-12', 'pending_overdue:1:2026-11-12', 'uncovered_stale:7:2026-11-12']);
  assert.equal(calc.planCashoutAlerts({ pending, uncovered, deposits, now, today: '2026-11-12', sentKeys: new Set(first.map((a) => a.key)) }).length, 0);
});

// ---------------- API ----------------

test('breakdown: gateway ZAAD auto-verified, manual ZAAD/eDahab need statement totals, covered ids keep detail = stored', async () => {
  const w = await setupWorld();
  const r = await rate(w);
  const c = await mkCashier('t_co2_brk', w.zoneA.name);
  const start = iso(Date.now() - 60 * 1000);
  const slshAmt = Math.round(2 * r);
  const zref = `ZTX${rnd()}`;
  const eref = `EDH${rnd()}`;
  const cashPay = await pay(c, w.custA, 5, 'USD', 'cash');
  await pay(c, w.custA, slshAmt, 'SLSH', 'cash');
  await pay(c, w.custA, 3, 'USD', 'zaad', { reference_code: zref });
  await pay(c, w.custA, 1, 'USD', 'edahab', { reference_code: eref });
  await pay(c, w.custA, 2, 'USD', 'debt');
  const gw = await payGateway(c, w.custA, 4);
  const end = soon();

  const p = await preview(w, c.id, start, end);
  const b = p.breakdown.currencies;
  assert.deepEqual([b.USD.zaad.expected, b.USD.zaad.gateway_expected, b.USD.zaad.manual_expected], [7, 4, 3]);
  assert.equal(b.USD.edahab.manual_expected, 1, 'eDahab is never auto-verified');
  assert.equal(p.breakdown.debt.USD, 2);
  assert.ok(p.electronic.some((x) => x.reference_code === gw.reference_code && x.gateway_verified === true), 'gateway payment flagged verified');
  assert.ok(p.electronic.some((x) => x.reference_code === zref && x.gateway_verified === false), 'manual ZAAD not verified');

  const noConfirm = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, { cash_count: exact(p).cash_count }) });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.error.code, 'ELECTRONIC_CONFIRM_REQUIRED');

  const created = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, exact(p)) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const co = created.data;
  assert.equal(num(co.expected_amount), p.expectedAmount, 'expected_amount = legacy computation');
  assert.equal(num(co.shortage), 0);
  assert.equal(co.covered_payment_count, 6, 'all six payments covered');
  assert.equal(co.covered_payment_ids, undefined, 'ids are not dumped in responses');
  assert.ok(close(num(co.zaad_amount), 7));

  // reversing a covered payment afterwards never changes the cashout's figures
  assert.equal((await api('PUT', `/payments/${cashPay.id}/reverse`, { token: w.tokens.admin, body: { reason: 'test' } })).status, 200);
  const detail = await api('GET', `/cashouts/${co.id}`, { token: w.tokens.head });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.reconciliation.expectedAmount, num(co.expected_amount), 'detail recomputed from covered ids');
  assert.equal(detail.data.reconciliation.transactionCount, 6);
  const tx = await api('GET', `/cashouts/${co.id}/transactions`, { token: w.tokens.head });
  assert.equal(tx.data.length, 6);
  assert.ok(tx.data.some((x) => x.id === cashPay.id && x.status === 'reversed'));

  const res = await fetch(`${process.env.TEST_BASE}/api/v2/cashouts/${co.id}/document.docx`, { headers: { Authorization: 'Bearer ' + w.tokens.head } });
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).slice(0, 2).toString(), 'PK');
});

test('electronic statement short -> counted as a shortage under the same rules', async () => {
  const w = await setupWorld();
  const c = await mkCashier('t_co2_eshort', w.zoneA.name);
  const start = iso(Date.now() - 60 * 1000);
  await pay(c, w.custA, 8, 'USD', 'edahab');
  const end = soon();
  const p = await preview(w, c.id, start, end);
  const noReason = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, exact(p, { 'USD.edahab': 5 })) });
  assert.equal(noReason.status, 400, '$3 statement shortfall > tolerance needs a reason');
  const r = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, exact(p, { 'USD.edahab': 5 }), { shortage_reason: 'not on statement' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(close(r.data.shortage, 3));
  assert.equal(r.data.variance_status, 'shortage');
});

test('eDahab payments require a unique reference code', async () => {
  const w = await setupWorld();
  const c = await mkCashier('t_co2_edref', w.zoneA.name);
  const inv = await createInvoice(c.token, w.custA, 20);
  const noRef = await api('POST', '/payments', { token: c.token, body: { invoice_id: inv.id, amount: 1, currency: 'USD', method: 'edahab' } });
  assert.equal(noRef.status, 400);
  const ref = `EDUP${rnd()}`;
  assert.equal((await api('POST', '/payments', { token: c.token, body: { invoice_id: inv.id, amount: 1, currency: 'USD', method: 'edahab', reference_code: ref } })).status, 201);
  const dup = await api('POST', '/payments', { token: c.token, body: { invoice_id: inv.id, amount: 1, currency: 'USD', method: 'edahab', reference_code: ref } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DUPLICATE_REFERENCE');
});

test('create: legacy body removed; future periods refused; cashier must be an active cashier in that district', async () => {
  const w = await setupWorld();
  const c = await mkCashier('t_co2_valid', w.zoneA.name);
  const start = iso(Date.now() - 3600e3), end = iso(Date.now());
  const legacy = await api('POST', '/cashouts', { token: w.tokens.head, body: { zone_id: w.zoneA.id, cashier_id: c.id, period_start: start, period_end: end, actual_amount: 0, cash_amount: 0, zaad_amount: 0, edahab_amount: 0, slsh_amount: 0 } });
  assert.equal(legacy.body.error.code, 'LEGACY_FORMAT_REMOVED');
  const future = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, iso(Date.now() + 3600e3), { cash_count: {} }) });
  assert.equal(future.body.error.code, 'PERIOD_IN_FUTURE');
  const gudId = (await db.query(`SELECT id FROM v2_users WHERE username = 't_gudoomiye'`)).rows[0].id;
  const notCashier = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, gudId, start, end, { cash_count: {} }) });
  assert.equal(notCashier.body.error.code, 'INVALID_CASHIER');
  const wrongZone = await api('POST', '/cashouts', { token: w.tokens.head, body: { ...v2Body(w, c.id, start, end, { cash_count: {} }), zone_id: w.zoneB.id } });
  assert.equal(wrongZone.body.error.code, 'ZONE_MISMATCH');
});

test('tolerance and overlap: within -> balanced; above -> reason; voided/rejected free the period', async () => {
  const w = await setupWorld();
  const c = await mkCashier('t_co2_tol', w.zoneA.name);
  const start = iso(Date.now() - 60 * 1000);
  await pay(c, w.custA, 10, 'USD', 'cash');
  const end = soon();
  const within = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, usdCash(9.5)) });
  assert.equal(within.status, 201, JSON.stringify(within.body));
  assert.equal(within.data.variance_status, 'balanced');
  assert.ok(close(within.data.shortage, 0.5));
  const dup = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, usdCash(10)) });
  assert.equal(dup.body.error.code, 'PERIOD_OVERLAP');
  assert.equal((await api('PUT', `/cashouts/${within.data.id}/void`, { token: w.tokens.admin, body: { reason: 'recount' } })).status, 200);
  assert.equal((await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, usdCash(8)) })).status, 400, 'reason required');
  const withReason = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, usdCash(8), { shortage_reason: 'wrong change' }) });
  assert.equal(withReason.status, 201);
  assert.equal((await api('PUT', `/cashouts/${withReason.data.id}/reject`, { token: w.tokens.gudoomiye, body: { reason: 'recount' } })).status, 200);
  assert.equal((await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, usdCash(10)) })).status, 201);
});

test('state rules: only pending can be approved/rejected; reject/void cancel the shortage; payroll refuses it', async () => {
  const w = await setupWorld();
  const c = await mkCashier('t_co2_state', w.zoneA.name);
  const start = iso(Date.now() - 60 * 1000);
  await pay(c, w.custA, 10, 'USD', 'cash');
  const end = soon();
  const co = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, usdCash(7), { shortage_reason: 'short' }) });
  assert.equal(co.status, 201);
  await signDoc(co.data.id, w.ids.t_head);
  assert.equal((await api('PUT', `/cashouts/${co.data.id}/void`, { token: w.tokens.admin, body: { reason: 'redo' } })).status, 200);
  let sh = (await db.query('SELECT id, status FROM cashout_shortages WHERE cashout_id = $1', [co.data.id])).rows[0];
  assert.equal(sh.status, 'cancelled', 'void cancels the shortage');
  const rej = await api('PUT', `/cashouts/${co.data.id}/reject`, { token: w.tokens.gudoomiye, body: { reason: 'x' } });
  assert.equal(rej.status, 409, 'a voided cashout never flips to rejected');
  assert.equal((await db.query('SELECT status FROM cashouts WHERE id = $1', [co.data.id])).rows[0].status, 'voided');
  assert.equal((await api('PUT', `/cashouts/${co.data.id}/approve`, { token: w.tokens.gudoomiye, body: {} })).status, 409, 'a voided cashout cannot be approved');
  const payroll = await api('POST', '/payroll-records/999999/items', { token: w.tokens.admin, body: { item_type: 'deduction', amount: 3, description: 'shortage', source_type: 'cashout_shortage', source_id: String(sh.id) } });
  assert.equal(payroll.status, 409);
  assert.equal(payroll.body.error.code, 'SHORTAGE_NOT_LIVE');

  const co2 = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, usdCash(7), { shortage_reason: 'short' }) });
  assert.equal(co2.status, 201);
  assert.equal((await api('PUT', `/cashouts/${co2.data.id}/reject`, { token: w.tokens.gudoomiye, body: { reason: 'recount' } })).status, 200);
  sh = (await db.query('SELECT status FROM cashout_shortages WHERE cashout_id = $1', [co2.data.id])).rows[0];
  assert.equal(sh.status, 'cancelled', 'reject cancels the shortage');
  await signDoc(co2.data.id, w.ids.t_head);
  assert.equal((await api('PUT', `/cashouts/${co2.data.id}/approve`, { token: w.tokens.admin, body: {} })).status, 409, 'a rejected cashout cannot be approved');
});

test('escalation: cumulative unresolved shortage triggers needs_admin; only an admin approves or rejects it', async () => {
  const w = await setupWorld();
  const c = await mkCashier('t_co2_esc', w.zoneA.name);
  const s1 = iso(Date.now() - 60 * 1000);
  await pay(c, w.custA, 10, 'USD', 'cash');
  const e1 = soon();
  const first = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, s1, e1, usdCash(4), { shortage_reason: 'short 6' }) });
  assert.equal(first.status, 201);
  assert.equal(first.data.needs_admin, false, '$6 alone is under the $10 threshold');
  // a second, earlier period with its own $10 cash payment
  const inv = await createInvoice(c.token, w.custA, 15);
  await db.query(`INSERT INTO payments (invoice_id, amount, currency, method, amount_usd, cashier_id, status, created_at)
                  VALUES ($1, 10, 'USD', 'cash', 10, $2, 'recorded', NOW() - INTERVAL '2 hours')`, [inv.id, c.id]);
  const second = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, iso(Date.now() - 3 * 3600e3), iso(Date.now() - 3600e3), usdCash(4), { shortage_reason: 'short 6 again' }) });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.data.needs_admin, true, '$6 + $6 unpaid > $10: splitting periods does not dodge escalation');
  const id = second.data.id;
  await signDoc(id, w.ids.t_head);
  const head = await api('PUT', `/cashouts/${id}/approve`, { token: w.tokens.head, body: {} });
  assert.equal(head.body.error.code, 'NEEDS_ADMIN_APPROVAL');
  assert.equal((await api('PUT', `/cashouts/${id}/approve`, { token: w.tokens.gudoomiye, body: {} })).body.error.code, 'NEEDS_ADMIN_APPROVAL');
  assert.equal((await api('PUT', `/cashouts/${id}/reject`, { token: w.tokens.gudoomiye, body: { reason: 'x' } })).body.error.code, 'NEEDS_ADMIN_APPROVAL', 'gudoomiye cannot reject an escalated cashout');
  const n = await db.query(`SELECT COUNT(*)::int AS n FROM v2_staff_notifications WHERE event_type = 'cashout.needs_admin' AND entity_id = $1`, [id]);
  assert.ok(n.rows[0].n >= 1, 'admins notified');
  assert.equal((await api('PUT', `/cashouts/${id}/approve`, { token: w.tokens.admin, body: {} })).status, 200);
});

test('shortage resolve: live only, never by the preparer, admin when escalated, bounded by the shortage', async () => {
  const w = await setupWorld();
  const c = await mkCashier('t_co2_res', w.zoneA.name);
  const start = iso(Date.now() - 60 * 1000);
  await pay(c, w.custA, 10, 'USD', 'cash');
  const co = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, soon(), usdCash(7), { shortage_reason: 'short' }) });
  assert.equal(co.status, 201);
  const url = `/cashouts/${co.data.id}/shortage/resolve`;
  assert.equal((await api('PUT', url, { token: w.tokens.head, body: { resolved_amount: 3, resolution_notes: 'repaid' } })).status, 403, 'preparer blocked');
  assert.equal((await api('PUT', url, { token: w.tokens.admin, body: { resolved_amount: 4, resolution_notes: 'repaid' } })).status, 400, 'cannot exceed the shortage');
  assert.equal((await api('PUT', url, { token: w.tokens.admin, body: { resolved_amount: 3, resolution_notes: 'repaid' } })).status, 200);
  // a voided cashout's shortage cannot be resolved
  const c2 = await mkCashier('t_co2_res2', w.zoneA.name);
  await pay(c2, w.custA, 10, 'USD', 'cash');
  const co2 = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c2.id, iso(Date.now() - 120 * 1000), soon(), usdCash(7), { shortage_reason: 'short' }) });
  assert.equal((await api('PUT', `/cashouts/${co2.data.id}/void`, { token: w.tokens.admin, body: { reason: 'x' } })).status, 200);
  assert.equal((await api('PUT', `/cashouts/${co2.data.id}/shortage/resolve`, { token: w.tokens.admin, body: { resolved_amount: 3, resolution_notes: 'x' } })).status, 409);
});

test('uncovered payments: cashiers only, cut-off date, covered ids, late-committing payments show as stranded', async () => {
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
  const adminInv = await createInvoice(w.tokens.admin, w.custA, 5);
  assert.equal((await api('POST', '/payments', { token: w.tokens.admin, body: { invoice_id: adminInv.id, amount: 2, currency: 'USD', method: 'cash' } })).status, 201);
  const adminId = (await db.query(`SELECT id FROM v2_users WHERE username = 't_admin'`)).rows[0].id;

  const head = await api('GET', '/cashouts/uncovered', { token: w.tokens.head });
  const ra = head.data.find((x) => x.cashier_id === a.id);
  assert.equal(ra.payment_count, 2, 'debt-marked excluded');
  assert.deepEqual(ra.amounts, { USD: 4, SLSH: slshAmt });
  assert.ok(!head.data.some((x) => x.cashier_id === adminId), 'non-cashier staff are not listed');
  const gud = await api('GET', '/cashouts/uncovered', { token: w.tokens.gudoomiye });
  assert.ok(gud.data.some((x) => x.cashier_id === a.id) && !gud.data.some((x) => x.cashier_id === b.id), 'district scoped');
  assert.equal((await api('GET', '/cashouts/uncovered', { token: w.tokens.cashier })).status, 403);

  // cut-off: moving it past these payments hides them; reset restores
  assert.equal((await api('PUT', '/settings/company', { token: w.tokens.admin, body: { cashout_v2_since: new Date().toISOString() } })).status, 200);
  assert.ok(!(await api('GET', '/cashouts/uncovered', { token: w.tokens.head })).data.some((x) => x.cashier_id === a.id), 'payments before the cut-off are ignored');
  assert.equal((await api('PUT', '/settings/company', { token: w.tokens.admin, body: { cashout_v2_since: null } })).status, 200);
  assert.equal((await api('PUT', '/settings/company', { token: w.tokens.admin, body: { cashout_v2_since: iso(Date.now() + 3600e3) } })).status, 400, 'cut-off cannot be in the future');

  const end = soon();
  const p = await preview(w, a.id, start, end);
  const co = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, a.id, start, end, exact(p)) });
  assert.equal(co.status, 201, JSON.stringify(co.body));
  assert.ok(!(await api('GET', '/cashouts/uncovered', { token: w.tokens.head })).data.some((x) => x.cashier_id === a.id), 'covered payments disappear');

  // a payment that commits late with a timestamp inside the covered period
  const inv = await createInvoice(a.token, w.custA, 5);
  await db.query(
    `INSERT INTO payments (invoice_id, amount, currency, method, amount_usd, cashier_id, status, created_at)
     VALUES ($1, 1, 'USD', 'cash', 1, $2, 'recorded', NOW() - INTERVAL '1 second')`, [inv.id, a.id]);
  const s = (await api('GET', '/cashouts/uncovered', { token: w.tokens.head })).data.find((x) => x.cashier_id === a.id);
  assert.ok(s, 'never silently lost');
  assert.equal(s.stranded_count, 1);
  const detail = await api('GET', `/cashouts/${co.data.id}`, { token: w.tokens.head });
  assert.equal(detail.data.reconciliation.expectedAmount, num(co.data.expected_amount), 'detail still equals the stored expected');
});

test('deposits: approved only, slip rules (one live deposit per slip, in-use slip cannot be removed), admin verify, variance, summary', async () => {
  const w = await setupWorld();
  const r = await rate(w);
  const c = await mkCashier('t_co2_dep', w.zoneA.name);
  const start = iso(Date.now() - 60 * 1000);
  const slshAmt = Math.round(r);
  await pay(c, w.custA, 20, 'USD', 'cash');
  await pay(c, w.custA, slshAmt, 'SLSH', 'cash');
  const end = soon();
  const p = await preview(w, c.id, start, end);
  const co = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, end, exact(p)) });
  assert.equal(co.status, 201, JSON.stringify(co.body));
  const id = co.data.id;
  assert.equal((await api('POST', '/cashouts/deposit-accounts', { token: w.tokens.head, body: { name: 'x', type: 'safe' } })).status, 403);
  const safe = await api('POST', '/cashouts/deposit-accounts', { token: w.tokens.admin, body: { name: `Main safe ${rnd()}`, type: 'safe' } });
  const bank = await api('POST', '/cashouts/deposit-accounts', { token: w.tokens.admin, body: { name: `Dahabshiil ${rnd()}`, type: 'bank', account_ref: '123' } });
  assert.equal(safe.status, 201); assert.equal(bank.status, 201);

  assert.equal((await api('POST', `/cashouts/${id}/deposits`, { token: w.tokens.head, body: { deposit_account_id: safe.data.id, currency: 'USD', amount: 20 } })).body.error.code, 'NOT_APPROVED');
  await signDoc(id, w.ids.t_head);
  assert.equal((await api('PUT', `/cashouts/${id}/approve`, { token: w.tokens.gudoomiye, body: {} })).status, 200);
  assert.equal((await api('GET', `/cashouts/${id}`, { token: w.tokens.head })).data.deposit_status, 'not_deposited');
  assert.equal((await api('POST', `/cashouts/${id}/deposits`, { token: w.tokens.head, body: { deposit_account_id: bank.data.id, currency: 'USD', amount: 10 } })).body.error.code, 'SLIP_REQUIRED');

  const slipId = await slip(id, w.ids.t_head);
  const d1 = await api('POST', `/cashouts/${id}/deposits`, { token: w.tokens.head, body: { deposit_account_id: bank.data.id, currency: 'USD', amount: 10, attachment_id: slipId } });
  assert.equal(d1.status, 201, JSON.stringify(d1.body));
  const reuse = await api('POST', `/cashouts/${id}/deposits`, { token: w.tokens.head, body: { deposit_account_id: bank.data.id, currency: 'USD', amount: 10, attachment_id: slipId } });
  assert.equal(reuse.body.error.code, 'SLIP_ALREADY_USED');
  const rm = await api('DELETE', `/cashouts/${id}/attachments/${slipId}`, { token: w.tokens.admin, body: { reason: 'x' } });
  assert.equal(rm.body.error.code, 'ATTACHMENT_IN_USE');
  const d2 = await api('POST', `/cashouts/${id}/deposits`, { token: w.tokens.head, body: { deposit_account_id: safe.data.id, currency: 'USD', amount: 10 } });
  const d3 = await api('POST', `/cashouts/${id}/deposits`, { token: w.tokens.head, body: { deposit_account_id: safe.data.id, currency: 'SLSH', amount: slshAmt } });
  assert.equal(d2.status, 201); assert.equal(d3.status, 201);
  assert.equal((await api('GET', `/cashouts/${id}`, { token: w.tokens.head })).data.deposit_status, 'deposited');
  const sum = await api('GET', '/cashouts/summary', { token: w.tokens.head });
  assert.ok(sum.data.unverified_deposits >= 3, 'unverified deposits counted');
  assert.equal((await api('PUT', `/cashouts/${id}/deposits/${d1.data.id}/verify`, { token: w.tokens.head, body: {} })).status, 403);
  for (const dep of [d1, d2, d3]) assert.equal((await api('PUT', `/cashouts/${id}/deposits/${dep.data.id}/verify`, { token: w.tokens.admin, body: {} })).status, 200);
  assert.equal((await api('GET', `/cashouts/${id}`, { token: w.tokens.head })).data.deposit_status, 'verified');

  const c2 = await mkCashier('t_co2_dep2', w.zoneA.name);
  const s2 = iso(Date.now() - 60 * 1000);
  await pay(c2, w.custA, 5, 'USD', 'cash');
  const co2 = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c2.id, s2, soon(), usdCash(5)) });
  await signDoc(co2.data.id, w.ids.t_head);
  assert.equal((await api('PUT', `/cashouts/${co2.data.id}/approve`, { token: w.tokens.gudoomiye, body: {} })).status, 200);
  const over = await api('POST', `/cashouts/${co2.data.id}/deposits`, { token: w.tokens.admin, body: { deposit_account_id: safe.data.id, currency: 'USD', amount: 6 } });
  assert.equal((await api('GET', `/cashouts/${co2.data.id}`, { token: w.tokens.head })).data.deposit_status, 'variance');
  assert.equal((await api('PUT', `/cashouts/${co2.data.id}/deposits/${over.data.id}/verify`, { token: w.tokens.admin, body: {} })).status, 403, 'never verify your own deposit');
  assert.equal((await api('PUT', `/cashouts/${co2.data.id}/deposits/${over.data.id}/void`, { token: w.tokens.admin, body: { reason: 'typo' } })).status, 200);
  assert.equal((await api('GET', `/cashouts/${co2.data.id}`, { token: w.tokens.head })).data.deposit_status, 'not_deposited');
});

test('settings: tolerance / threshold / cut-off validation', async () => {
  const w = await setupWorld();
  const put = (body, token = w.tokens.admin) => api('PUT', '/settings/company', { token, body });
  assert.equal((await put({ cashout_tolerance_usd: 2 }, w.tokens.head)).status, 403);
  assert.equal((await put({ cashout_tolerance_usd: -1 })).status, 400);
  assert.equal((await put({ cashout_tolerance_usd: '1' })).status, 400);
  assert.equal((await put({ cashout_tolerance_usd: 1.234 })).status, 400);
  assert.equal((await put({ cashout_tolerance_usd: 20, cashout_admin_threshold_usd: 10 })).status, 400);
  const ok = await put({ cashout_tolerance_usd: 2, cashout_admin_threshold_usd: 5 });
  assert.equal(ok.status, 200);
  assert.equal((await put({ cashout_tolerance_usd: 6 })).status, 400, 'checked against the saved threshold');
  assert.equal((await put({ cashout_v2_since: 'nope' })).status, 400);
  const meta = await api('GET', '/cashouts/meta', { token: w.tokens.head });
  assert.deepEqual(meta.data.controls, { tolerance_usd: 2, admin_threshold_usd: 5 });
  assert.ok(meta.data.cashout_v2_since, 'effective cut-off exposed');
  assert.equal((await put({ cashout_tolerance_usd: 1, cashout_admin_threshold_usd: 10 })).status, 200);
});

test('migration backfill: legacy pending cashouts above the threshold need an admin', async () => {
  const w = await setupWorld();
  const c = await mkCashier('t_co2_mig', w.zoneA.name);
  const ins = await db.query(
    `INSERT INTO cashouts (cashout_number, zone_id, cashier_id, head_of_cashiers_id, period_start, period_end, expected_amount, actual_amount, shortage, status, created_by)
     VALUES ($1, $2, $3, $4, NOW() - INTERVAL '900 hours', NOW() - INTERVAL '899 hours', 50, 20, 30, 'pending', $4) RETURNING id`,
    [`CO-MIG-${rnd()}`.slice(0, 20), w.zoneA.id, c.id, w.ids.t_head]);
  await require('../db').runCashoutV2Migrations();
  const row = (await db.query('SELECT needs_admin FROM cashouts WHERE id = $1', [ins.rows[0].id])).rows[0];
  assert.equal(row.needs_admin, true);
});

test('reports and summary count only live cashouts; debt-marked part exposed', async () => {
  const w = await setupWorld();
  const { getCashoutSummary } = require('../lib/reportsCalculations');
  const c = await mkCashier('t_co2_rep', w.zoneA.name);
  const start = iso(Date.now() - 60 * 1000);
  await pay(c, w.custA, 5, 'USD', 'cash');
  await pay(c, w.custA, 2, 'USD', 'debt');
  const co = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, start, soon(), usdCash(5)) });
  assert.equal(co.status, 201);
  const range = { periodStart: new Date(Date.now() - 3600e3), periodEnd: new Date(Date.now() + 3600e3), cashierId: c.id };
  let s = await getCashoutSummary(range);
  assert.ok(close(s.totals.actual, 7) && close(s.totals.debt_marked, 2) && close(s.totals.received, 5));
  assert.equal((await api('PUT', `/cashouts/${co.data.id}/void`, { token: w.tokens.admin, body: { reason: 'x' } })).status, 200);
  s = await getCashoutSummary(range);
  assert.equal(s.rows.length, 0, 'voided cashouts are not counted');
  const sum = await api('GET', '/cashouts/summary', { token: w.tokens.head });
  for (const k of ['pending', 'needs_admin', 'with_shortage', 'not_deposited', 'unverified_deposits']) assert.equal(typeof sum.data[k], 'number', k);
  assert.equal((await api('GET', '/cashouts?date_from=nope', { token: w.tokens.head })).status, 400);
});

test('monitor: overdue pending cashout alerts once per day; old alert rows pruned', async () => {
  const w = await setupWorld();
  const { checkOnce } = require('../lib/cashoutMonitor');
  const c = await mkCashier('t_co2_mon', w.zoneA.name);
  const r = await api('POST', '/cashouts', { token: w.tokens.head, body: v2Body(w, c.id, iso(Date.now() - 3600e3), iso(Date.now()), { cash_count: {} }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await db.query(`UPDATE cashouts SET created_at = NOW() - INTERVAL '30 hours' WHERE id = $1`, [r.data.id]);
  await db.query(`INSERT INTO cashout_alerts_sent (kind, ref_id, for_date) VALUES ('pending_overdue', 999999, CURRENT_DATE - 90) ON CONFLICT DO NOTHING`);
  await checkOnce();
  const n1 = await db.query(`SELECT COUNT(*)::int AS n FROM v2_staff_notifications WHERE event_type = 'cashout.pending_overdue' AND entity_id = $1`, [r.data.id]);
  assert.ok(n1.rows[0].n >= 1);
  assert.equal((await checkOnce()).sent, 0, 'second hourly run sends nothing new');
  const old = await db.query(`SELECT 1 FROM cashout_alerts_sent WHERE ref_id = 999999`);
  assert.equal(old.rows.length, 0, 'alerts older than 60 days pruned');
});
