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
  // admin on B (zone B). Not cashier B: reports.test.js asserts cashier B's
  // cumulative revenue for today, so this file must not add to it.
  const pB = await pay(w.tokens.admin, invB, 9);
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

// ---------------------------------------------------------------------
// Fix round: staff ZAAD in-flight guard (shared with the portal),
// prechecks, validation, reference rules, set-based balances, fail-closed.
// ---------------------------------------------------------------------
const bcrypt = require('bcrypt');
const { insertUser, tokenFor, PASSWORD } = require('./helpers');
let seq = 0;
const uniq4 = () => `${Date.now().toString().slice(-3)}${String(++seq).padStart(3, '0')}`.slice(-4);
const magic = (kind) => `0699${kind}${uniq4()}`;
const zaadReq = (token, inv, body) => api('POST', '/payments/zaad-request', { token, body: { invoice_id: inv.id, currency: 'USD', ...body } });
const attempts = async (invId) => (await db.query('SELECT * FROM portal_zaad_attempts WHERE invoice_id = $1 ORDER BY id', [invId])).rows;
async function currentRate() {
  const r = await db.query('SELECT rate FROM exchange_rates WHERE effective_from <= NOW() ORDER BY effective_from DESC LIMIT 1');
  return r.rows[0] ? Number(r.rows[0].rate) : null;
}
async function ensureRate(w) {
  if (!(await currentRate())) assert.equal((await api('POST', '/exchange-rates', { token: w.tokens.admin, body: { rate: 11000 } })).status, 201);
  return currentRate();
}
async function portalCustomer(w) {
  const n = uniq4();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: { customer_type: 'residential', name: `FinPortal ${n}${Date.now()}`, phone: magic('01'), zone_id: w.zoneA.id, door_number: `8${n}${seq}`, fee: 5 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const hash = await bcrypt.hash(PASSWORD, 4);
  await db.query(`INSERT INTO customer_portal_accounts (customer_id, password_hash, status) VALUES ($1,$2,'active')`, [r.data.id, hash]);
  const login = await api('POST', '/customer-portal/auth/login', { body: { phone: r.data.phone, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { ...r.data, token: login.data.token };
}

test('staff ZAAD: second request while one is in flight -> 409 ZAAD_IN_PROGRESS; per-attempt reference', async () => {
  const w = await setupWorld();
  const inv = await createInvoice(w.tokens.admin, w.custA, 20);
  const slow = zaadReq(w.tokens.cashier, inv, { phone: magic('03'), amount: 5 });
  await new Promise((r) => setTimeout(r, 300));
  const second = await zaadReq(w.tokens.cashier, inv, { phone: magic('01'), amount: 5 });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.error.code, 'ZAAD_IN_PROGRESS');
  const mid = await api('GET', `/invoices/${inv.id}`, { token: w.tokens.cashier });
  assert.equal(mid.data.zaad_in_progress, true);
  const first = await slow;
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const att = await attempts(inv.id);
  assert.equal(att.length, 1);
  assert.equal(att[0].source, 'staff');
  assert.equal(att[0].staff_user_id, w.ids.t_cashier);
  assert.equal(att[0].status, 'ok');
  assert.equal(att[0].reference, `${inv.invoice_number}-A${att[0].id}`);
  assert.equal(first.data.attempt_reference, att[0].reference);
  const after = await api('GET', `/invoices/${inv.id}`, { token: w.tokens.cashier });
  assert.equal(after.data.zaad_in_progress, false);
  assert.equal(after.data.zaad_blocked_until, null);
});

test('staff ZAAD: unknown outcome -> audit + admin alert, then PAYMENT_UNCONFIRMED and flags on detail + open list', async () => {
  const w = await setupWorld();
  const inv = await createInvoice(w.tokens.admin, w.custA, 9);
  const t = await zaadReq(w.tokens.cashier, inv, { phone: magic('05'), amount: 3 });
  assert.equal(t.status, 504);
  assert.equal(t.body.error.code, 'ZAAD_UNKNOWN');
  const att = await attempts(inv.id);
  assert.equal(att[0].status, 'unknown');
  const audit = await db.query(`SELECT actor_id, after_data FROM v2_audit_log WHERE action = 'payment.zaad_reconciliation_required' AND entity_id = $1`, [inv.id]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].actor_id, w.ids.t_cashier);
  assert.equal(audit.rows[0].after_data.source, 'staff');
  assert.equal(audit.rows[0].after_data.reference, att[0].reference);
  const notes = await db.query(`SELECT n.* FROM v2_staff_notifications n JOIN v2_users u ON u.id = n.recipient_id WHERE n.event_type = 'payment.zaad_reconciliation' AND n.entity_id = $1 AND u.username = 't_admin'`, [inv.id]);
  assert.equal(notes.rows.length, 1);
  const again = await zaadReq(w.tokens.admin, inv, { phone: magic('01'), amount: 3 });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'PAYMENT_UNCONFIRMED');
  assert.equal((await attempts(inv.id)).length, 1, 'no second attempt row, no gateway call');
  const d = await api('GET', `/invoices/${inv.id}`, { token: w.tokens.cashier });
  assert.ok(d.data.zaad_blocked_until && new Date(d.data.zaad_blocked_until) > new Date());
  const list = await api('GET', `/invoices?open=1&q=${inv.invoice_number}`, { token: w.tokens.cashier });
  assert.ok(list.data[0].zaad_blocked_until);
  // manual recording stays possible (admin resolves it with the real code)
  assert.equal((await pay(w.tokens.admin, inv, 3, { method: 'zaad', reference_code: `RESOLVE${Date.now()}` })).status, 201);
  await db.query(`UPDATE portal_zaad_attempts SET finished_at = NOW() - INTERVAL '16 minutes', created_at = NOW() - INTERVAL '16 minutes' WHERE invoice_id = $1`, [inv.id]);
  assert.equal((await zaadReq(w.tokens.cashier, inv, { phone: magic('01'), amount: 3 })).status, 201);
});

test('staff ZAAD: transport error -> 502 GATEWAY_ERROR, attempt unknown, invoice blocked', async () => {
  const w = await setupWorld();
  const inv = await createInvoice(w.tokens.admin, w.custA, 9);
  const r = await zaadReq(w.tokens.cashier, inv, { phone: magic('04'), amount: 2 });
  assert.equal(r.status, 502);
  assert.equal(r.body.error.code, 'GATEWAY_ERROR');
  assert.equal((await attempts(inv.id))[0].status, 'unknown');
  assert.equal((await zaadReq(w.tokens.cashier, inv, { phone: magic('01'), amount: 2 })).body.error.code, 'PAYMENT_UNCONFIRMED');
});

test('staff ZAAD: an unresolved reconciliation-required attempt also blocks a new push', async () => {
  const w = await setupWorld();
  const inv = await createInvoice(w.tokens.admin, w.custA, 9);
  await db.query(`INSERT INTO portal_zaad_attempts (customer_id, invoice_id, amount, currency, phone, status, source, finished_at) VALUES ($1,$2,1,'USD','x','reconciliation_required','staff',NOW())`, [w.custA.id, inv.id]);
  const r = await zaadReq(w.tokens.cashier, inv, { phone: magic('01'), amount: 2 });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'PAYMENT_UNCONFIRMED');
});

test('ZAAD: a portal attempt and a staff attempt on the same invoice exclude each other', async () => {
  const w = await setupWorld();
  const c = await portalCustomer(w);
  const inv1 = await createInvoice(w.tokens.admin, c, 10);
  await db.query(`INSERT INTO portal_zaad_attempts (customer_id, invoice_id, amount, currency, phone, reference) VALUES ($1,$2,1,'USD','x','R-P')`, [c.id, inv1.id]);
  const s1 = await zaadReq(w.tokens.cashier, inv1, { phone: magic('01'), amount: 2 });
  assert.equal(s1.status, 409);
  assert.equal(s1.body.error.code, 'ZAAD_IN_PROGRESS');
  const inv2 = await createInvoice(w.tokens.admin, c, 10);
  const slow = zaadReq(w.tokens.cashier, inv2, { phone: magic('03'), amount: 2 });
  await new Promise((r) => setTimeout(r, 300));
  const p2 = await api('POST', `/customer-portal/invoices/${inv2.id}/pay-zaad`, { token: c.token, body: {} });
  assert.equal(p2.status, 409, JSON.stringify(p2.body));
  assert.equal(p2.body.error.code, 'IN_PROGRESS');
  assert.equal((await slow).status, 201);
  const inv3 = await createInvoice(w.tokens.admin, c, 10);
  assert.equal((await zaadReq(w.tokens.cashier, inv3, { phone: magic('05'), amount: 2 })).status, 504);
  const p3 = await api('POST', `/customer-portal/invoices/${inv3.id}/pay-zaad`, { token: c.token, body: {} });
  assert.equal(p3.status, 409);
  assert.equal(p3.body.error.code, 'PAYMENT_UNCONFIRMED');
  const portalCounted = await db.query(`SELECT COUNT(*)::int AS n FROM portal_zaad_attempts WHERE customer_id = $1 AND source = 'portal'`, [c.id]);
  assert.equal(portalCounted.rows[0].n, 1, 'staff attempts never count toward the portal rate limit');
});

test('ZAAD precheck: cross-currency push is converted and an overpay is refused before the gateway', async () => {
  const w = await setupWorld();
  const rate = await ensureRate(w);
  const inv = await createInvoice(w.tokens.admin, w.custA, 10);
  const over = await zaadReq(w.tokens.cashier, inv, { phone: magic('01'), amount: Math.round(11 * rate), currency: 'SLSH' });
  assert.equal(over.status, 409, JSON.stringify(over.body));
  assert.equal(over.body.error.code, 'OVERPAYMENT');
  assert.equal((await attempts(inv.id)).length, 0, 'refused before any attempt / gateway call');
  const ok = await zaadReq(w.tokens.cashier, inv, { phone: magic('01'), amount: Math.round(4 * rate), currency: 'SLSH' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const slshInv = (await api('POST', '/invoices', { token: w.tokens.admin, body: { customer_id: w.custA.id, invoice_total: Math.round(2 * rate), currency: 'SLSH' } })).data;
  const over2 = await zaadReq(w.tokens.cashier, slshInv, { phone: magic('01'), amount: 3, currency: 'USD' });
  assert.equal(over2.status, 409);
  assert.equal(over2.body.error.code, 'OVERPAYMENT');
  assert.equal((await attempts(slshInv.id)).length, 0);
});

test('amount precision: SLSH whole numbers, USD max 2 decimals (POST /payments and zaad-request)', async () => {
  const w = await setupWorld();
  await ensureRate(w);
  const inv = await createInvoice(w.tokens.admin, w.custA, 50);
  for (const [amount, currency] of [[100.5, 'SLSH'], [1.234, 'USD'], ['2.001', 'USD']]) {
    const a = await api('POST', '/payments', { token: w.tokens.cashier, body: { invoice_id: inv.id, amount, currency, method: 'cash' } });
    assert.equal(a.status, 400, `${amount} ${currency}`);
    assert.equal(a.body.error.code, 'VALIDATION');
    const z = await zaadReq(w.tokens.cashier, inv, { phone: magic('01'), amount, currency });
    assert.equal(z.status, 400, `zaad ${amount} ${currency}`);
  }
  assert.equal((await api('POST', '/payments', { token: w.tokens.cashier, body: { invoice_id: inv.id, amount: 1.25, currency: 'USD', method: 'cash' } })).status, 201);
  assert.equal((await api('POST', '/payments', { token: w.tokens.cashier, body: { invoice_id: inv.id, amount: 1000, currency: 'SLSH', method: 'slsh' } })).status, 201);
  assert.equal((await attempts(inv.id)).length, 0);
});

test('manual ZAAD payment: reference required (<=50) and unique among recorded ZAAD payments', async () => {
  const w = await setupWorld();
  const inv = await createInvoice(w.tokens.admin, w.custA, 50);
  const body = (extra) => ({ invoice_id: inv.id, amount: 1, currency: 'USD', method: 'zaad', ...extra });
  for (const ref of [undefined, '', '   ']) {
    const r = await api('POST', '/payments', { token: w.tokens.cashier, body: body({ reference_code: ref }) });
    assert.equal(r.status, 400, JSON.stringify(ref));
  }
  assert.equal((await api('POST', '/payments', { token: w.tokens.cashier, body: body({ reference_code: 'X'.repeat(51) }) })).status, 400);
  const longCash = await api('POST', '/payments', { token: w.tokens.cashier, body: { ...body({ reference_code: 'Y'.repeat(51) }), method: 'cash' } });
  assert.equal(longCash.status, 400, 'over-long reference is a 400, never a 500');
  const ref = `UNIQ${Date.now()}`;
  const first = await api('POST', '/payments', { token: w.tokens.cashier, body: body({ reference_code: ref }) });
  assert.equal(first.status, 201);
  const dup = await api('POST', '/payments', { token: w.tokens.cashier, body: body({ reference_code: ` ${ref} ` }) });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DUPLICATE_REFERENCE');
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM payments WHERE invoice_id = $1', [inv.id])).rows[0].n, 1);
  assert.equal((await api('PUT', `/payments/${first.data.id}/reverse`, { token: w.tokens.admin, body: { reason: 'wrong invoice' } })).status, 200);
  assert.equal((await api('POST', '/payments', { token: w.tokens.cashier, body: body({ reference_code: ref }) })).status, 201, 'a reversed code can be recorded again');
  assert.equal((await db.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_payments_zaad_reference'`)).rows.length, 1);
});

test('open invoices: set-based balances equal getInvoiceBalance (partial, SLSH, USD-on-SLSH, reversed, debt-method, legacy)', async () => {
  const w = await setupWorld();
  const rate = await ensureRate(w);
  const A = w.tokens.admin;
  const mkSlsh = async (total) => (await api('POST', '/invoices', { token: A, body: { customer_id: w.custA.id, invoice_total: total, currency: 'SLSH' } })).data;
  const usdPartial = await createInvoice(A, w.custA, 30);
  await pay(A, usdPartial, 7.5);
  const usdWithSlsh = await createInvoice(A, w.custA, 30);
  await api('POST', '/payments', { token: A, body: { invoice_id: usdWithSlsh.id, amount: Math.round(3 * rate), currency: 'SLSH', method: 'slsh' } });
  const slsh = await mkSlsh(Math.round(5 * rate));
  await api('POST', '/payments', { token: A, body: { invoice_id: slsh.id, amount: 1000, currency: 'SLSH', method: 'slsh' } });
  await pay(A, slsh, 1.5);
  const reversed = await createInvoice(A, w.custA, 12);
  const rv = await pay(A, reversed, 4);
  await pay(A, reversed, 2);
  await api('PUT', `/payments/${rv.data.id}/reverse`, { token: A, body: { reason: 'x' } });
  const debt = await createInvoice(A, w.custA, 12);
  await pay(A, debt, 5, { method: 'debt' });
  await pay(A, debt, 1);
  const discounted = (await api('POST', '/invoices', { token: A, body: { customer_id: w.custA.id, invoice_total: 20, discount_amount: 5 } })).data;
  await pay(A, discounted, 3);
  const legacy = await mkSlsh(Math.round(6 * rate));
  const lp = await pay(A, legacy, 2);
  await db.query('UPDATE payments SET amount_invoice_currency = NULL WHERE id = $1', [lp.data.id]);

  const list = await api('GET', '/invoices?open=1&with_balance=1&page_size=500', { token: A });
  assert.equal(list.status, 200);
  const byId = new Map(list.data.map((i) => [i.id, i]));
  for (const inv of [usdPartial, usdWithSlsh, slsh, reversed, debt, discounted, legacy]) {
    const fromList = byId.get(inv.id);
    assert.ok(fromList, `invoice ${inv.id} listed`);
    const detail = (await api('GET', `/invoices/${inv.id}`, { token: A })).data.balance; // getInvoiceBalance
    for (const k of ['paid', 'outstanding', 'netTotal']) assert.ok(Math.abs(Number(fromList.balance[k]) - Number(detail[k])) < 1e-6, `${inv.id} ${k}: ${fromList.balance[k]} vs ${detail[k]}`);
    assert.equal(fromList.balance.currency, detail.currency);
    for (const blk of ['usd', 'slsh']) {
      for (const k of ['paid', 'outstanding', 'netTotal']) assert.ok(Math.abs(Number(fromList.balance[blk][k]) - Number(detail[blk][k])) < 1e-6, `${inv.id} ${blk}.${k}`);
    }
    assert.equal(Number(fromList.balance.rate.rate), Number(detail.rate.rate));
  }
  assert.ok(list.body.meta.summary.count >= 7);
  const p1 = await api('GET', '/invoices?open=1&with_balance=1&page_size=2&page=1', { token: A });
  assert.equal(p1.data.length, 2);
  assert.equal(p1.body.meta.total, list.body.meta.total);
  const onlySlsh = await api('GET', '/invoices?open=1&currency=SLSH&page_size=500', { token: A });
  assert.ok(onlySlsh.data.every((i) => i.currency === 'SLSH'));
  assert.equal(onlySlsh.body.meta.total, onlySlsh.data.length);
  const onlyPartial = await api('GET', '/invoices?open=1&status=partial&page_size=500', { token: A });
  assert.ok(onlyPartial.data.every((i) => i.status === 'partial'));
});

test('transactions: zone-scoped role with a missing or unknown zone gets nothing (fail closed)', async () => {
  const f = await world();
  await insertUser('t_gud_nozone', 'gudoomiye', null);
  await insertUser('t_acc_badzone', 'zone_accountant', 'No Such Zone');
  for (const u of ['t_gud_nozone', 't_acc_badzone']) {
    const tok = await tokenFor(u);
    const r = await tx(tok, 'page_size=100');
    assert.equal(r.status, 200);
    assert.equal(r.body.meta.total, 0, u);
    assert.equal((await summary(tok)).data.month.count, 0, u);
  }
  assert.ok((await tx(f.w.tokens.admin)).body.meta.total > 0);
});

test('transactions CSV: over the row cap -> 413 (never silently truncated); tab-leading value neutralised', async () => {
  const { w, invB } = await world();
  const inv = await createInvoice(w.tokens.admin, w.custA, 1000000);
  const adminId = (await db.query(`SELECT id FROM v2_users WHERE username = 't_admin'`)).rows[0].id;
  const marker = `BULK${Date.now()}`;
  await db.query(
    `INSERT INTO payments (invoice_id, amount, currency, method, amount_usd, cashier_id, reference_code, status, amount_invoice_currency)
     SELECT $1, 0.01, 'USD', 'cash', 0.01, $2, $3, 'recorded', 0.01 FROM generate_series(1, 20001)`,
    [inv.id, adminId, marker]
  );
  try {
    const r = await fetch(`${BASE}/api/v2/payments/transactions.csv?q=${marker}`, { headers: { Authorization: 'Bearer ' + w.tokens.admin } });
    assert.equal(r.status, 413);
    assert.equal((await r.json()).error.code, 'TOO_MANY_ROWS');
  } finally {
    await db.query('DELETE FROM payments WHERE invoice_id = $1', [inv.id]);
    await api('PUT', `/invoices/${inv.id}/void`, { token: w.tokens.admin, body: { reason: 'test bulk cleanup' } });
  }
  await db.query(`UPDATE customers SET name = $2 WHERE id = $1`, [w.custB.id, '\tTabbed']);
  try {
    const t = await (await fetch(`${BASE}/api/v2/payments/transactions.csv?q=${invB.invoice_number}`, { headers: { Authorization: 'Bearer ' + w.tokens.admin } })).text();
    assert.ok(t.includes(`"'\tTabbed"`));
  } finally {
    await db.query(`UPDATE customers SET name = 'Test Customer B' WHERE id = $1`, [w.custB.id]);
  }
});
