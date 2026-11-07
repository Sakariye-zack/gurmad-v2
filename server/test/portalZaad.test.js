const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { api, db, setupWorld, createInvoice, PASSWORD } = require('./helpers');

// Customer portal ZAAD self-payment (POST /customer-portal/invoices/:id/pay-zaad).
// The WAAFI call is stubbed in the test server by test/stubzaad.js:
//   0699 01 xxxx approve, 02 decline, 03 approve after 1.5 s, 04 transport
//   error, 05 gateway timeout. Anything else = "not configured".
// Every customer gets its own unique magic numbers (the per-phone limit is
// global): phone (login) approves, alternate_phone declines, whatsapp slow.

let seq = 0;
const uniq = () => `${Date.now().toString().slice(-3)}${String(++seq).padStart(3, '0')}`.slice(-4);
const magic = (kind) => `0699${kind}${uniq()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = Number;

async function mkPortalCustomer(w, { phone, alt, wa } = {}) {
  const n = uniq() + String(seq);
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: {
    customer_type: 'residential', name: 'PortalZaad ' + n + Date.now(), phone: phone || magic('01'),
    zone_id: w.zoneA.id, door_number: '9' + n, fee: 5 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = r.data;
  const alternate = alt === undefined ? magic('02') : alt;
  const whatsapp = wa === undefined ? magic('03') : wa;
  await db.query('UPDATE customers SET alternate_phone = $2, whatsapp = $3 WHERE id = $1', [c.id, alternate, whatsapp]);
  const hash = await bcrypt.hash(PASSWORD, 4);
  await db.query(`INSERT INTO customer_portal_accounts (customer_id, password_hash, status) VALUES ($1,$2,'active')`, [c.id, hash]);
  const login = await api('POST', '/customer-portal/auth/login', { body: { phone: c.phone, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { ...c, ok: c.phone, decline: alternate, slow: whatsapp, token: login.data.token };
}
const payZaad = (c, invId, body = {}) => api('POST', `/customer-portal/invoices/${invId}/pay-zaad`, { token: c.token, body });
const paymentsOf = async (invId) => (await db.query('SELECT * FROM payments WHERE invoice_id = $1 ORDER BY id', [invId])).rows;
const attemptsOf = async (invId) => (await db.query('SELECT * FROM portal_zaad_attempts WHERE invoice_id = $1 ORDER BY id', [invId])).rows;
const reconAudits = async (invId) => (await db.query(`SELECT * FROM v2_audit_log WHERE action = 'payment.zaad_reconciliation_required' AND entity_id = $1 ORDER BY id`, [invId])).rows;
const adminNotes = async (invId) => (await db.query(`SELECT n.* FROM v2_staff_notifications n JOIN v2_users u ON u.id = n.recipient_id
  WHERE n.event_type = 'payment.zaad_reconciliation' AND n.entity_id = $1 AND u.username = 't_admin'`, [invId])).rows;

test('portal ZAAD: full payment records payment, invoice paid, reactivates a debt-suspended customer', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
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
  // per-attempt WAAFI reference
  assert.equal(att[0].reference, `${inv.invoice_number}-A${att[0].id}`);
  const audit = await db.query(`SELECT actor_id, actor_username, after_data FROM v2_audit_log WHERE action = 'payment.create' AND entity_id = $1`, [pays[0].id]);
  assert.equal(audit.rows[0].actor_id, null);
  assert.ok(audit.rows[0].actor_username.startsWith('portal:'));
  assert.equal(audit.rows[0].after_data.target_phone, '252' + c.ok.slice(1));
  assert.equal(audit.rows[0].after_data.reference, att[0].reference);
  const list = await api('GET', '/customer-portal/payments', { token: c.token });
  assert.equal(list.data[0].channel, 'portal_zaad');
  assert.equal((await payZaad(c, inv.id)).body.error.code, 'ALREADY_PAID');
});

test('portal ZAAD: partial amount -> partial + auto debt; default amount floors (USD cents, SLSH whole)', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
  const inv = await createInvoice(w.tokens.admin, c, 20);
  const r = await payZaad(c, inv.id, { amount: 5 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.data.invoice_status, 'partial');
  assert.equal(num(r.data.outstanding), 15);
  const d = await db.query(`SELECT amount FROM debts WHERE invoice_id = $1 AND status = 'unpaid'`, [inv.id]);
  assert.equal(num(d.rows[0].amount), 15);

  // USD outstanding 10.258 -> default 10.25 (floor), never rounded up (binary-exact cents keep report sums exact)
  const odd = await createInvoice(w.tokens.admin, c, 10.258);
  const r2 = await payZaad(c, odd.id);
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(num(r2.data.amount), 10.25);

  // SLSH: fractional amount rejected; default floors to an integer
  const rate = await db.query(`SELECT 1 FROM exchange_rates WHERE effective_from <= NOW() LIMIT 1`);
  if (!rate.rows.length) assert.equal((await api('POST', '/exchange-rates', { token: w.tokens.admin, body: { rate: 10000 } })).status, 201);
  const sl = (await api('POST', '/invoices', { token: w.tokens.admin, body: { customer_id: c.id, invoice_total: 25000.6, currency: 'SLSH' } })).data;
  assert.ok(sl && sl.id);
  const frac = await payZaad(c, sl.id, { amount: 100.5 });
  assert.equal(frac.status, 400);
  const r3 = await payZaad(c, sl.id);
  assert.equal(r3.status, 201, JSON.stringify(r3.body));
  assert.equal(num(r3.data.amount), 25000);
  assert.equal(r3.data.currency, 'SLSH');
});

test('portal ZAAD: invoice list returns outstanding per invoice (batched)', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
  const a = await createInvoice(w.tokens.admin, c, 30);
  const b = await createInvoice(w.tokens.admin, c, 8);
  assert.equal((await api('POST', '/payments', { token: w.tokens.admin, body: { invoice_id: a.id, amount: 12, currency: 'USD', method: 'cash' } })).status, 201);
  const v = await createInvoice(w.tokens.admin, c, 9);
  await db.query(`UPDATE invoices SET status = 'voided', voided_at = NOW(), voided_reason = 'test' WHERE id = $1`, [v.id]);
  const list = (await api('GET', '/customer-portal/invoices', { token: c.token })).data;
  const by = Object.fromEntries(list.map((x) => [x.id, num(x.outstanding)]));
  assert.equal(by[a.id], 18);
  assert.equal(by[b.id], 8);
  assert.equal(by[v.id], 0);
});

test("portal ZAAD: another customer's invoice is 404; archived customer 403", async () => {
  const w = await setupWorld();
  const c1 = await mkPortalCustomer(w);
  const c2 = await mkPortalCustomer(w);
  const inv = await createInvoice(w.tokens.admin, c2, 10);
  assert.equal((await payZaad(c1, inv.id)).status, 404);
  assert.equal((await payZaad(c1, 99999999)).status, 404);
  assert.equal((await paymentsOf(inv.id)).length, 0);
  assert.equal((await attemptsOf(inv.id)).length, 0);
  assert.equal((await api('POST', `/customer-portal/invoices/${inv.id}/pay-zaad`, { body: {} })).status, 401);
  await db.query(`UPDATE customers SET status = 'archived' WHERE id = $1`, [c2.id]);
  const ar = await payZaad(c2, inv.id);
  assert.equal(ar.status, 403);
  assert.equal(ar.body.error.code, 'ACCOUNT_ARCHIVED');
  assert.equal((await attemptsOf(inv.id)).length, 0);
});

test('portal ZAAD: overpay / bad amount / unregistered phone / voided rejected without calling WAAFI', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
  const inv = await createInvoice(w.tokens.admin, c, 10);
  const over = await payZaad(c, inv.id, { amount: 10.5 });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'OVERPAYMENT');
  assert.equal((await payZaad(c, inv.id, { amount: -1 })).status, 400);
  assert.equal((await payZaad(c, inv.id, { amount: 'abc' })).status, 400);
  const foreign = await payZaad(c, inv.id, { phone: magic('01') });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.error.code, 'PHONE_NOT_REGISTERED');
  // the registered number in international form is accepted as the same number
  assert.equal((await attemptsOf(inv.id)).length, 0, 'no attempt row => WAAFI never called');
  const v = await createInvoice(w.tokens.admin, c, 10);
  await db.query(`UPDATE invoices SET status = 'voided', voided_at = NOW(), voided_reason = 'test' WHERE id = $1`, [v.id]);
  assert.equal((await payZaad(c, v.id)).status, 409);
  const intl = await payZaad(c, inv.id, { amount: 1, phone: '+252 ' + c.ok.slice(1) });
  assert.equal(intl.status, 201, JSON.stringify(intl.body));
});

test('portal ZAAD: declined -> fixed message (no gateway text), no payment, attempt failed', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
  const inv = await createInvoice(w.tokens.admin, c, 10);
  const r = await payZaad(c, inv.id, { phone: c.decline });
  assert.equal(r.status, 402);
  assert.equal(r.body.error.code, 'ZAAD_DECLINED');
  assert.ok(!r.body.error.message.includes('stub'), 'raw gateway text must not leak');
  assert.equal((await paymentsOf(inv.id)).length, 0);
  const att = await attemptsOf(inv.id);
  assert.equal(att[0].status, 'failed');
  assert.equal(att[0].error_code, 'ZAAD_DECLINED');
});

test('portal ZAAD: gateway not configured -> 503', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w, { alt: '0634' + uniq() + '00' });
  const inv = await createInvoice(w.tokens.admin, c, 10);
  const r = await payZaad(c, inv.id, { phone: c.decline }); // non-stub number -> "not configured"
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'NOT_CONFIGURED');
});

test('portal ZAAD: gateway timeout / transport error -> unknown, audit + admin alert, invoice blocked 15 min', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w, { alt: magic('05'), wa: magic('04') });
  const inv = await createInvoice(w.tokens.admin, c, 10);
  const r = await payZaad(c, inv.id, { phone: c.decline }); // 05 = timeout
  assert.equal(r.status, 504);
  assert.equal(r.body.error.code, 'PAYMENT_UNKNOWN');
  assert.match(r.body.error.message, /do not pay again/);
  const att = await attemptsOf(inv.id);
  assert.equal(att[0].status, 'unknown');
  const audits = await reconAudits(inv.id);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].after_data.attempt_id, att[0].id);
  assert.equal(audits[0].after_data.reference, att[0].reference);
  assert.equal(audits[0].after_data.target_phone, att[0].phone);
  assert.equal(num(audits[0].after_data.amount), 10);
  assert.equal((await adminNotes(inv.id)).length, 1);
  // blocked for 15 minutes
  const again = await payZaad(c, inv.id);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'PAYMENT_UNCONFIRMED');
  await db.query(`UPDATE portal_zaad_attempts SET finished_at = NOW() - INTERVAL '16 minutes', created_at = NOW() - INTERVAL '16 minutes' WHERE invoice_id = $1`, [inv.id]);
  // transport error is unknown too
  const t = await payZaad(c, inv.id, { phone: c.slow }); // 04 = throws
  assert.equal(t.status, 504);
  assert.equal(t.body.error.code, 'PAYMENT_UNKNOWN');
  assert.equal((await paymentsOf(inv.id)).length, 0);
});

test('portal ZAAD: in-flight second request -> 409; stale pending (>5 min) becomes unknown + alert', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
  const inv = await createInvoice(w.tokens.admin, c, 10);
  const first = payZaad(c, inv.id, { amount: 4, phone: c.slow });
  await sleep(300);
  const second = await payZaad(c, inv.id, { amount: 4 });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'IN_PROGRESS');
  const r1 = await first;
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  assert.equal((await paymentsOf(inv.id)).length, 1);
  // DB guard: a fresh pending row blocks too
  await db.query(`INSERT INTO portal_zaad_attempts (customer_id, invoice_id, amount, currency, phone, reference) VALUES ($1,$2,1,'USD','x','R-1')`, [c.id, inv.id]);
  const blocked = await payZaad(c, inv.id, { amount: 1 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'IN_PROGRESS');
  // 4 minutes old: still pending (window is 5 min)
  await db.query(`UPDATE portal_zaad_attempts SET created_at = NOW() - INTERVAL '4 minutes' WHERE invoice_id = $1 AND status = 'pending'`, [inv.id]);
  assert.equal((await payZaad(c, inv.id, { amount: 1 })).body.error.code, 'IN_PROGRESS');
  // 6 minutes old: swept to unknown + admin alert, and the invoice is then blocked
  await db.query(`UPDATE portal_zaad_attempts SET created_at = NOW() - INTERVAL '6 minutes' WHERE invoice_id = $1 AND status = 'pending'`, [inv.id]);
  const after = await payZaad(c, inv.id, { amount: 1 });
  assert.equal(after.body.error.code, 'PAYMENT_UNCONFIRMED');
  const att = await attemptsOf(inv.id);
  assert.ok(att.some((a) => a.status === 'unknown' && a.error_code === 'STALE'));
  assert.equal((await reconAudits(inv.id)).length, 1);
  assert.equal((await adminNotes(inv.id)).length, 1);
});

test('portal ZAAD: rate limits — 5 per customer, 3 per target phone (across customers) per 10 min', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w, { wa: magic('02') }); // alt + wa both decline
  const inv = await createInvoice(w.tokens.admin, c, 10);
  for (let i = 0; i < 3; i++) assert.equal((await payZaad(c, inv.id, { phone: c.decline })).status, 402);
  const ph = await payZaad(c, inv.id, { phone: c.decline });
  assert.equal(ph.status, 429);
  assert.equal(ph.body.error.code, 'TOO_MANY_ATTEMPTS_PHONE');
  for (let i = 0; i < 2; i++) assert.equal((await payZaad(c, inv.id, { phone: c.slow })).status, 402);
  const cu = await payZaad(c, inv.id);
  assert.equal(cu.status, 429);
  assert.equal(cu.body.error.code, 'TOO_MANY_ATTEMPTS');
  assert.equal((await paymentsOf(inv.id)).length, 0);

  // the per-phone limit applies across customers sharing a number
  const shared = magic('02');
  const x = await mkPortalCustomer(w, { alt: shared });
  const y = await mkPortalCustomer(w, { alt: shared });
  const ix = await createInvoice(w.tokens.admin, x, 5);
  const iy = await createInvoice(w.tokens.admin, y, 5);
  for (let i = 0; i < 3; i++) assert.equal((await payZaad(x, ix.id, { phone: shared })).status, 402);
  assert.equal((await payZaad(y, iy.id, { phone: shared })).body.error.code, 'TOO_MANY_ATTEMPTS_PHONE');

  await db.query(`UPDATE portal_zaad_attempts SET created_at = NOW() - INTERVAL '11 minutes' WHERE customer_id = $1`, [c.id]);
  assert.equal((await payZaad(c, inv.id)).status, 201);
});

test('portal ZAAD: parallel requests on different invoices cannot exceed the customer limit', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
  const invs = [];
  for (let i = 0; i < 4; i++) invs.push(await createInvoice(w.tokens.admin, c, 3));
  // 4 used already (2 declines on each of 2 numbers)
  for (let i = 0; i < 2; i++) assert.equal((await payZaad(c, invs[0].id, { phone: c.decline })).status, 402);
  for (let i = 0; i < 2; i++) assert.equal((await payZaad(c, invs[0].id, { phone: c.slow, amount: 99 })).status, 409); // overpay: no attempt
  await db.query(`INSERT INTO portal_zaad_attempts (customer_id, invoice_id, amount, currency, phone, status) VALUES ($1,$2,1,'USD','y','failed'),($1,$2,1,'USD','z','failed')`, [c.id, invs[0].id]);
  const rs = await Promise.all(invs.slice(1).map((inv) => payZaad(c, inv.id)));
  const codes = rs.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 429, 429]);
});

test('portal ZAAD: WAAFI approved but recording fails -> 409 RECONCILIATION_REQUIRED + audit + admin notification', async () => {
  const w = await setupWorld();
  const c = await mkPortalCustomer(w);
  const inv = await createInvoice(w.tokens.admin, c, 10);
  const pending = payZaad(c, inv.id, { phone: c.slow }); // full 10, approved after 1.5 s
  await sleep(400);
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
  const audit = await reconAudits(inv.id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].after_data.zaad_transaction_id, tx);
  assert.ok(audit[0].actor_username.startsWith('portal:'));
  assert.ok(audit[0].after_data.target_phone);
  const notes = await adminNotes(inv.id);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].body.includes(tx));
  const att = await attemptsOf(inv.id);
  assert.equal(att[0].status, 'reconciliation_required');
  assert.equal(att[0].transaction_id, tx);
});

test('staff POST /payments/zaad-request still works through the shared flow', async () => {
  const w = await setupWorld();
  const OK = magic('01');
  const inv = await createInvoice(w.tokens.cashier, w.custA, 8);
  const r = await api('POST', '/payments/zaad-request', { token: w.tokens.cashier, body: { invoice_id: inv.id, phone: OK, amount: 8, currency: 'USD' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.data.invoice_status, 'paid');
  assert.equal(r.data.cashier_id, w.ids.t_cashier);
  assert.equal(r.data.channel, null);
  assert.ok(r.data.reference_code.startsWith('STUB'));
  const mk = async () => (await createInvoice(w.tokens.cashier, w.custA, 3)).id;
  const declined = await api('POST', '/payments/zaad-request', { token: w.tokens.cashier, body: { invoice_id: await mk(), phone: magic('02'), amount: 3 } });
  assert.equal(declined.status, 402);
  assert.equal(declined.body.error.code, 'ZAAD_DECLINED');
  const timeout = await api('POST', '/payments/zaad-request', { token: w.tokens.cashier, body: { invoice_id: await mk(), phone: magic('05'), amount: 3 } });
  assert.equal(timeout.status, 504);
  assert.equal(timeout.body.error.code, 'ZAAD_UNKNOWN');
  const nc = await api('POST', '/payments/zaad-request', { token: w.tokens.cashier, body: { invoice_id: await mk(), phone: '0634000000', amount: 3 } });
  assert.equal(nc.status, 402);
  assert.equal(nc.body.error.code, 'NOT_CONFIGURED');
  const over = await api('POST', '/payments/zaad-request', { token: w.tokens.cashier, body: { invoice_id: await mk(), phone: OK, amount: 4 } });
  assert.equal(over.status, 409);
});
