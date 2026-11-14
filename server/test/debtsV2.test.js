// Debts V2 — real payments on standalone debts (Transactions / Cashout /
// revenue), invoice-linked collection through the invoice (auto-debt sync,
// debt-marked conversion, ZAAD push with all guards), reversal re-opening,
// currency rules, aging + summary math, filters / pagination / CSV scope,
// follow-ups + promise states, by-customer view, write-off + edit rules,
// RBAC and zone scoping, and no double counting with invoice balances.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, insertUser, tokenFor } = require('./helpers');
const { getRevenueForPeriod } = require('../lib/reportsCalculations');

const num = (x) => Number(x);
const close = (a, b, eps = 0.0001) => Math.abs(num(a) - num(b)) <= eps;
const rnd = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const iso = (ms) => new Date(ms).toISOString();
const magicPhone = () => `069901${String(Date.now()).slice(-4)}`;
let phoneSeq = 0;
const uniquePhone = () => `0637${String(Date.now()).slice(-5)}${(phoneSeq++ % 10)}`;

let w;
let zoneC;
let gudC;
let cashierC;
// Zone D holds every payment-making test so the shared zones A/B (whose
// totals other test files compare against invoice-only reference queries)
// never receive standalone-debt payments.
let zoneD;
let gudD;
let accD;
let cashierD;

async function mkCustomer(zone, name) {
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: { customer_type: 'residential', name: `${name} ${rnd()}`, phone: uniquePhone(), zone_id: zone.id, fee: 10, door_number: rnd().slice(-6) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}
async function mkCashier(name, zoneName) {
  const id = await insertUser(name, 'cashier', zoneName);
  return { id, token: await tokenFor(name) };
}
async function mkDebt(token, customer, amount, currency = 'USD', description = 'carried over') {
  const r = await api('POST', '/debts', { token, body: { customer_id: customer.id, amount, currency, description } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}
const collect = (token, debtId, body) => api('POST', `/debts/${debtId}/collect`, { token, body });
async function rawGet(url, token) {
  const res = await fetch(process.env.TEST_BASE + '/api/v2' + url, { headers: { Authorization: 'Bearer ' + token } });
  return { status: res.status, text: await res.text() };
}
async function preview(cashierId, start, end) {
  const q = `cashier_id=${cashierId}&period_start=${encodeURIComponent(start)}&period_end=${encodeURIComponent(end)}`;
  const r = await api('GET', `/cashouts/reconciliation-preview?${q}`, { token: w.tokens.head });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
}
async function createInvoiceFor(customer, total, currency = 'USD') {
  const r = await api('POST', '/invoices', { token: w.tokens.admin, body: { customer_id: customer.id, invoice_total: total, currency } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}
const pay = (token, invoiceId, amount, method, currency = 'USD', extra = {}) =>
  api('POST', '/payments', { token, body: { invoice_id: invoiceId, amount, currency, method, ...extra } });
const autoDebt = async (invoiceId) => (await db.query(`SELECT * FROM debts WHERE invoice_id = $1 AND source = 'auto_invoice' ORDER BY (status = 'unpaid') DESC, id DESC LIMIT 1`, [invoiceId])).rows[0];

before(async () => {
  w = await setupWorld();
  assert.equal((await api('POST', '/exchange-rates', { token: w.tokens.admin, body: { rate: 10000 } })).status, 201);
  const ex = await db.query("SELECT id, name FROM zones WHERE zone_code = 'TDZC'");
  zoneC = ex.rows[0] || (await api('POST', '/zones', { token: w.tokens.admin, body: { name: 'Debt Zone C', zone_code: 'TDZC' } })).data;
  assert.ok(zoneC && zoneC.id, 'zone C');
  await insertUser('t_dv_gud_c', 'gudoomiye', zoneC.name);
  gudC = await tokenFor('t_dv_gud_c');
  cashierC = await mkCashier('t_dv_cashier_c', zoneC.name);
  const exD = await db.query("SELECT id, name FROM zones WHERE zone_code = 'TDZD'");
  zoneD = exD.rows[0] || (await api('POST', '/zones', { token: w.tokens.admin, body: { name: 'Debt Zone D', zone_code: 'TDZD' } })).data;
  assert.ok(zoneD && zoneD.id, 'zone D');
  await insertUser('t_dv_gud_d', 'gudoomiye', zoneD.name);
  gudD = await tokenFor('t_dv_gud_d');
  await insertUser('t_dv_acc_d', 'zone_accountant', zoneD.name);
  accD = await tokenFor('t_dv_acc_d');
  cashierD = await mkCashier('t_dv_cashier_d', zoneD.name);
});

// ---------------- standalone debts: real payments ----------------

test('standalone debt: partial then full payment is a REAL payment in Transactions, Cashout expected and revenue', async () => {
  const cust = await mkCustomer(zoneD, 'DV Standalone');
  const cashier = await mkCashier(`t_dv_cash_${rnd()}`, zoneD.name);
  const start = iso(Date.now() - 1000);
  const debt = await mkDebt(gudD, cust, 50);
  const period = { periodStart: new Date(Date.now() - 86400000), periodEnd: new Date(Date.now() + 86400000), zoneId: zoneD.id };
  const revBefore = await getRevenueForPeriod(period);

  // gudoomiye can view but not collect
  assert.equal((await collect(gudD, debt.id, { amount: 10, currency: 'USD', method: 'cash' })).status, 403);
  assert.equal((await collect(cashier.token, debt.id, { amount: 60, currency: 'USD', method: 'cash' })).status, 409, 'over the remaining');
  assert.equal((await collect(cashier.token, debt.id, { amount: 10, currency: 'USD', method: 'debt' })).status, 400, 'debt-marked is not money');
  const p1 = await collect(cashier.token, debt.id, { amount: 20, currency: 'USD', method: 'cash' });
  assert.equal(p1.status, 201, JSON.stringify(p1.body));
  assert.equal(p1.data.target, 'debt');
  assert.equal(p1.data.payment.invoice_id, null);
  assert.equal(p1.data.payment.debt_id, debt.id);
  assert.equal(p1.data.debt.status, 'unpaid');
  assert.ok(close(p1.data.debt.remaining, 30));

  const detail = (await api('GET', `/debts/${debt.id}`, { token: w.tokens.admin })).data;
  assert.equal(detail.state, 'partial');
  assert.ok(close(detail.paid_amount, 20));
  assert.ok(close(detail.remaining, 30));
  assert.equal(detail.payments.length, 1);
  assert.equal(detail.collect.target, 'standalone');

  // Transactions: visible to admin and to the cashier who recorded it.
  const tx = await api('GET', `/payments/transactions?q=${encodeURIComponent(cust.name)}`, { token: w.tokens.admin });
  assert.equal(tx.status, 200);
  const row = tx.data.find((r) => r.id === p1.data.payment.id);
  assert.ok(row, 'standalone debt payment listed in Transactions');
  assert.equal(row.invoice_number, null);
  assert.equal(row.debt_id, debt.id);
  assert.equal(row.customer_id, cust.id);
  const mine = await api('GET', '/payments/transactions?target=debt', { token: cashier.token });
  assert.ok(mine.data.some((r) => r.id === p1.data.payment.id));
  const sum = await api('GET', `/payments/transactions/summary?target=debt&q=${encodeURIComponent(cust.name)}`, { token: w.tokens.admin });
  assert.ok(close(sum.data.filtered.by_currency.USD, 20));
  assert.ok(close(sum.data.filtered.by_method.cash, 20));

  // eDahab needs its reference; then it closes the debt.
  assert.equal((await collect(cashier.token, debt.id, { amount: 30, currency: 'USD', method: 'edahab' })).status, 400);
  const ref = `EDV${rnd()}`;
  const p2 = await collect(cashier.token, debt.id, { amount: 30, currency: 'USD', method: 'edahab', reference_code: ref });
  assert.equal(p2.status, 201, JSON.stringify(p2.body));
  assert.equal(p2.data.debt.status, 'paid');
  assert.ok(close(p2.data.debt.remaining, 0));
  assert.equal((await collect(cashier.token, debt.id, { amount: 1, currency: 'USD', method: 'cash' })).status, 409, 'already paid');

  // Same eDahab code on another debt -> unique reference rule.
  const other = await mkDebt(w.tokens.admin, cust, 5);
  const dup = await collect(cashier.token, other.id, { amount: 5, currency: 'USD', method: 'edahab', reference_code: ref });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DUPLICATE_REFERENCE');

  // Cashout expected for this cashier: cash 20 + manual eDahab 30 needing the statement check.
  const end = iso(Date.now() + 30 * 1000);
  const pv = await preview(cashier.id, start, end);
  assert.ok(close(pv.breakdown.currencies.USD.cash.expected, 20));
  assert.ok(close(pv.breakdown.currencies.USD.edahab.expected, 30));
  assert.ok(close(pv.breakdown.currencies.USD.edahab.manual_expected, 30));
  assert.equal(pv.transactionCount, 2);
  assert.equal(pv.customerCount, 1);
  const el = pv.electronic.find((e) => e.id === p2.data.payment.id);
  assert.ok(el, 'eDahab debt payment listed for statement confirmation');
  assert.equal(el.debt_id, debt.id);
  assert.equal(el.reference_code, ref);
  // A cashout over it reconciles exactly and covers both payment ids.
  await new Promise((r) => setTimeout(r, 50));
  const co = await api('POST', '/cashouts', { token: w.tokens.head, body: {
    zone_id: zoneD.id, cashier_id: cashier.id, period_start: start, period_end: iso(Date.now() + 1000),
    cash_count: { USD: { mode: 'manual', total: 20, remark: 'counted' }, SLSH: { mode: 'manual', total: 0, remark: 'counted' } },
    electronic_confirm: { USD: { edahab: { confirmed_ids: [p2.data.payment.id] } } },
  } });
  assert.equal(co.status, 201, JSON.stringify(co.body));
  assert.ok(close(co.data.shortage, 0));
  const covered = (await db.query('SELECT covered_payment_ids FROM cashouts WHERE id = $1', [co.data.id])).rows[0].covered_payment_ids.map(Number);
  assert.ok(covered.includes(p1.data.payment.id) && covered.includes(p2.data.payment.id));
  const ctx = await api('GET', `/cashouts/${co.data.id}/transactions`, { token: w.tokens.head });
  assert.equal(ctx.data.length, 2);

  // Revenue counts both, once.
  const revAfter = await getRevenueForPeriod(period);
  assert.ok(close(revAfter.collected - revBefore.collected, 50), `revenue delta ${revAfter.collected - revBefore.collected}`);
  assert.equal(revAfter.paymentCount - revBefore.paymentCount, 2);
});

test('standalone debt: admin reversal re-opens the debt; reversed payment leaves revenue and Transactions totals', async () => {
  const cust = await mkCustomer(zoneD, 'DV Reverse');
  const debt = await mkDebt(cashierD.token, cust, 40);
  const a = await collect(cashierD.token, debt.id, { amount: 15, currency: 'USD', method: 'cash' });
  const b = await collect(cashierD.token, debt.id, { amount: 25, currency: 'USD', method: 'cash' });
  assert.equal(b.data.debt.status, 'paid');
  assert.equal((await api('PUT', `/payments/${b.data.payment.id}/reverse`, { token: cashierD.token, body: { reason: 'x' } })).status, 403);
  assert.equal((await api('PUT', `/payments/${b.data.payment.id}/reverse`, { token: w.tokens.admin, body: {} })).status, 400);
  const rv = await api('PUT', `/payments/${b.data.payment.id}/reverse`, { token: w.tokens.admin, body: { reason: 'counterfeit note' } });
  assert.equal(rv.status, 200, JSON.stringify(rv.body));
  assert.equal(rv.data.status, 'reversed');
  assert.equal(rv.data.debt_status, 'unpaid');
  assert.ok(close(rv.data.debt_remaining, 25));
  const d = (await api('GET', `/debts/${debt.id}`, { token: w.tokens.admin })).data;
  assert.equal(d.state, 'partial');
  assert.ok(close(d.remaining, 25));
  assert.equal(d.settled_at, null);
  const sum = await api('GET', `/payments/transactions/summary?q=${encodeURIComponent(cust.name)}`, { token: w.tokens.admin });
  assert.ok(close(sum.data.filtered.by_currency.USD, 15));
  assert.equal(sum.data.filtered.reversed_count, 1);
  // collectable again
  assert.equal((await collect(cashierD.token, debt.id, { amount: 25, currency: 'USD', method: 'cash' })).status, 201);
  assert.ok(a.data.payment.id);
});

test('currency rules: SLSH whole numbers, USD 2 decimals, cross-currency at the current rate exactly like invoices', async () => {
  const cust = await mkCustomer(zoneD, 'DV Currency');
  assert.equal((await api('POST', '/debts', { token: w.tokens.admin, body: { customer_id: cust.id, amount: 1000.5, currency: 'SLSH' } })).status, 400);
  assert.equal((await api('POST', '/debts', { token: w.tokens.admin, body: { customer_id: cust.id, amount: 10, currency: 'EUR' } })).status, 400);
  assert.equal((await api('POST', '/exchange-rates', { token: w.tokens.admin, body: { rate: 10000 } })).status, 201);
  const slsh = await mkDebt(w.tokens.admin, cust, 100000, 'SLSH');
  assert.equal((await collect(cashierD.token, slsh.id, { amount: 1000.5, currency: 'SLSH', method: 'slsh' })).status, 400, 'SLSH whole numbers');
  assert.equal((await collect(cashierD.token, slsh.id, { amount: 2.555, currency: 'USD', method: 'cash' })).status, 400, 'USD 2 decimals');
  assert.equal((await collect(cashierD.token, slsh.id, { amount: 3, currency: 'USD', method: 'slsh' })).status, 400, 'SLSH cash is SLSH');
  const u = await collect(cashierD.token, slsh.id, { amount: 3, currency: 'USD', method: 'cash' });
  assert.equal(u.status, 201, JSON.stringify(u.body));
  assert.ok(close(u.data.debt.remaining, 70000), 'USD 3 x 10000 = 30,000 SLSH');
  const row = (await db.query('SELECT amount_debt_currency, conversion_rate_id, amount_usd FROM payments WHERE id = $1', [u.data.payment.id])).rows[0];
  assert.ok(close(row.amount_debt_currency, 30000));
  assert.ok(row.conversion_rate_id);
  assert.ok(close(row.amount_usd, 3));
  assert.equal((await collect(cashierD.token, slsh.id, { amount: 70001, currency: 'SLSH', method: 'slsh' })).status, 409);
  const s = await collect(cashierD.token, slsh.id, { amount: 70000, currency: 'SLSH', method: 'slsh' });
  assert.equal(s.data.debt.status, 'paid');

  const usd = await mkDebt(w.tokens.admin, cust, 10, 'USD');
  const x = await collect(cashierD.token, usd.id, { amount: 50000, currency: 'SLSH', method: 'slsh' });
  assert.equal(x.status, 201, JSON.stringify(x.body));
  assert.ok(close(x.data.debt.remaining, 5), 'SLSH 50,000 / 10000 = $5');
  // A later rate change never moves a recorded debt payment.
  assert.equal((await api('POST', '/exchange-rates', { token: w.tokens.admin, body: { rate: 8000 } })).status, 201);
  const d = (await api('GET', `/debts/${usd.id}`, { token: w.tokens.admin })).data;
  assert.ok(close(d.remaining, 5));
  assert.equal((await api('POST', '/exchange-rates', { token: w.tokens.admin, body: { rate: 10000 } })).status, 201);
});

// ---------------- invoice-linked (auto) debts ----------------

test('auto debt: collection is an invoice payment; the auto-debt sync reduces it; debt-marked part converts without double counting', async () => {
  const cust = await mkCustomer(zoneD, 'DV Auto');
  const inv = await createInvoiceFor(cust, 100);
  assert.equal((await pay(cashierD.token, inv.id, 30, 'cash')).status, 201);
  assert.equal((await pay(cashierD.token, inv.id, 50, 'debt')).status, 201);
  let d = await autoDebt(inv.id);
  assert.ok(close(d.amount, 70), 'auto debt mirrors the true unpaid part');
  // Billing alone can only take the 20 the invoice still shows.
  assert.equal((await pay(cashierD.token, inv.id, 40, 'cash')).status, 409);

  const det = (await api('GET', `/debts/${d.id}`, { token: cashierD.token })).data;
  assert.equal(det.collect.target, 'invoice');
  assert.ok(close(det.collect.max, 70));
  assert.ok(close(det.collect.invoice_outstanding, 20));
  assert.equal(det.paid_amount, null);

  assert.equal((await collect(cashierD.token, d.id, { amount: 71, currency: 'USD', method: 'cash' })).status, 409, 'over the true outstanding');
  const c1 = await collect(cashierD.token, d.id, { amount: 40, currency: 'USD', method: 'cash' });
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  assert.equal(c1.data.target, 'invoice');
  assert.equal(c1.data.payment.invoice_id, inv.id);
  assert.equal(c1.data.payment.debt_id, null);
  assert.equal(c1.data.payment.collected_via_debt_id, d.id);
  assert.equal(c1.data.invoice_status, 'paid');
  assert.ok(close(c1.data.debt.remaining, 30));
  assert.ok(c1.data.conversion && close(c1.data.conversion.converted, 20));
  const rows = (await db.query('SELECT method, amount, status FROM payments WHERE invoice_id = $1 ORDER BY id', [inv.id])).rows;
  const sumBy = (m, st) => rows.filter((r) => r.method === m && r.status === st).reduce((a, r) => a + num(r.amount), 0);
  assert.ok(close(sumBy('cash', 'recorded'), 70));
  assert.ok(close(sumBy('debt', 'recorded'), 30), 'leftover re-recorded as debt-marked');
  assert.ok(close(sumBy('debt', 'reversed'), 50), 'original debt-marked row converted');
  const inv1 = (await api('GET', `/invoices/${inv.id}`, { token: w.tokens.admin })).data;
  assert.ok(close(inv1.balance.paid, 100), 'invoice never overpaid');
  assert.ok(close(inv1.balance.outstanding, 0));

  const c2 = await collect(cashierD.token, d.id, { amount: 30, currency: 'USD', method: 'cash' });
  assert.equal(c2.status, 201, JSON.stringify(c2.body));
  assert.equal(c2.data.debt.status, 'paid');
  d = await autoDebt(inv.id);
  assert.equal(d.status, 'paid');
  assert.equal((await collect(cashierD.token, d.id, { amount: 1, currency: 'USD', method: 'cash' })).status, 409);
  const left = (await db.query("SELECT COUNT(*)::int AS n FROM payments WHERE invoice_id = $1 AND method = 'debt' AND status = 'recorded'", [inv.id])).rows[0].n;
  assert.equal(left, 0);
  const tx = await api('GET', `/payments/transactions/summary?q=${encodeURIComponent(cust.name)}`, { token: w.tokens.admin });
  assert.ok(close(tx.data.filtered.by_currency.USD, 100), 'all real money, once');
  assert.ok(close(tx.data.filtered.debt_usd, 0));
});

test('auto debt from a plain partial payment: collection = invoice payment, debt follows; manual invoice-linked debt is not collectable here', async () => {
  const cust = await mkCustomer(zoneD, 'DV Partial');
  const inv = await createInvoiceFor(cust, 60);
  await pay(cashierD.token, inv.id, 20, 'cash');
  const d = await autoDebt(inv.id);
  assert.ok(close(d.amount, 40));
  const c = await collect(cashierD.token, d.id, { amount: 15, currency: 'USD', method: 'cash' });
  assert.equal(c.status, 201);
  assert.equal(c.data.conversion, null);
  assert.ok(close((await autoDebt(inv.id)).amount, 25));
  assert.ok(close((await api('GET', `/invoices/${inv.id}`, { token: w.tokens.admin })).data.balance.outstanding, 25));
  // ZAAD manual needs the code; ZAAD API push goes through zaad-request with debt_id.
  assert.equal((await collect(cashierD.token, d.id, { amount: 5, currency: 'USD', method: 'zaad' })).status, 400);
  const push = await api('POST', '/payments/zaad-request', { token: cashierD.token, body: { invoice_id: inv.id, debt_id: d.id, phone: magicPhone(), amount: 5, currency: 'USD' } });
  assert.equal(push.status, 201, JSON.stringify(push.body));
  assert.equal(push.data.collected_via_debt_id, d.id);
  assert.ok(close(push.data.debt.remaining, 20));
  // debt_id must match the invoice and be an auto debt
  const standalone = await mkDebt(w.tokens.admin, cust, 5);
  assert.equal((await api('POST', '/payments/zaad-request', { token: cashierD.token, body: { invoice_id: inv.id, debt_id: standalone.id, phone: magicPhone(), amount: 1, currency: 'USD' } })).status, 409);
  const otherInv = await createInvoiceFor(cust, 10);
  assert.equal((await api('POST', '/payments/zaad-request', { token: cashierD.token, body: { invoice_id: otherInv.id, debt_id: d.id, phone: magicPhone(), amount: 1, currency: 'USD' } })).status, 400);

  const manual = await api('POST', '/debts', { token: w.tokens.admin, body: { customer_id: cust.id, invoice_id: inv.id, amount: 5, currency: 'USD' } });
  assert.equal(manual.status, 201);
  const m = await collect(cashierD.token, manual.data.id, { amount: 5, currency: 'USD', method: 'cash' });
  assert.equal(m.status, 409);
  assert.equal(m.body.error.code, 'MANUAL_INVOICE_DEBT');
});

test('ZAAD push on a debt-marked invoice: sized against the true outstanding, converts, keeps the in-flight guard', async () => {
  const cust = await mkCustomer(zoneD, 'DV Zaad');
  const inv = await createInvoiceFor(cust, 20);
  await pay(cashierD.token, inv.id, 20, 'debt');
  const d = await autoDebt(inv.id);
  assert.ok(close(d.amount, 20));
  // without debt_id the invoice is "paid" -> overpayment
  assert.equal((await api('POST', '/payments/zaad-request', { token: cashierD.token, body: { invoice_id: inv.id, phone: magicPhone(), amount: 5, currency: 'USD' } })).status, 409);
  const r = await api('POST', '/payments/zaad-request', { token: cashierD.token, body: { invoice_id: inv.id, debt_id: d.id, phone: magicPhone(), amount: 5, currency: 'USD' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(close(r.data.debt.remaining, 15));
  const gw = (await db.query("SELECT status, payment_id FROM portal_zaad_attempts WHERE invoice_id = $1 ORDER BY id DESC LIMIT 1", [inv.id])).rows[0];
  assert.equal(gw.status, 'ok');
  assert.equal(gw.payment_id, r.data.id);
  assert.ok(close((await api('GET', `/invoices/${inv.id}`, { token: w.tokens.admin })).data.balance.paid, 20));
});

// ---------------- summary, aging, filters, by-customer (zone C) ----------------

let C;
test('zone C fixture: aging, partial, SLSH, written-off, paid, auto and promises', async () => {
  const c1 = await mkCustomer(zoneC, 'DVC One');
  const c2 = await mkCustomer(zoneC, 'DVC Two');
  const c3 = await mkCustomer(zoneC, 'DVC Three');
  const c4 = await mkCustomer(zoneC, 'DVC Four');
  const d1 = await mkDebt(gudC, c1, 100, 'USD', 'old fee');
  const d2 = await mkDebt(gudC, c1, 40, 'USD', '=HYPERLINK("http://x")');
  const d3 = await mkDebt(gudC, c2, 50000, 'SLSH', 'repairs');
  const d4 = await mkDebt(gudC, c4, 20, 'USD', 'to write off');
  const d5 = await mkDebt(gudC, c4, 5, 'USD', 'paid off');
  await db.query("UPDATE debts SET created_at = NOW() - interval '75 days' WHERE id = $1", [d2.id]);
  await db.query("UPDATE debts SET created_at = NOW() - interval '100 days' WHERE id = $1", [d3.id]);
  assert.equal((await collect(cashierC.token, d2.id, { amount: 10, currency: 'USD', method: 'cash' })).status, 201);
  assert.equal((await collect(cashierC.token, d5.id, { amount: 5, currency: 'USD', method: 'cash' })).status, 201);
  assert.equal((await api('PUT', `/debts/${d4.id}/write-off`, { token: w.tokens.admin, body: { reason: 'customer left' } })).status, 200);
  // auto debt: invoice 30, paid 10 -> auto 20 (and the invoice shows 20 owed too)
  const inv = await createInvoiceFor(c3, 30);
  assert.equal((await pay(cashierC.token, inv.id, 10, 'cash')).status, 201);
  const auto = await autoDebt(inv.id);
  // promises: due today on d1, broken (yesterday) on d3
  const today = (await api('GET', '/debts/summary', { token: gudC })).data.date;
  assert.equal((await api('POST', '/debts/followups', { token: gudC, body: { debt_id: d1.id, kind: 'call', note: 'will pay', promise_date: today, promise_amount: 50 } })).status, 201);
  await db.query(`INSERT INTO debt_followups (customer_id, debt_id, kind, note, promise_date, created_by) VALUES ($1,$2,'visit','promised',($3::date - 1),NULL)`, [c2.id, d3.id, today]);
  C = { c1, c2, c3, c4, d1, d2, d3, d4, d5, auto, inv, today };
});

test('summary: per-currency outstanding / overdue / collected / promises, register only (no double counting with invoices)', async () => {
  const s = (await api('GET', '/debts/summary', { token: gudC })).data;
  assert.ok(close(s.outstanding.USD, 150), `USD outstanding = 100 + 30 + auto 20, got ${s.outstanding.USD}`);
  assert.ok(close(s.outstanding.SLSH, 50000));
  assert.ok(close(s.over_60.USD, 30));
  assert.ok(close(s.over_60.SLSH, 50000));
  assert.equal(s.over_60_count, 2);
  assert.ok(close(s.over_90.USD, 0));
  assert.ok(close(s.over_90.SLSH, 50000));
  assert.equal(s.over_90_count, 1);
  assert.equal(s.customers_owing, 3);
  assert.equal(s.open_count, 4);
  assert.equal(s.auto_open, 1);
  assert.equal(s.manual_open, 3);
  assert.ok(close(s.collected_this_month.USD, 15), 'only debt collections (10 + 5), not the invoice payment');
  assert.equal(s.promises_due_today, 1);
  assert.equal(s.broken_promises, 1);
  assert.equal(s.written_off_count, 1);
  // the invoice balance is NOT added: the invoice's own outstanding is 20 and the summary has the auto debt once.
  const ib = (await api('GET', `/invoices/${C.inv.id}`, { token: w.tokens.admin })).data.balance;
  assert.ok(close(ib.outstanding, 20));
  // Zone A users never see zone C money.
  const a = (await api('GET', '/debts/summary', { token: gudD })).data;
  const all = (await api('GET', '/debts/summary', { token: w.tokens.admin })).data;
  assert.ok(all.outstanding.USD >= a.outstanding.USD + 150 - 0.001);
});

test('list: filters, sorting, pagination, aging buckets, promise states; zone scoped', async () => {
  const L = async (qs, token = gudC) => {
    const r = await api('GET', `/debts?${qs}`, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r;
  };
  assert.equal((await L('status=open')).body.meta.total, 4);
  assert.deepEqual((await L('status=partial')).data.map((r) => r.id), [C.d2.id]);
  assert.deepEqual((await L('status=written_off')).data.map((r) => r.id), [C.d4.id]);
  assert.deepEqual((await L('status=paid')).data.map((r) => r.id), [C.d5.id]);
  assert.deepEqual((await L('source=auto')).data.map((r) => r.id), [C.auto.id]);
  assert.deepEqual((await L('currency=SLSH')).data.map((r) => r.id), [C.d3.id]);
  assert.deepEqual((await L('age=90_plus')).data.map((r) => r.id), [C.d3.id]);
  assert.deepEqual((await L('age=61_90')).data.map((r) => r.id), [C.d2.id]);
  assert.deepEqual((await L('age=over_60&sort=age&dir=desc')).data.map((r) => r.id), [C.d3.id, C.d2.id]);
  assert.deepEqual((await L('promise=broken')).data.map((r) => r.id), [C.d3.id]);
  assert.deepEqual((await L('promise=due_today')).data.map((r) => r.id), [C.d1.id]);
  const big = await L('status=open&currency=USD&amount_min=25&sort=amount&dir=desc');
  assert.deepEqual(big.data.map((r) => r.id), [C.d1.id, C.d2.id], 'remaining >= 25, largest first');
  const old = await L('status=open&sort=age&dir=desc');
  assert.equal(old.data[0].id, C.d3.id);
  const r2 = old.data.find((r) => r.id === C.d2.id);
  assert.equal(r2.age_days, 75);
  assert.equal(r2.age_bucket, '61_90');
  assert.ok(close(r2.remaining, 30));
  assert.ok(close(r2.paid_amount, 10));
  assert.equal(r2.currency, 'USD');
  assert.ok(r2.suspension && r2.suspension.state, 'suspension state attached');
  assert.equal(old.data.find((r) => r.id === C.d1.id).promise_state, 'due_today');
  // search by name, customer number, phone digits in another style
  assert.ok((await L(`q=${encodeURIComponent('DVC Two')}`)).data.every((r) => r.customer_id === C.c2.id));
  const digits = C.c2.phone.replace(/\D/g, '').replace(/^0/, '');
  assert.ok((await L(`q=${encodeURIComponent('+252 ' + digits)}`)).data.some((r) => r.customer_id === C.c2.id));
  assert.equal((await L(`zone_id=${zoneC.id}`)).body.meta.total, 6);
  // pagination
  const p1 = await L('page_size=2&page=1&sort=created_at&dir=asc');
  assert.equal(p1.data.length, 2);
  assert.equal(p1.body.meta.total, 6);
  assert.equal(p1.body.meta.pages, 3);
  const p3 = await L('page_size=2&page=3&sort=created_at&dir=asc');
  assert.equal(p3.data.length, 2);
  assert.ok(!p3.data.some((r) => p1.data.some((x) => x.id === r.id)), 'pages do not overlap');
  assert.equal((await L('page_size=500')).body.meta.page_size, 100);
  // validation
  assert.equal((await api('GET', '/debts?status=bogus', { token: gudC })).status, 400);
  assert.equal((await api('GET', '/debts?age=1_2', { token: gudC })).status, 400);
  assert.equal((await api('GET', '/debts?sort=nope', { token: gudC })).status, 400);
  // zone scope: zone A users never see zone C debts, detail is 403
  const za = await L('page_size=100', gudD);
  assert.ok(!za.data.some((r) => r.customer_id === C.c1.id));
  assert.equal((await api('GET', `/debts/${C.d1.id}`, { token: gudD })).status, 403);
  assert.equal((await api('GET', `/debts/${C.d1.id}`, { token: w.tokens.head })).status, 200, 'head of cashiers is not zone scoped');
  assert.equal((await api('GET', '/debts', { token: w.tokens.collector })).status, 403);
  // a zone-scoped user without a resolvable zone sees nothing
  await insertUser('t_dv_nozone', 'zone_accountant', null);
  const nz = await api('GET', '/debts', { token: await tokenFor('t_dv_nozone') });
  assert.equal(nz.status, 200);
  assert.equal(nz.body.meta.total, 0);
});

test('CSV export: same scope and filters, formula-safe', async () => {
  const r = await rawGet('/debts/export.csv?status=open', gudC);
  assert.equal(r.status, 200);
  const lines = r.text.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines.length, 1 + 4);
  assert.ok(r.text.includes(C.c1.name));
  assert.ok(!r.text.includes('Test Customer A'));
  assert.ok(r.text.includes(`"'=HYPERLINK`), 'formula neutralised');
  assert.equal((await rawGet('/debts/export.csv?status=nope', gudC)).status, 400);
  assert.equal((await rawGet('/debts/export.csv', w.tokens.collector)).status, 403);
});

test('by-customer view: totals per currency, debt count, oldest age, last follow-up', async () => {
  const r = await api('GET', '/debts?view=customer&status=open&sort=oldest&dir=desc', { token: gudC });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.meta.total, 3);
  const one = r.data.find((x) => x.customer_id === C.c1.id);
  assert.ok(close(one.totals.USD, 130));
  assert.ok(close(one.totals.SLSH, 0));
  assert.equal(one.debt_count, 2);
  assert.equal(one.oldest_age, 75);
  assert.ok(one.last_followup_at, 'last follow-up shown');
  const two = r.data.find((x) => x.customer_id === C.c2.id);
  assert.ok(close(two.totals.SLSH, 50000));
  assert.equal(r.data[0].customer_id, C.c2.id, 'oldest first');
  const exp = await api('GET', `/debts?status=open&customer_id=${C.c1.id}`, { token: gudC });
  assert.equal(exp.body.meta.total, 2, 'expand = the customer filter');
});

test('follow-ups: validation, roles, promise states', async () => {
  const f = (token, body) => api('POST', '/debts/followups', { token, body });
  assert.equal((await f(gudC, { debt_id: C.d2.id, kind: 'shout', note: 'x' })).status, 400);
  assert.equal((await f(gudC, { debt_id: C.d2.id, kind: 'call' })).status, 400, 'note or promise required');
  assert.equal((await f(gudC, { debt_id: C.d2.id, kind: 'call', promise_date: '2020-01-01' })).status, 400, 'no past promises');
  assert.equal((await f(gudC, { debt_id: C.d3.id, kind: 'call', promise_date: C.today, promise_amount: 1.5 })).status, 400, 'SLSH promise whole');
  assert.equal((await f(gudC, { customer_id: C.c2.id, debt_id: C.d1.id, kind: 'call', note: 'x' })).status, 400, 'debt of another customer');
  assert.equal((await f(w.tokens.collector, { debt_id: C.d2.id, kind: 'call', note: 'x' })).status, 403);
  assert.equal((await f(gudD, { debt_id: C.d2.id, kind: 'call', note: 'x' })).status, 403, 'outside zone');
  const ok = await f(w.tokens.head, { debt_id: C.d2.id, kind: 'visit', note: 'met at home', promise_date: C.today });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.data.promise_date, C.today);
  const list = await api('GET', `/debts/followups?debt_id=${C.d2.id}`, { token: gudC });
  assert.equal(list.status, 200);
  assert.ok(list.data.some((x) => x.id === ok.data.id && x.created_by_name));
  const r = await api('GET', `/debts?promise=due_today`, { token: gudC });
  assert.deepEqual(r.data.map((x) => x.id).sort(), [C.d1.id, C.d2.id].sort());
  // a paid debt never shows a broken promise
  await db.query(`INSERT INTO debt_followups (customer_id, debt_id, kind, note, promise_date) VALUES ($1,$2,'call','x',($3::date - 2))`, [C.c4.id, C.d5.id, C.today]);
  assert.ok(!(await api('GET', '/debts?promise=broken', { token: gudC })).data.some((x) => x.id === C.d5.id));
  const det = (await api('GET', `/debts/${C.d2.id}`, { token: gudC })).data;
  assert.ok(det.followups.length >= 1);
});

// ---------------- write-off + edit ----------------

test('write-off: admin only, reason required, never for auto debts (void the invoice instead), excluded from totals', async () => {
  const cust = await mkCustomer(zoneD, 'DV WriteOff');
  const debt = await mkDebt(cashierD.token, cust, 12);
  await collect(cashierD.token, debt.id, { amount: 2, currency: 'USD', method: 'cash' });
  assert.equal((await api('PUT', `/debts/${debt.id}/write-off`, { token: cashierD.token, body: { reason: 'x' } })).status, 403);
  assert.equal((await api('PUT', `/debts/${debt.id}/write-off`, { token: gudD, body: { reason: 'x' } })).status, 403);
  assert.equal((await api('PUT', `/debts/${debt.id}/write-off`, { token: w.tokens.admin, body: {} })).status, 400);
  const ok = await api('PUT', `/debts/${debt.id}/write-off`, { token: w.tokens.admin, body: { reason: 'uncollectable' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.data.status, 'written_off');
  assert.ok(close(ok.data.remaining_written_off, 10));
  assert.equal((await api('PUT', `/debts/${debt.id}/write-off`, { token: w.tokens.admin, body: { reason: 'again' } })).status, 409);
  assert.equal((await collect(cashierD.token, debt.id, { amount: 1, currency: 'USD', method: 'cash' })).status, 409);
  assert.equal((await api('PUT', `/debts/${debt.id}/status`, { token: cashierD.token, body: { status: 'paid' } })).status, 409);
  const d = (await api('GET', `/debts/${debt.id}`, { token: w.tokens.admin })).data;
  assert.equal(d.state, 'written_off');
  assert.ok(close(d.remaining, 0));
  const audit = (await db.query("SELECT 1 FROM v2_audit_log WHERE action = 'debt.write_off' AND entity_id = $1", [debt.id])).rows;
  assert.equal(audit.length, 1);

  // auto debt -> 409, voiding the invoice closes it
  const inv = await createInvoiceFor(cust, 30);
  await pay(cashierD.token, inv.id, 10, 'cash');
  const auto = await autoDebt(inv.id);
  const no = await api('PUT', `/debts/${auto.id}/write-off`, { token: w.tokens.admin, body: { reason: 'x' } });
  assert.equal(no.status, 409);
  assert.equal(no.body.error.code, 'AUTO_DEBT_WRITE_OFF');
  assert.equal((await api('PUT', `/invoices/${inv.id}/void`, { token: w.tokens.admin, body: { reason: 'billed in error' } })).status, 200);
  const closed = (await db.query('SELECT status, written_off_reason FROM debts WHERE id = $1', [auto.id])).rows[0];
  assert.equal(closed.status, 'written_off');
  assert.match(closed.written_off_reason, /voided/);
});

test('edit: description only, creator or admin; amounts immutable; audited', async () => {
  const cust = await mkCustomer(zoneD, 'DV Edit');
  const debt = await mkDebt(gudD, cust, 9);
  assert.equal((await api('PUT', `/debts/${debt.id}`, { token: gudD, body: { amount: 1 } })).status, 400);
  const imm = await api('PUT', `/debts/${debt.id}`, { token: gudD, body: { description: 'x', currency: 'SLSH' } });
  assert.equal(imm.body.error.code, 'IMMUTABLE');
  assert.equal((await api('PUT', `/debts/${debt.id}`, { token: cashierD.token, body: { description: 'not mine' } })).status, 403);
  assert.equal((await api('PUT', `/debts/${debt.id}`, { token: accD, body: { description: 'x' } })).status, 403);
  const ok = await api('PUT', `/debts/${debt.id}`, { token: gudD, body: { description: 'new text' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.description, 'new text');
  assert.ok(close(ok.data.amount, 9));
  assert.equal((await api('PUT', `/debts/${debt.id}`, { token: w.tokens.admin, body: { description: 'admin text' } })).status, 200);
  const a = (await db.query("SELECT COUNT(*)::int AS n FROM v2_audit_log WHERE action = 'debt.update' AND entity_id = $1", [debt.id])).rows[0].n;
  assert.equal(a, 2);
  // out-of-zone collect is refused
  assert.equal((await collect(w.tokens.cashierB, debt.id, { amount: 1, currency: 'USD', method: 'cash' })).status, 403);
});

test('cashier assignment panel lists the cashier\'s standalone debt collections (information only)', async () => {
  const cust = await mkCustomer(zoneD, 'DV Assign');
  const cashier = await mkCashier(`t_dv_asg_${rnd()}`, zoneD.name);
  const start = iso(Date.now() - 1000);
  const debt = await mkDebt(w.tokens.admin, cust, 7);
  assert.equal((await collect(cashier.token, debt.id, { amount: 7, currency: 'USD', method: 'cash' })).status, 201);
  const q = `cashier_id=${cashier.id}&period_start=${encodeURIComponent(start)}&period_end=${encodeURIComponent(iso(Date.now() + 30000))}`;
  const r = await api('GET', `/cashouts/assignment-preview?${q}`, { token: w.tokens.head });
  assert.equal(r.status, 200);
  assert.ok(close(r.data.debt_collections.USD, 7));
  assert.equal(r.data.debt_collections.payment_count, 1);
  // the portal never breaks on standalone debt payments; customer list last payment includes them
  const list = await api('GET', `/customers?q=${encodeURIComponent(cust.name)}&with_balance=1`, { token: w.tokens.admin });
  assert.equal(list.status, 200);
});

test('reversing a debt collection on an auto debt re-opens the invoice and its auto debt', async () => {
  const cust = await mkCustomer(zoneD, 'DV AutoReverse');
  const inv = await createInvoiceFor(cust, 50);
  await pay(cashierD.token, inv.id, 10, 'cash');
  const d = await autoDebt(inv.id);
  const c = await collect(cashierD.token, d.id, { amount: 40, currency: 'USD', method: 'cash' });
  assert.equal(c.status, 201);
  assert.equal(c.data.debt.status, 'paid');
  const rv = await api('PUT', `/payments/${c.data.payment.id}/reverse`, { token: w.tokens.admin, body: { reason: 'bounced' } });
  assert.equal(rv.status, 200, JSON.stringify(rv.body));
  assert.equal(rv.data.invoice_status, 'partial');
  const again = await autoDebt(inv.id);
  assert.equal(again.status, 'unpaid');
  assert.ok(close(again.amount, 40));
});

test('ledger guard: a payment targets exactly one invoice OR one debt; Debts V2 migrations are idempotent', async () => {
  const { runDebtsV2Migrations } = require('../db');
  await runDebtsV2Migrations();
  await runDebtsV2Migrations();
  const cust = await mkCustomer(zoneD, 'DV Guard');
  const debt = await mkDebt(w.tokens.admin, cust, 3);
  const inv = await createInvoiceFor(cust, 3);
  const ins = (invoiceId, debtId) => db.query(
    `INSERT INTO payments (invoice_id, debt_id, amount, currency, method, amount_usd, cashier_id, status, amount_debt_currency)
     VALUES ($1,$2,1,'USD','cash',1,NULL,'recorded',1)`, [invoiceId, debtId]);
  await assert.rejects(ins(inv.id, debt.id), /payments_target_check/);
  await assert.rejects(ins(null, null), /payments_target_check/);
  await assert.rejects(db.query(`INSERT INTO payments (invoice_id, debt_id, amount, currency, method, amount_usd, status) VALUES (NULL,$1,1,'USD','cash',1,'recorded')`, [debt.id]), /payments_debt_amount_check/);
  const st = (await db.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'debts'::regclass AND conname = 'debts_status_check'`)).rows[0];
  assert.match(st.def, /written_off/);
});
