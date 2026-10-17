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
  const p2 = await pay(tokens.cashier, inv, 15, 'zaad');
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
  assert.equal((await api('PUT', `/debts/${d.data.id}/status`, { token: tokens.cashier, body: { status: 'paid' } })).status, 200);
  assert.equal((await api('PUT', `/debts/${d.data.id}/status`, { token: tokens.cashier, body: { status: 'paid' } })).status, 409, 'cannot settle twice');
});
