const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, setupWorld, createInvoice } = require('./helpers');

const num = (x) => Number(x);
const revenue = async (token) => api('GET', '/reports/revenue?period=today', { token });

test('revenue report counts exactly the cash collected, including the paid part of a Partial invoice', async () => {
  const w = await setupWorld();
  const before = await revenue(w.tokens.admin);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const base = num(before.data.collected);

  const inv = await createInvoice(w.tokens.cashier, w.custA, 40);
  const p = await api('POST', '/payments', { token: w.tokens.cashier, body: { invoice_id: inv.id, amount: 15, currency: 'USD', method: 'cash' } });
  assert.equal(p.data.invoice_status, 'partial');

  const after = await revenue(w.tokens.admin);
  assert.equal(num(after.data.collected) - base, 15, 'only the $15 actually collected is revenue, not the $40 invoice and not $0');
});

test('revenue is zone-scoped for gudoomiye and own-payments-only for cashier', async () => {
  const w = await setupWorld();
  const invB = await createInvoice(w.tokens.admin, w.custB, 9);
  assert.equal((await api('POST', '/payments', { token: w.tokens.cashierB, body: { invoice_id: invB.id, amount: 9, currency: 'USD', method: 'cash' } })).status, 201);
  const get = async (t) => num((await revenue(t)).data.collected);
  const admin = await get(w.tokens.admin);
  const gud = await get(w.tokens.gudoomiye);
  const cashierB = await get(w.tokens.cashierB);
  assert.ok(gud < admin, 'gudoomiye (zone A) sees less than admin (all zones)');
  assert.equal(cashierB, 9, 'cashier B only sees their own $9');
});

test('collector cannot read financial reports; operational reports are not open to cashiers', async () => {
  const w = await setupWorld();
  assert.equal((await revenue(w.tokens.collector)).status, 403);
  assert.equal((await api('GET', '/reports/executive-summary?period=today', { token: w.tokens.cashier })).status, 403);
});

test('voided invoices are excluded from outstanding totals', async () => {
  const w = await setupWorld();
  const read = async () => num((await revenue(w.tokens.admin)).data.outstanding ?? 0);
  const before = await read();
  const inv = await createInvoice(w.tokens.cashier, w.custA, 33);
  assert.equal((await read()) - before, 33);
  await api('PUT', `/invoices/${inv.id}/void`, { token: w.tokens.admin, body: { reason: 'test void' } });
  assert.equal(await read(), before, 'voiding removes it from outstanding');
});
