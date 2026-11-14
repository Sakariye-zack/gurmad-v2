const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, createInvoice } = require('./helpers');

const num = (x) => Number(x);
const pay = (token, invoice, amount, method = 'cash', currency = 'USD') => api('POST', '/payments', { token, body: { invoice_id: invoice.id, amount, currency, method } });

test('invoice -> partial payment -> remaining payment -> paid; status and outstanding track exactly', async () => {
  const { tokens, custA } = await setupWorld();
  const inv = await createInvoice(tokens.cashier, custA, 25);
  const p1 = await pay(tokens.cashier, inv, 10);
  assert.equal(p1.status, 201);
  assert.equal(p1.data.invoice_status, 'partial');
  assert.equal(num(p1.data.outstanding), 15);
  // a manual ZAAD entry must carry the ZAAD transaction code
  const p2 = await api('POST', '/payments', { token: tokens.cashier, body: { invoice_id: inv.id, amount: 15, currency: 'USD', method: 'zaad', reference_code: `MZ${Date.now()}` } });
  assert.equal(p2.status, 201);
  assert.equal(p2.data.invoice_status, 'paid');
  assert.equal(num(p2.data.outstanding), 0);
});

test('overpaying an invoice is rejected and records nothing', async () => {
  const { tokens, custA } = await setupWorld();
  const inv = await createInvoice(tokens.cashier, custA, 5);
  const over = await pay(tokens.cashier, inv, 6);
  assert.ok(over.status >= 400 && over.status < 500, 'status ' + over.status);
  const n = await db.query("SELECT COUNT(*)::int AS n FROM payments WHERE invoice_id = $1", [inv.id]);
  assert.equal(n.rows[0].n, 0);
});

test('payment input validation: zero/negative amount, bad method, bad currency', async () => {
  const { tokens, custA } = await setupWorld();
  const inv = await createInvoice(tokens.cashier, custA, 5);
  assert.equal((await pay(tokens.cashier, inv, 0)).status, 400);
  assert.equal((await pay(tokens.cashier, inv, -3)).status, 400);
  assert.equal((await pay(tokens.cashier, inv, 1, 'bitcoin')).status, 400);
  assert.equal((await pay(tokens.cashier, inv, 1, 'cash', 'EUR')).status, 400);
});

test('SLSH payment converts to USD at the current exchange rate and keeps the historical rate', async () => {
  const { tokens, custA } = await setupWorld();
  assert.equal((await api('POST', '/exchange-rates', { token: tokens.admin, body: { rate: 10000 } })).status, 201);
  const inv = await createInvoice(tokens.cashier, custA, 10);
  const p = await pay(tokens.cashier, inv, 50000, 'slsh', 'SLSH');
  assert.equal(p.status, 201);
  assert.equal(num(p.data.amount_usd), 5, '50,000 SLSH at 10,000 = $5');
  // a later rate change must not rewrite the stored USD value
  await api('POST', '/exchange-rates', { token: tokens.admin, body: { rate: 20000 } });
  const row = await db.query('SELECT amount_usd FROM payments WHERE id = $1', [p.data.id]);
  assert.equal(num(row.rows[0].amount_usd), 5);
});

test('exchange rate: admin only, positive numbers only', async () => {
  const { tokens } = await setupWorld();
  assert.equal((await api('POST', '/exchange-rates', { token: tokens.cashier, body: { rate: 9000 } })).status, 403);
  assert.equal((await api('POST', '/exchange-rates', { token: tokens.admin, body: { rate: -1 } })).status, 400);
  assert.equal((await api('POST', '/exchange-rates', { token: tokens.admin, body: { rate: 'abc' } })).status, 400);
});

test('only admin/cashier can record payments; others are 403', async () => {
  const { tokens, custA } = await setupWorld();
  const inv = await createInvoice(tokens.cashier, custA, 5);
  for (const r of ['gudoomiye', 'accountant', 'head', 'collector']) {
    assert.equal((await pay(tokens[r], inv, 1)).status, 403, r);
  }
});

test('cashier is zone-scoped: cannot invoice or take payment outside own zone', async () => {
  const { tokens, custA, custB } = await setupWorld();
  const foreign = await api('POST', '/invoices', { token: tokens.cashier, body: { customer_id: custB.id, invoice_total: 5 } });
  assert.equal(foreign.status, 403);
  const invB = await createInvoice(tokens.admin, custB, 5);
  const r = await pay(tokens.cashier, invB, 1);
  assert.ok([403, 404].includes(r.status), 'cashier A paying zone B invoice got ' + r.status);
  const invA = await createInvoice(tokens.admin, custA, 5);
  const r2 = await pay(tokens.cashierB, invA, 1);
  assert.ok([403, 404].includes(r2.status), 'cashier B paying zone A invoice got ' + r2.status);
});

test('void invoice: admin only, reason required, a voided invoice rejects payments', async () => {
  const { tokens, custA } = await setupWorld();
  const inv = await createInvoice(tokens.cashier, custA, 8);
  assert.equal((await api('PUT', `/invoices/${inv.id}/void`, { token: tokens.cashier, body: { reason: 'x' } })).status, 403);
  assert.equal((await api('PUT', `/invoices/${inv.id}/void`, { token: tokens.admin, body: {} })).status, 400, 'reason required');
  assert.equal((await api('PUT', `/invoices/${inv.id}/void`, { token: tokens.admin, body: { reason: 'entered by mistake' } })).status, 200);
  const r = await pay(tokens.cashier, inv, 1);
  assert.ok(r.status >= 400, 'payment on voided invoice must fail, got ' + r.status);
});

test('reverse payment: admin only, reason required, restores the outstanding balance', async () => {
  const { tokens, custA } = await setupWorld();
  const inv = await createInvoice(tokens.cashier, custA, 12);
  const p = await pay(tokens.cashier, inv, 12);
  assert.equal(p.data.invoice_status, 'paid');
  assert.equal((await api('PUT', `/payments/${p.data.id}/reverse`, { token: tokens.cashier, body: { reason: 'x' } })).status, 403);
  assert.equal((await api('PUT', `/payments/${p.data.id}/reverse`, { token: tokens.admin, body: {} })).status, 400);
  assert.equal((await api('PUT', `/payments/${p.data.id}/reverse`, { token: tokens.admin, body: { reason: 'wrong customer' } })).status, 200);
  const after = await api('GET', `/invoices/${inv.id}`, { token: tokens.admin });
  assert.equal(after.status, 200);
  assert.notEqual(after.data.status, 'paid');
});

test('debts: create/settle role gates and validation', async () => {
  const { tokens, custA } = await setupWorld();
  const mk = (t) => api('POST', '/debts', { token: t, body: { customer_id: custA.id, amount: 7, currency: 'USD', description: 'carried over' } });
  assert.equal((await mk(tokens.collector)).status, 403);
  assert.equal((await mk(tokens.head)).status, 403);
  const d = await mk(tokens.gudoomiye);
  assert.equal(d.status, 201);
  assert.equal((await api('POST', '/debts', { token: tokens.admin, body: { customer_id: custA.id, amount: -1, currency: 'USD' } })).status, 400);
  assert.equal((await api('PUT', `/debts/${d.data.id}/status`, { token: tokens.gudoomiye, body: { status: 'paid' } })).status, 403, 'gudoomiye cannot settle');
  // Debts V2 fix round: a standalone debt can no longer be marked settled
  // without money (Collect payment or Write off instead); only a manual debt
  // linked to an invoice is settled here.
  const standalone = await api('PUT', `/debts/${d.data.id}/status`, { token: tokens.cashier, body: { status: 'paid' } });
  assert.equal(standalone.status, 409);
  assert.equal(standalone.body.error.code, 'USE_COLLECT');
  const inv = await createInvoice(tokens.admin, custA, 7);
  assert.equal((await api('POST', '/payments', { token: tokens.cashier, body: { invoice_id: inv.id, amount: 7, currency: 'USD', method: 'cash' } })).status, 201);
  const linked = await api('POST', '/debts', { token: tokens.gudoomiye, body: { customer_id: custA.id, invoice_id: inv.id, amount: 7, currency: 'USD' } });
  assert.equal(linked.status, 201);
  assert.equal((await api('PUT', `/debts/${linked.data.id}/status`, { token: tokens.cashier, body: { status: 'paid' } })).status, 200);
  assert.equal((await api('PUT', `/debts/${linked.data.id}/status`, { token: tokens.cashier, body: { status: 'paid' } })).status, 409, 'cannot settle twice');
});

// ---- SLSH invoices: balances are computed in the invoice's own currency ----
const createSlshInvoice = async (token, customer, total) => {
  const r = await api('POST', '/invoices', { token, body: { customer_id: customer.id, invoice_total: total, currency: 'SLSH' } });
  if (r.status !== 201) throw new Error('slsh invoice create failed: ' + JSON.stringify(r.body));
  return r.data;
};

test('SLSH invoice paid fully in SLSH -> paid', async () => {
  const { tokens, custA } = await setupWorld();
  assert.equal((await api('POST', '/exchange-rates', { token: tokens.admin, body: { rate: 10000 } })).status, 201);
  const inv = await createSlshInvoice(tokens.cashier, custA, 100000);
  assert.equal(inv.currency, 'SLSH');
  const p1 = await pay(tokens.cashier, inv, 60000, 'slsh', 'SLSH');
  assert.equal(p1.status, 201);
  assert.equal(p1.data.invoice_status, 'partial');
  assert.equal(num(p1.data.outstanding), 40000);
  const p2 = await pay(tokens.cashier, inv, 40000, 'slsh', 'SLSH');
  assert.equal(p2.status, 201);
  assert.equal(p2.data.invoice_status, 'paid');
  assert.equal(num(p2.data.outstanding), 0);
});

test('SLSH invoice part-paid in USD converts at payment rate', async () => {
  const { tokens, custA } = await setupWorld();
  assert.equal((await api('POST', '/exchange-rates', { token: tokens.admin, body: { rate: 10000 } })).status, 201);
  const inv = await createSlshInvoice(tokens.cashier, custA, 100000);
  const p = await pay(tokens.cashier, inv, 4, 'cash', 'USD');
  assert.equal(p.status, 201);
  assert.equal(p.data.invoice_status, 'partial');
  assert.equal(num(p.data.outstanding), 60000, '$4 at 10,000 = 40,000 SLSH paid');
  const rest = await pay(tokens.cashier, inv, 60000, 'slsh', 'SLSH');
  assert.equal(rest.status, 201);
  assert.equal(rest.data.invoice_status, 'paid');
});

test('overpaying an SLSH invoice -> 409', async () => {
  const { tokens, custA } = await setupWorld();
  assert.equal((await api('POST', '/exchange-rates', { token: tokens.admin, body: { rate: 10000 } })).status, 201);
  const inv = await createSlshInvoice(tokens.cashier, custA, 100000);
  const over = await pay(tokens.cashier, inv, 100001, 'slsh', 'SLSH');
  assert.equal(over.status, 409);
  assert.match(over.body.error.message, /SLSH/);
  const overUsd = await pay(tokens.cashier, inv, 11, 'cash', 'USD');
  assert.equal(overUsd.status, 409, '$11 = 110,000 SLSH > 100,000');
  const n = await db.query('SELECT COUNT(*)::int AS n FROM payments WHERE invoice_id = $1', [inv.id]);
  assert.equal(n.rows[0].n, 0);
});

test('USD invoices unchanged: SLSH payment still converts to USD', async () => {
  const { tokens, custA } = await setupWorld();
  assert.equal((await api('POST', '/exchange-rates', { token: tokens.admin, body: { rate: 10000 } })).status, 201);
  const inv = await createInvoice(tokens.cashier, custA, 10);
  const p = await pay(tokens.cashier, inv, 50000, 'slsh', 'SLSH');
  assert.equal(p.status, 201);
  assert.equal(num(p.data.outstanding), 5);
});

test('invoice GET returns dual-currency balance block and the rate used', async () => {
  const { tokens, custA } = await setupWorld();
  assert.equal((await api('POST', '/exchange-rates', { token: tokens.admin, body: { rate: 10000 } })).status, 201);
  const slsh = await createSlshInvoice(tokens.cashier, custA, 100000);
  await pay(tokens.cashier, slsh, 40000, 'slsh', 'SLSH');
  const g = await api('GET', `/invoices/${slsh.id}`, { token: tokens.admin });
  assert.equal(g.status, 200);
  const b = g.data.balance;
  assert.equal(b.currency, 'SLSH');
  assert.equal(num(b.paid), 40000);
  assert.equal(num(b.outstanding), 60000);
  assert.equal(num(b.netTotal), 100000);
  assert.equal(num(b.slsh.outstanding), 60000);
  assert.equal(num(b.usd.netTotal), 10);
  assert.equal(num(b.usd.paid), 4);
  assert.equal(num(b.usd.outstanding), 6);
  assert.equal(num(b.rate.rate), 10000);
  assert.ok(b.rate.id && b.rate.effective_from);

  const usd = await createInvoice(tokens.cashier, custA, 10);
  await pay(tokens.cashier, usd, 4);
  const u = (await api('GET', `/invoices/${usd.id}`, { token: tokens.admin })).data.balance;
  assert.equal(u.currency, 'USD');
  assert.equal(num(u.outstanding), 6);
  assert.equal(num(u.usd.outstanding), 6);
  assert.equal(num(u.slsh.netTotal), 100000);
  assert.equal(num(u.slsh.outstanding), 60000);
  assert.equal(num(u.rate.rate), 10000);
});

// ---- fix round 1: frozen invoice-currency value, debts, tolerance, ZAAD pre-check ----
test('SLSH invoice paid in USD stays paid after the exchange rate changes; extra payment rejected', async () => {
  const { tokens, custA } = await setupWorld();
  assert.equal((await api('POST', '/exchange-rates', { token: tokens.admin, body: { rate: 10000 } })).status, 201);
  const inv = await createSlshInvoice(tokens.cashier, custA, 100000);
  const p = await pay(tokens.cashier, inv, 10, 'cash', 'USD');
  assert.equal(p.status, 201);
  assert.equal(p.data.invoice_status, 'paid');
  assert.equal(p.data.outstanding_currency, 'SLSH');
  const row = await db.query('SELECT amount_invoice_currency, conversion_rate_id FROM payments WHERE id = $1', [p.data.id]);
  assert.equal(num(row.rows[0].amount_invoice_currency), 100000);
  assert.ok(row.rows[0].conversion_rate_id);
  assert.equal((await api('POST', '/exchange-rates', { token: tokens.admin, body: { rate: 9000 } })).status, 201);
  const b = (await api('GET', `/invoices/${inv.id}`, { token: tokens.admin })).data;
  assert.equal(b.status, 'paid');
  assert.equal(num(b.balance.outstanding), 0);
  assert.equal(num(b.balance.paid), 100000);
  assert.equal((await pay(tokens.cashier, inv, 1, 'cash', 'USD')).status, 409);
  assert.equal((await pay(tokens.cashier, inv, 1000, 'slsh', 'SLSH')).status, 409);
});

test('SLSH invoice closes with a whole-cent USD payment (half-cent SLSH tolerance)', async () => {
  const { tokens, custA } = await setupWorld();
  assert.equal((await api('POST', '/exchange-rates', { token: tokens.admin, body: { rate: 8500 } })).status, 201);
  const a = await createSlshInvoice(tokens.cashier, custA, 100000);
  const ok = await pay(tokens.cashier, a, 11.76, 'cash', 'USD');
  assert.equal(ok.status, 201);
  assert.equal(ok.data.invoice_status, 'paid');
  assert.equal(num(ok.data.outstanding), 0);
  const debts = await db.query("SELECT 1 FROM debts WHERE invoice_id = $1 AND status = 'unpaid'", [a.id]);
  assert.equal(debts.rows.length, 0);
  const b = await createSlshInvoice(tokens.cashier, custA, 100000);
  assert.equal((await pay(tokens.cashier, b, 11.77, 'cash', 'USD')).status, 409);
});

test('auto-debt on an SLSH invoice is SLSH and reports/portal convert it to USD', async () => {
  const { tokens, custA } = await setupWorld();
  assert.equal((await api('POST', '/exchange-rates', { token: tokens.admin, body: { rate: 10000 } })).status, 201);
  const inv = await createSlshInvoice(tokens.cashier, custA, 100000);
  const p = await pay(tokens.cashier, inv, 40000, 'slsh', 'SLSH');
  assert.equal(p.status, 201);
  const d = await db.query("SELECT amount, currency FROM debts WHERE invoice_id = $1 AND status = 'unpaid'", [inv.id]);
  assert.equal(d.rows[0].currency, 'SLSH');
  assert.equal(num(d.rows[0].amount), 60000);
  const { getRevenueForPeriod } = require('../lib/reportsCalculations');
  const base = await getRevenueForPeriod({ periodStart: new Date(Date.now() - 86400000), periodEnd: new Date(Date.now() + 86400000), zoneId: null });
  // the SLSH debt (60,000 / 10,000 = $6) must not be added as 60,000
  assert.ok(base.debt < 60000, 'debt total must be USD-converted: ' + base.debt);
  assert.ok(base.debt >= 6 - 0.001);
  // update-in-place keeps the currency
  await pay(tokens.cashier, inv, 10000, 'slsh', 'SLSH');
  const d2 = await db.query("SELECT amount, currency FROM debts WHERE invoice_id = $1 AND status = 'unpaid'", [inv.id]);
  assert.equal(d2.rows[0].currency, 'SLSH');
  assert.equal(num(d2.rows[0].amount), 50000);
});

test('ZAAD pre-check: USD payment on an SLSH invoice with no exchange rate is blocked before the gateway', async () => {
  const { tokens, custA } = await setupWorld();
  assert.equal((await api('POST', '/exchange-rates', { token: tokens.admin, body: { rate: 10000 } })).status, 201);
  const inv = await createSlshInvoice(tokens.cashier, custA, 100000);
  const row = (await db.query('SELECT * FROM invoices WHERE id = $1', [inv.id])).rows[0];
  const { precheckPayment } = require('../routes/payments');
  const noRateClient = { query: async (sql) => ({ rows: [] }) };
  const r = await precheckPayment(noRateClient, row, { amt: 5, cur: 'USD' });
  assert.equal(r.status, 409);
  assert.equal(r.code, 'NO_EXCHANGE_RATE');
  assert.equal(await precheckPayment(db, row, { amt: 5, cur: 'USD' }), null);
  const over = await precheckPayment(db, row, { amt: 11, cur: 'USD' });
  assert.equal(over.code, 'OVERPAYMENT');
});
