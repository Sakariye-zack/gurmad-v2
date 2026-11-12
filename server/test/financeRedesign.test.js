const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, createInvoice } = require('./helpers');

// Finance redesign: read-only Transactions listing / summary / CSV over the
// payments ledger, plus the read-only extras on the invoices list/detail the
// Billing workspace and the printed invoice use. The ZAAD gateway is the
// test stub (test/stubzaad.js): 0699 01 xxxx approves immediately.

const BASE = process.env.TEST_BASE;
const pay = (token, inv, amount, extra = {}) => api('POST', '/payments', { token, body: { invoice_id: inv.id, amount, currency: 'USD', method: 'cash', ...extra } });
const tx = (token, qs = '') => api('GET', `/payments/transactions${qs ? `?${qs}` : ''}`, { token });
const summary = (token, qs = '') => api('GET', `/payments/transactions/summary${qs ? `?${qs}` : ''}`, { token });
const magicPhone = () => `069901${String(Date.now()).slice(-4)}`;

let fixture;
async function world() {
  if (fixture) return fixture;
  const w = await setupWorld();
  const invA1 = await createInvoice(w.tokens.admin, w.custA, 40);
  const invA2 = await createInvoice(w.tokens.admin, w.custA, 25);
  const invA3 = await createInvoice(w.tokens.admin, w.custA, 30);
  const invB = await createInvoice(w.tokens.admin, w.custB, 18);
  // cashier (zone A): cash 10 on A1 and a debt-marked 5 on A1
  const p1 = await pay(w.tokens.cashier, invA1, 10);
  assert.equal(p1.status, 201, JSON.stringify(p1.body));
  assert.equal((await pay(w.tokens.cashier, invA1, 5, { method: 'debt' })).status, 201);
  // admin: manual ZAAD with a reference code on A2
  const ref = `MANREF${Date.now()}`;
  const p2 = await pay(w.tokens.admin, invA2, 7, { method: 'zaad', reference_code: ref });
  assert.equal(p2.status, 201, JSON.stringify(p2.body));
  // cashier: ZAAD push (stub-approved) on A3
  const z = await api('POST', '/payments/zaad-request', { token: w.tokens.cashier, body: { invoice_id: invA3.id, phone: magicPhone(), amount: 12, currency: 'USD' } });
  assert.equal(z.status, 201, JSON.stringify(z.body));
  // cashier B (zone B) on B
  const pB = await pay(w.tokens.cashierB, invB, 9);
  assert.equal(pB.status, 201, JSON.stringify(pB.body));
  // a reversed cash payment by the cashier on A2
  const pr = await pay(w.tokens.cashier, invA2, 3);
  assert.equal(pr.status, 201);
  assert.equal((await api('PUT', `/payments/${pr.data.id}/reverse`, { token: w.tokens.admin, body: { reason: 'test reversal' } })).status, 200);
  fixture = { w, invA1, invA2, invA3, invB, ref, zaadTx: z.data.reference_code, reversedId: pr.data.id };
  return fixture;
}

test('transactions: RBAC — head of cashiers and collector are refused; viewer roles allowed', async () => {
  const { w } = await world();
  for (const k of ['head', 'collector']) {
    assert.equal((await tx(w.tokens[k])).status, 403, k);
    assert.equal((await summary(w.tokens[k])).status, 403, k);
  }
  for (const k of ['admin', 'cashier', 'gudoomiye', 'accountant']) assert.equal((await tx(w.tokens[k])).status, 200, k);
  const anon = await fetch(BASE + '/api/v2/payments/transactions');
  assert.equal(anon.status, 401);
});

test('transactions: admin sees every payment with invoice/customer/cashier fields', async () => {
  const { w, invA1, invB, zaadTx } = await world();
  const a = await tx(w.tokens.admin, `q=${invA1.invoice_number}`);
  assert.equal(a.status, 200);
  assert.equal(a.body.meta.total, 2);
  const row = a.data.find((r) => r.method === 'cash');
  assert.equal(row.invoice_number, invA1.invoice_number);
  assert.equal(row.customer_name, 'Test Customer A');
  assert.equal(row.cashier_id, w.ids.t_cashier);
  assert.equal(row.cashier_name, 't_cashier');
  assert.equal(row.channel, null);
  assert.equal((await tx(w.tokens.admin, `q=${invB.invoice_number}`)).body.meta.total, 1);
  // search by ZAAD transaction id
  const z = await tx(w.tokens.admin, `q=${zaadTx}`);
  assert.equal(z.body.meta.total, 1);
  assert.equal(z.data[0].method, 'zaad');
});

test('transactions: filters — method, currency, status, channel, date range, search by reference', async () => {
  const { w, invA1, invA2, ref } = await world();
  const zaadA2 = await tx(w.tokens.admin, `q=${invA2.invoice_number}&method=zaad`);
  assert.equal(zaadA2.body.meta.total, 1);
  assert.equal(zaadA2.data[0].reference_code, ref);
  assert.equal((await tx(w.tokens.admin, `q=${ref}`)).body.meta.total, 1);
  const rev = await tx(w.tokens.admin, `q=${invA2.invoice_number}&status=reversed`);
  assert.equal(rev.body.meta.total, 1);
  assert.equal(rev.data[0].reversed_reason, 'test reversal');
  assert.equal((await tx(w.tokens.admin, `q=${invA2.invoice_number}&status=recorded`)).body.meta.total, 1);
  assert.equal((await tx(w.tokens.admin, `q=${invA1.invoice_number}&currency=SLSH`)).body.meta.total, 0);
  assert.equal((await tx(w.tokens.admin, `q=${invA1.invoice_number}&currency=usd`)).body.meta.total, 2);
  assert.equal((await tx(w.tokens.admin, `q=${invA1.invoice_number}&channel=staff`)).body.meta.total, 2);
  assert.equal((await tx(w.tokens.admin, `q=${invA1.invoice_number}&channel=portal`)).body.meta.total, 0);
  assert.equal((await tx(w.tokens.admin, `q=${invA1.invoice_number}&date_from=2099-01-01`)).body.meta.total, 0);
  assert.equal((await tx(w.tokens.admin, `q=${invA1.invoice_number}&date_to=2000-01-01`)).body.meta.total, 0);
  assert.equal((await tx(w.tokens.admin, `q=${invA1.invoice_number}&date_from=2000-01-01&date_to=2099-12-31`)).body.meta.total, 2);
  // validation
  for (const qs of ['method=bitcoin', 'currency=EUR', 'channel=fax', 'status=pending', 'date_from=12-01-2026', 'date_to=nope']) {
    const r = await tx(w.tokens.admin, qs);
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.error.code, 'VALIDATION');
  }
});

test('transactions: pagination with meta.total and newest first', async () => {
  const { w } = await world();
  const all = await tx(w.tokens.admin, 'page_size=100');
  assert.ok(all.body.meta.total >= 6);
  const p1 = await tx(w.tokens.admin, 'page_size=2&page=1');
  const p2 = await tx(w.tokens.admin, 'page_size=2&page=2');
  assert.equal(p1.data.length, 2);
  assert.equal(p1.body.meta.page_size, 2);
  assert.equal(p1.body.meta.total, all.body.meta.total);
  assert.notEqual(p1.data[0].id, p2.data[0].id);
  assert.ok(new Date(p1.data[0].created_at) >= new Date(p1.data[1].created_at));
  assert.equal((await tx(w.tokens.admin, 'page_size=500')).body.meta.page_size, 100);
});

test('transactions: cashier sees ONLY payments they recorded (never other cashiers, admin or portal)', async () => {
  const { w, invA2, invB } = await world();
  const r = await tx(w.tokens.cashier, 'page_size=100');
  assert.equal(r.status, 200);
  assert.ok(r.data.length > 0);
  for (const row of r.data) assert.equal(row.cashier_id, w.ids.t_cashier);
  // admin's manual ZAAD on A2 (same zone) is not the cashier's
  const a2 = await tx(w.tokens.cashier, `q=${invA2.invoice_number}`);
  assert.ok(a2.data.every((x) => x.method !== 'zaad'));
  assert.equal((await tx(w.tokens.cashier, `q=${invB.invoice_number}`)).body.meta.total, 0);
  const rb = await tx(w.tokens.cashierB, 'page_size=100');
  for (const row of rb.data) assert.equal(row.cashier_id, w.ids.t_cashier_b);
});

test('transactions: gudoomiye / zone accountant are zone-scoped (all cashiers in zone, not other zones)', async () => {
  const { w, invA2, invB } = await world();
  for (const k of ['gudoomiye', 'accountant']) {
    assert.equal((await tx(w.tokens[k], `q=${invA2.invoice_number}`)).body.meta.total, 2, k); // admin zaad + reversed cash
    assert.equal((await tx(w.tokens[k], `q=${invB.invoice_number}`)).body.meta.total, 0, k);
    const all = await tx(w.tokens[k], 'page_size=100');
    const zoneA = (await db.query(`SELECT COUNT(*)::int AS n FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = i.customer_id WHERE c.zone_id = $1`, [w.zoneA.id])).rows[0].n;
    assert.equal(all.body.meta.total, zoneA, k);
  }
});

test('transactions summary: received today/month by currency, method, channel; debt + reversed excluded', async () => {
  const { w } = await world();
  const before = (await summary(w.tokens.cashier)).data;
  assert.ok(before.date && before.period && before.timezone);
  const inv = await createInvoice(w.tokens.admin, w.custA, 50);
  assert.equal((await pay(w.tokens.cashier, inv, 4)).status, 201);
  assert.equal((await pay(w.tokens.cashier, inv, 6, { method: 'edahab' })).status, 201);
  assert.equal((await pay(w.tokens.cashier, inv, 2, { method: 'debt' })).status, 201);
  const rv = await pay(w.tokens.cashier, inv, 1);
  await api('PUT', `/payments/${rv.data.id}/reverse`, { token: w.tokens.admin, body: { reason: 'x' } });
  const after = (await summary(w.tokens.cashier)).data;
  const near = (a, b) => assert.ok(Math.abs(a - b) < 0.0001, `${a} vs ${b}`);
  for (const period of ['today', 'month']) {
    near(after[period].total_usd - before[period].total_usd, 10);
    near(after[period].count - before[period].count, 2);
    near(after[period].by_currency.USD - before[period].by_currency.USD, 10);
    near(after[period].by_method.cash - before[period].by_method.cash, 4);
    near(after[period].by_method.edahab - before[period].by_method.edahab, 6);
    near(after[period].by_channel.staff - before[period].by_channel.staff, 10);
    near(after[period].debt_usd - before[period].debt_usd, 2);
    near(after[period].reversed_usd - before[period].reversed_usd, 1);
  }
  // filtered block follows the filters
  const f = (await summary(w.tokens.admin, `q=${inv.invoice_number}`)).data.filtered;
  near(f.total_usd, 10);
  near(f.reversed_count, 1);
  // cashier B's summary does not move with cashier A's payments
  const b1 = (await summary(w.tokens.cashierB)).data.today.total_usd;
  assert.equal((await pay(w.tokens.cashier, inv, 3)).status, 201);
  near((await summary(w.tokens.cashierB)).data.today.total_usd, b1);
  assert.equal((await summary(w.tokens.admin, 'method=nope')).status, 400);
});

test('transactions CSV: authorized, scoped, formula-safe', async () => {
  const { w, invA1, invB } = await world();
  const get = (token, qs = '') => fetch(`${BASE}/api/v2/payments/transactions.csv${qs}`, { headers: { Authorization: 'Bearer ' + token } });
  const r = await get(w.tokens.admin);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  const body = await r.text();
  assert.ok(body.includes('"Invoice"'));
  assert.ok(body.includes(invA1.invoice_number));
  assert.ok(body.includes(invB.invoice_number));
  const c = await (await get(w.tokens.cashier)).text();
  assert.ok(!c.includes(invB.invoice_number));
  assert.equal((await get(w.tokens.collector)).status, 403);
  assert.equal((await get(w.tokens.admin, '?method=zzz')).status, 400);
  // a customer name starting with '=' is neutralised
  await db.query(`UPDATE customers SET name = '=HYPERLINK(1)' WHERE id = $1`, [w.custB.id]);
  try {
    const t = await (await get(w.tokens.admin, `?q=${invB.invoice_number}`)).text();
    assert.ok(t.includes(`"'=HYPERLINK(1)"`));
  } finally {
    await db.query(`UPDATE customers SET name = 'Test Customer B' WHERE id = $1`, [w.custB.id]);
  }
});

test('invoices list: open=1 filters to unpaid/partial; with_balance adds the authoritative balance + customer path/phones', async () => {
  const { w, invA1 } = await world();
  const paidInv = await createInvoice(w.tokens.admin, w.custA, 5);
  assert.equal((await pay(w.tokens.admin, paidInv, 5)).status, 201);
  const r = await api('GET', '/invoices?open=1&with_balance=1', { token: w.tokens.admin });
  assert.equal(r.status, 200);
  assert.ok(r.data.every((i) => i.status === 'unpaid' || i.status === 'partial'));
  assert.ok(!r.data.some((i) => i.id === paidInv.id));
  const a1 = r.data.find((i) => i.id === invA1.id);
  assert.equal(a1.status, 'partial');
  assert.equal(Number(a1.balance.outstanding), 25); // 40 - 10 cash - 5 debt-marked
  assert.ok('customer_path' in a1 && 'customer_whatsapp' in a1 && 'customer_alternate_phone' in a1);
  // without open=1, with_balance is ignored (bounded work)
  const plain = await api('GET', '/invoices?with_balance=1', { token: w.tokens.admin });
  assert.ok(plain.data.every((i) => i.balance === undefined));
  // zone scoping unchanged
  const c = await api('GET', '/invoices?open=1', { token: w.tokens.cashier });
  assert.ok(c.data.every((i) => i.customer_id !== w.custB.id));
});

test('invoice detail: company block, cashier names on payments, creator name', async () => {
  const { w, invA1 } = await world();
  const r = await api('GET', `/invoices/${invA1.id}`, { token: w.tokens.cashier });
  assert.equal(r.status, 200);
  assert.ok(r.data.company && typeof r.data.company.name === 'string');
  assert.ok('address' in r.data.company && 'phone' in r.data.company && 'email' in r.data.company);
  assert.equal(r.data.created_by_name, 't_admin');
  assert.ok(r.data.payments.every((p) => p.cashier_name === 't_cashier'));
  assert.equal((await api('GET', `/invoices/${invA1.id}`, { token: w.tokens.cashierB })).status, 403);
});
