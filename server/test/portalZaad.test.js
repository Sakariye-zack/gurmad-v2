const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { api, db, setupWorld, createInvoice, PASSWORD } = require('./helpers');

// Customer portal ZAAD self-payment (POST /customer-portal/invoices/:id/pay-zaad).
// The WAAFI call is stubbed in the test server by test/stubzaad.js:
// phones 069901xxxx approve, 069902xxxx decline, 069903xxxx approve after 1.5 s.
const OK = '0699010001';
const DECLINE = '0699020001';
const SLOW = '0699030001';

let seq = 0;
const uniq = () => `${Date.now().toString().slice(-4)}${String(++seq).padStart(2, '0')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = Number;

async function mkPortalCustomer(w, { phone } = {}) {
  const n = uniq();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: {
    customer_type: 'residential', name: 'PortalZaad ' + n, phone: phone || ('0657' + n.slice(-6)),
    zone_id: w.zoneA.id, door_number: '9' + n, fee: 5 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = r.data;
  const hash = await bcrypt.hash(PASSWORD, 4);
  await db.query(`INSERT INTO customer_portal_accounts (customer_id, password_hash, status) VALUES ($1,$2,'active')`, [c.id, hash]);
  const login = await api('POST', '/customer-portal/auth/login', { body: { phone: c.phone, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { ...c, token: login.data.token };
}
const payZaad = (c, invId, body = {}) => api('POST', `/customer-portal/invoices/${invId}/pay-zaad`, { token: c.token, body });
const paymentsOf = async (invId) => (await db.query('SELECT * FROM payments WHERE invoice_id = $1 ORDER BY id', [invId])).rows;
const attemptsOf = async (invId) => (await db.query('SELECT * FROM portal_zaad_attempts WHERE invoice_id = $1 ORDER BY id', [invId])).rows;

test('portal ZAAD: full payment records payment, invoice paid, reactivates a debt-suspended customer', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w, { phone: '06990100' + uniq().slice(-2) });
  const inv = await createInvoice(w.tokens.admin, c, 12);
  await db.query(`UPDATE customers SET status = 'suspended', suspended_reason = 'debt', suspended_at = NOW() WHERE id = $1`, [c.id]);

  // no amount / no phone: defaults to full outstanding and the customer's own phone
  const r = await payZaad(c, inv.id);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.data.invoice_status, 'paid');
  assert.equal(num(r.data.amount), 12);
  assert.ok(r.data.transaction_id.startsWith('STUB'));
  const pays = await paymentsOf(inv.id);
  assert.equal(pays.length, 1);
  assert.equal(pays[0].method, 'zaad');
  assert.equal(pays[0].channel, 'portal_zaad');
  assert.equal(pays[0].cashier_id, null);
  assert.equal(pays[0].reference_code, r.data.transaction_id);
  assert.equal((await db.query('SELECT status FROM invoices WHERE id = $1', [inv.id])).rows[0].status, 'paid');
  assert.equal((await db.query('SELECT status FROM customers WHERE id = $1', [c.id])).rows[0].status, 'active');
  const att = await attemptsOf(inv.id);
  assert.equal(att.length, 1);
  assert.equal(att[0].status, 'ok');
  assert.equal(att[0].payment_id, pays[0].id);
  const audit = await db.query(`SELECT actor_id, actor_username FROM v2_audit_log WHERE action = 'payment.create' AND entity_id = $1`, [pays[0].id]);
  assert.equal(audit.rows[0].actor_id, null);
  assert.ok(audit.rows[0].actor_username.startsWith('portal:'));
  // portal lists show it
  const list = await api('GET', '/customer-portal/payments', { token: c.token });
  assert.equal(list.data[0].channel, 'portal_zaad');
  const invs = await api('GET', '/customer-portal/invoices', { token: c.token });
  assert.equal(num(invs.data.find((x) => x.id === inv.id).outstanding), 0);
  // paid invoice cannot be paid again
  assert.equal((await payZaad(c, inv.id, { phone: OK })).body.error.code, 'ALREADY_PAID');
});

test('portal ZAAD: partial amount leaves partial status + auto debt', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
  const inv = await createInvoice(w.tokens.admin, c, 20);
  const r = await payZaad(c, inv.id, { amount: 5, phone: OK });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.data.invoice_status, 'partial');
  assert.equal(num(r.data.outstanding), 15);
  const d = await db.query(`SELECT amount, created_by FROM debts WHERE invoice_id = $1 AND status = 'unpaid'`, [inv.id]);
  assert.equal(num(d.rows[0].amount), 15);
});

test("portal ZAAD: another customer's invoice is 404 and nothing happens", async () => {
  const w = await setupWorld();
  const c1 = await mkPortalCustomer(w);
  const c2 = await mkPortalCustomer(w);
  const inv = await createInvoice(w.tokens.admin, c2, 10);
  const r = await payZaad(c1, inv.id, { phone: OK });
  assert.equal(r.status, 404);
  assert.equal((await payZaad(c1, 99999999, { phone: OK })).status, 404);
  assert.equal((await paymentsOf(inv.id)).length, 0);
  assert.equal((await attemptsOf(inv.id)).length, 0);
  // no token -> 401
  assert.equal((await api('POST', `/customer-portal/invoices/${inv.id}/pay-zaad`, { body: {} })).status, 401);
});

test('portal ZAAD: overpay / bad amount / voided rejected without calling WAAFI', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
  const inv = await createInvoice(w.tokens.admin, c, 10);
  const over = await payZaad(c, inv.id, { amount: 10.5, phone: OK });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'OVERPAYMENT');
  assert.equal((await payZaad(c, inv.id, { amount: -1, phone: OK })).status, 400);
  assert.equal((await payZaad(c, inv.id, { amount: 'abc', phone: OK })).status, 400);
  assert.equal((await payZaad(c, inv.id, { phone: '12' })).status, 400);
  assert.equal((await attemptsOf(inv.id)).length, 0, 'no attempt row => WAAFI never called');
  const v = await createInvoice(w.tokens.admin, c, 10);
  await db.query(`UPDATE invoices SET status = 'voided', voided_at = NOW(), voided_reason = 'test' WHERE id = $1`, [v.id]);
  assert.equal((await payZaad(c, v.id, { phone: OK })).status, 409);
  assert.equal((await paymentsOf(inv.id)).length, 0);
});

test('portal ZAAD: declined records no payment and marks the attempt failed', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
  const inv = await createInvoice(w.tokens.admin, c, 10);
  const r = await payZaad(c, inv.id, { phone: DECLINE });
  assert.equal(r.status, 402);
  assert.equal(r.body.error.code, 'ZAAD_DECLINED');
  assert.equal((await paymentsOf(inv.id)).length, 0);
  const att = await attemptsOf(inv.id);
  assert.equal(att[0].status, 'failed');
  assert.equal(att[0].error_code, 'ZAAD_DECLINED');
});

test('portal ZAAD: gateway not configured -> 503', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
  const inv = await createInvoice(w.tokens.admin, c, 10);
  const r = await payZaad(c, inv.id, { phone: '0634000000' }); // non-stub phone -> real service, no credentials
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'NOT_CONFIGURED');
});

test('portal ZAAD: a second request while one is in flight -> 409 IN_PROGRESS', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
  const inv = await createInvoice(w.tokens.admin, c, 10);
  const first = payZaad(c, inv.id, { amount: 4, phone: SLOW });
  await sleep(300);
  const second = await payZaad(c, inv.id, { amount: 4, phone: OK });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'IN_PROGRESS');
  const r1 = await first;
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal((await paymentsOf(inv.id)).length, 1);
  // DB guard: a fresh pending row blocks too; a stale (>3 min) one is ignored.
  await db.query(`INSERT INTO portal_zaad_attempts (customer_id, invoice_id, amount, currency) VALUES ($1,$2,1,'USD')`, [c.id, inv.id]);
  const blocked = await payZaad(c, inv.id, { amount: 1, phone: OK });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'IN_PROGRESS');
  await db.query(`UPDATE portal_zaad_attempts SET created_at = NOW() - INTERVAL '4 minutes' WHERE invoice_id = $1 AND status = 'pending'`, [inv.id]);
  const ok = await payZaad(c, inv.id, { amount: 1, phone: OK });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.ok((await attemptsOf(inv.id)).some((a) => a.status === 'stale'));
});

test('portal ZAAD: rate limit 5 attempts per customer per 10 minutes -> 429', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
  const inv = await createInvoice(w.tokens.admin, c, 10);
  for (let i = 0; i < 5; i++) assert.equal((await payZaad(c, inv.id, { phone: DECLINE })).status, 402);
  const r = await payZaad(c, inv.id, { phone: OK });
  assert.equal(r.status, 429);
  assert.equal(r.body.error.code, 'TOO_MANY_ATTEMPTS');
  assert.equal((await paymentsOf(inv.id)).length, 0);
  // older attempts fall out of the window
  await db.query(`UPDATE portal_zaad_attempts SET created_at = NOW() - INTERVAL '11 minutes' WHERE customer_id = $1`, [c.id]);
  assert.equal((await payZaad(c, inv.id, { phone: OK })).status, 201);
});

test('portal ZAAD: WAAFI approved but recording fails -> 409 RECONCILIATION_REQUIRED + audit + admin notification', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
  const inv = await createInvoice(w.tokens.admin, c, 10);
  const pending = payZaad(c, inv.id, { phone: SLOW }); // full 10, approved after 1.5 s
  await sleep(400);
  // a cashier closes the invoice while the customer is approving on the phone
  const cash = await api('POST', '/payments', { token: w.tokens.admin, body: { invoice_id: inv.id, amount: 10, currency: 'USD', method: 'cash' } });
  assert.equal(cash.status, 201, JSON.stringify(cash.body));
  const r = await pending;
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'RECONCILIATION_REQUIRED');
  const tx = r.body.error.transaction_id;
  assert.ok(tx);
  const pays = await paymentsOf(inv.id);
  assert.equal(pays.length, 1);
  assert.equal(pays[0].method, 'cash');
  const audit = await db.query(`SELECT * FROM v2_audit_log WHERE action = 'payment.zaad_reconciliation_required' AND entity_id = $1`, [inv.id]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].after_data.zaad_transaction_id, tx);
  assert.ok(audit.rows[0].actor_username.startsWith('portal:'));
  const notes = await db.query(`SELECT n.* FROM v2_staff_notifications n JOIN v2_users u ON u.id = n.recipient_id
    WHERE n.event_type = 'payment.zaad_reconciliation' AND n.entity_id = $1 AND u.username = 't_admin'`, [inv.id]);
  assert.equal(notes.rows.length, 1);
  assert.ok(notes.rows[0].body.includes(tx));
  const att = await attemptsOf(inv.id);
  assert.equal(att[0].status, 'reconciliation_required');
  assert.equal(att[0].transaction_id, tx);
});

test('staff POST /payments/zaad-request still works through the shared flow', async () => {
  const w = await setupWorld();
  const inv = await createInvoice(w.tokens.cashier, w.custA, 8);
  const r = await api('POST', '/payments/zaad-request', { token: w.tokens.cashier, body: { invoice_id: inv.id, phone: OK, amount: 8, currency: 'USD' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.data.invoice_status, 'paid');
  assert.equal(r.data.cashier_id, w.ids.t_cashier);
  assert.equal(r.data.channel, null);
  assert.ok(r.data.reference_code.startsWith('STUB'));
  const declined = await api('POST', '/payments/zaad-request', { token: w.tokens.cashier, body: { invoice_id: (await createInvoice(w.tokens.cashier, w.custA, 3)).id, phone: DECLINE, amount: 3 } });
  assert.equal(declined.status, 402);
  assert.equal(declined.body.error.code, 'ZAAD_DECLINED');
  const nc = await api('POST', '/payments/zaad-request', { token: w.tokens.cashier, body: { invoice_id: (await createInvoice(w.tokens.cashier, w.custA, 3)).id, phone: '0634000000', amount: 3 } });
  assert.equal(nc.status, 402);
  assert.equal(nc.body.error.code, 'NOT_CONFIGURED');
  const over = await api('POST', '/payments/zaad-request', { token: w.tokens.cashier, body: { invoice_id: (await createInvoice(w.tokens.cashier, w.custA, 3)).id, phone: OK, amount: 4 } });
  assert.equal(over.status, 409);
});
