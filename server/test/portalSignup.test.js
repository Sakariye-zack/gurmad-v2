const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { api, db, setupWorld, PASSWORD } = require('./helpers');

// Customer self-signup requests (/customer-portal/signup + /signup-requests).
// Rate limits are DB-counted, so each test uses its own X-Forwarded-For IP
// (TRUST_PROXY=1 in the suite) and its own phone numbers.

let seq = 0;
const stamp = Date.now().toString().slice(-4);
const uniqPhone = () => `063${stamp}${String(++seq).padStart(3, '0')}`; // 10 digits, Somaliland 063…
const ipFor = () => `10.77.${Math.floor(seq / 200)}.${(++seq % 200) + 1}`;
const door = () => '7' + stamp + String(++seq).padStart(3, '0');
const SIGNUP_PW = 'Signup-pass-77';

function form(w, over = {}) {
  return {
    full_name: 'Signup Applicant', phone: uniqPhone(), alternate_phone: '', customer_type: 'residential',
    zone_id: w.zoneA.id, area: 'Jigjiga Yar', door_number: '', address_line: 'Near the mosque',
    lat: 9.56, lng: 44.06, preferred_billing: 'monthly', password: SIGNUP_PW, password_confirm: SIGNUP_PW, notes: 'Call after 5pm',
    website: '', ...over,
  };
}
const submit = (body, ip = ipFor()) => api('POST', '/customer-portal/signup', { body, headers: { 'X-Forwarded-For': ip } });
const reqByPhone = async (phone) => (await db.query(`SELECT * FROM customer_signup_requests WHERE phone = $1 ORDER BY id DESC`, [phone])).rows[0];
const approve = (token, id, body) => api('POST', `/customer-portal/signup-requests/${id}/approve`, { token, body: { verified_by_call: true, ...body } });
const ALREADY = 'ALREADY_REGISTERED_OR_PENDING';

test('signup: public districts list returns only id + name of active zones', async () => {
  const w = await setupWorld();
  const r = await api('GET', '/customer-portal/signup/districts');
  assert.equal(r.status, 200);
  assert.ok(r.data.some((z) => z.id === w.zoneA.id));
  for (const z of r.data) assert.deepEqual(Object.keys(z).sort(), ['id', 'name']);
});

test('signup: happy path -> staff notified -> approve -> portal login with applicant password', async () => {
  const w = await setupWorld();
  const f = form(w, { phone: '+252 63 ' + uniqPhone().slice(3) });
  const r = await submit(f);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const local = '0' + f.phone.replace(/\D/g, '').slice(3);
  const row = await reqByPhone(local);
  assert.ok(row, 'request stored with normalised phone');
  assert.equal(row.status, 'pending');
  assert.ok(row.password_hash.startsWith('$2'));
  assert.ok(await bcrypt.compare(SIGNUP_PW, row.password_hash));
  assert.ok(row.ip);

  const notes = await db.query(`SELECT u.username FROM v2_staff_notifications n JOIN v2_users u ON u.id = n.recipient_id
    WHERE n.event_type = 'customer_signup.requested' AND n.entity_id = $1`, [row.id]);
  const who = notes.rows.map((x) => x.username);
  assert.ok(who.includes('t_admin'));
  assert.ok(who.includes('t_gudoomiye'), 'gudoomiye of the district notified');

  const list = await api('GET', '/customer-portal/signup-requests', { token: w.tokens.gudoomiye });
  assert.equal(list.status, 200);
  const item = list.data.find((x) => x.id === row.id);
  assert.ok(item);
  assert.equal(item.password_hash, undefined, 'hash never exposed');
  const cnt = await api('GET', '/customer-portal/signup-requests/count', { token: w.tokens.admin });
  assert.ok(cnt.data.pending >= 1);

  const d = door();
  const a = await approve(w.tokens.gudoomiye, row.id, { zone_id: w.zoneA.id, door_number: d, billing_type: 'monthly', fee_currency: 'USD', fee: 7 });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.data.customer.customer_number, 'C-' + d);
  assert.equal(a.data.customer.phone, local);
  assert.equal(Number(a.data.customer.fee), 7);
  const after = await reqByPhone(local);
  assert.equal(after.status, 'approved');
  assert.equal(after.customer_id, a.data.customer.id);
  const apAud = await db.query(`SELECT after_data FROM v2_audit_log WHERE action = 'customer_signup.approve' AND entity_id = $1`, [row.id]);
  assert.equal(apAud.rows[0].after_data.verified_by_call, true);
  assert.equal(apAud.rows[0].after_data.requested_zone_id, w.zoneA.id);
  assert.equal(apAud.rows[0].after_data.final_zone_id, w.zoneA.id);
  const audits = await db.query(`SELECT action FROM v2_audit_log WHERE (action = 'customer_signup.approve' AND entity_id = $1) OR (action = 'customer.create' AND entity_id = $2)`, [row.id, a.data.customer.id]);
  assert.equal(audits.rows.length, 2);

  const login = await api('POST', '/customer-portal/auth/login', { body: { phone: local, password: SIGNUP_PW } });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.data.customer.id, a.data.customer.id);

  // a new signup for the same phone now hits the existing-account rule
  const again = await submit(form(w, { phone: local }));
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, ALREADY);
  // and re-approving is refused
  assert.equal((await approve(w.tokens.admin, row.id, { door_number: door() })).status, 409);
});

test('signup: validation errors', async () => {
  const w = await setupWorld();
  const bad = [
    { full_name: '' }, { phone: '12345' }, { phone: '0612345678x' }, { alternate_phone: '999' },
    { customer_type: 'industrial' }, { customer_type: 'commercial', business_name: '' }, { zone_id: 999999 },
    { zone_id: 'abc' }, { door_number: '12A' }, { password: 'short', password_confirm: 'short' },
    { password_confirm: 'different-pass-1' }, { preferred_billing: 'weekly' }, { lat: 200, lng: 1 },
  ];
  for (const over of bad) {
    const r = await submit(form(w, over));
    assert.equal(r.status, 400, `${JSON.stringify(over)} -> ${r.status}`);
    assert.equal(r.body.error.code, 'VALIDATION');
  }
  const ok = await submit(form(w, { customer_type: 'commercial', business_name: 'Shop One', alternate_phone: uniqPhone() }));
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('signup: honeypot pretends success but stores nothing', async () => {
  const w = await setupWorld();
  const f = form(w, { website: 'http://spam.example' });
  const r = await submit(f);
  assert.equal(r.status, 201);
  assert.equal(await reqByPhone(f.phone), undefined);
});

test('signup: per-IP 5/hour and per-phone 3/day rate limits', async () => {
  const w = await setupWorld();
  const ip = ipFor();
  for (let i = 0; i < 5; i++) assert.equal((await submit(form(w), ip)).status, 201);
  const sixth = await submit(form(w), ip);
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error.code, 'RATE_LIMITED');

  // per phone: reject each request so the pending rule does not interfere
  const phone = uniqPhone();
  for (let i = 0; i < 3; i++) {
    assert.equal((await submit(form(w, { phone }))).status, 201);
    const row = await reqByPhone(phone);
    const rj = await api('POST', `/customer-portal/signup-requests/${row.id}/reject`, { token: w.tokens.admin, body: { reason: 'test' } });
    assert.equal(rj.status, 200);
  }
  const fourth = await submit(form(w, { phone }));
  assert.equal(fourth.status, 429);
});

test('signup: duplicate pending request for the same phone -> 409 (any number format)', async () => {
  const w = await setupWorld();
  const phone = uniqPhone();
  assert.equal((await submit(form(w, { phone }))).status, 201);
  const dup = await submit(form(w, { phone: '252' + phone.slice(1) }));
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, ALREADY);
});

test('signup: existing customer with portal account -> 409, no other customer data revealed', async () => {
  const w = await setupWorld();
  const phone = uniqPhone();
  const c = await api('POST', '/customers', { token: w.tokens.admin, body: { customer_type: 'residential', name: 'Existing Portal Cust', phone, zone_id: w.zoneA.id, door_number: door() } });
  assert.equal(c.status, 201);
  await db.query(`INSERT INTO customer_portal_accounts (customer_id, password_hash, status) VALUES ($1,$2,'active')`, [c.data.id, await bcrypt.hash(PASSWORD, 4)]);
  const r = await submit(form(w, { phone }));
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, ALREADY);
  assert.ok(!JSON.stringify(r.body).includes('Existing Portal Cust'));
  assert.ok(!JSON.stringify(r.body).includes(c.data.customer_number));
  assert.equal(r.body.data, undefined);
});

test('signup: gudoomiye cannot see/approve/reject another district; collector/cashier blocked', async () => {
  const w = await setupWorld();
  const f = form(w, { zone_id: w.zoneB.id });
  assert.equal((await submit(f)).status, 201);
  const row = await reqByPhone(f.phone);
  const list = await api('GET', '/customer-portal/signup-requests', { token: w.tokens.gudoomiye });
  assert.ok(!list.data.some((x) => x.id === row.id));
  assert.equal((await approve(w.tokens.gudoomiye, row.id, { zone_id: w.zoneB.id, door_number: door() })).status, 404);
  assert.equal((await api('POST', `/customer-portal/signup-requests/${row.id}/reject`, { token: w.tokens.gudoomiye, body: { reason: 'x' } })).status, 404);
  // even approving a district-A request INTO district B is refused by the shared create rules
  const fa = form(w);
  await submit(fa);
  const rowA = await reqByPhone(fa.phone);
  assert.equal((await approve(w.tokens.gudoomiye, rowA.id, { zone_id: w.zoneB.id, door_number: door() })).status, 403);
  assert.equal((await reqByPhone(fa.phone)).status, 'pending');

  for (const role of ['collector', 'cashier', 'accountant']) {
    const t = w.tokens[role];
    assert.equal((await api('GET', '/customer-portal/signup-requests', { token: t })).status, 403, role);
    assert.equal((await approve(t, row.id, { door_number: door() })).status, 403, role);
    assert.equal((await api('POST', `/customer-portal/signup-requests/${row.id}/reject`, { token: t, body: { reason: 'x' } })).status, 403, role);
  }
  assert.equal((await api('GET', '/customer-portal/signup-requests')).status, 401);
  assert.equal((await reqByPhone(f.phone)).status, 'pending');
});

test('signup: reject requires a reason, is audited, and frees the phone for a new request', async () => {
  const w = await setupWorld();
  const f = form(w);
  await submit(f);
  const row = await reqByPhone(f.phone);
  const noReason = await api('POST', `/customer-portal/signup-requests/${row.id}/reject`, { token: w.tokens.gudoomiye, body: { reason: '  ' } });
  assert.equal(noReason.status, 400);
  const rj = await api('POST', `/customer-portal/signup-requests/${row.id}/reject`, { token: w.tokens.gudoomiye, body: { reason: 'Outside service area' } });
  assert.equal(rj.status, 200);
  const after = await reqByPhone(f.phone);
  assert.equal(after.status, 'rejected');
  assert.equal(after.reject_reason, 'Outside service area');
  assert.ok(after.reviewed_by && after.reviewed_at);
  const aud = await db.query(`SELECT 1 FROM v2_audit_log WHERE action = 'customer_signup.reject' AND entity_id = $1`, [row.id]);
  assert.equal(aud.rows.length, 1);
  assert.equal((await api('POST', `/customer-portal/signup-requests/${row.id}/reject`, { token: w.tokens.admin, body: { reason: 'again' } })).status, 409);
  assert.equal((await approve(w.tokens.admin, row.id, { door_number: door() })).status, 409);
  // login does not work for a rejected request
  assert.equal((await api('POST', '/customer-portal/auth/login', { body: { phone: f.phone, password: SIGNUP_PW } })).status, 401);
  assert.equal((await submit(form(w, { phone: f.phone }))).status, 201);
});

test('signup: approve with a taken door number / missing door fails cleanly, request stays pending', async () => {
  const w = await setupWorld();
  const taken = door();
  const c = await api('POST', '/customers', { token: w.tokens.admin, body: { customer_type: 'residential', name: 'Door Holder ' + taken, phone: uniqPhone(), zone_id: w.zoneA.id, door_number: taken } });
  assert.equal(c.status, 201);
  const f = form(w);
  await submit(f);
  const row = await reqByPhone(f.phone);
  const r = await approve(w.tokens.admin, row.id, { door_number: taken, fee: 5 });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'DUPLICATE');
  const missing = await approve(w.tokens.admin, row.id, { fee: 5 });
  assert.equal(missing.status, 400);
  const badGroup = await approve(w.tokens.admin, row.id, { door_number: door(), group_id: 999999 });
  assert.equal(badGroup.status, 400);
  const still = await reqByPhone(f.phone);
  assert.equal(still.status, 'pending');
  assert.equal(still.customer_id, null);
  const custs = await db.query(`SELECT 1 FROM customers WHERE phone = $1`, [f.phone]);
  assert.equal(custs.rows.length, 0, 'no half-created customer');
  // and it can still be approved with a free door number
  const ok = await approve(w.tokens.admin, row.id, { door_number: door(), fee: 5 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('signup: any existing customer with the number (any status, alt/whatsapp) blocks submit', async () => {
  const w = await setupWorld();
  const phone = uniqPhone();
  const c = await api('POST', '/customers', { token: w.tokens.admin, body: { customer_type: 'residential', name: 'Alt Holder ' + phone, phone: uniqPhone(), alternate_phone: '+252' + phone.slice(1), zone_id: w.zoneA.id, door_number: door() } });
  assert.equal(c.status, 201);
  await db.query(`UPDATE customers SET status = 'archived' WHERE id = $1`, [c.data.id]);
  const r = await submit(form(w, { phone }));
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, ALREADY);
  const wa = uniqPhone();
  await db.query(`UPDATE customers SET whatsapp = $2 WHERE id = $1`, [c.data.id, wa]);
  assert.equal((await submit(form(w, { phone: wa }))).body.error.code, ALREADY);
});

test('signup: approve refuses when the phone was registered meanwhile (PHONE_IN_USE) and requires verified_by_call', async () => {
  const w = await setupWorld();
  const f = form(w);
  await submit(f);
  const row = await reqByPhone(f.phone);
  const noCall = await api('POST', `/customer-portal/signup-requests/${row.id}/approve`, { token: w.tokens.admin, body: { door_number: door() } });
  assert.equal(noCall.status, 400);
  const notTrue = await api('POST', `/customer-portal/signup-requests/${row.id}/approve`, { token: w.tokens.admin, body: { door_number: door(), verified_by_call: 'yes' } });
  assert.equal(notTrue.status, 400);
  const c = await api('POST', '/customers', { token: w.tokens.admin, body: { customer_type: 'residential', name: 'Walk-in ' + f.phone, phone: f.phone, zone_id: w.zoneA.id, door_number: door() } });
  assert.equal(c.status, 201);
  const r = await approve(w.tokens.admin, row.id, { door_number: door() });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'PHONE_IN_USE');
  assert.equal(r.body.error.customer_number, c.data.customer_number);
  assert.equal((await reqByPhone(f.phone)).status, 'pending');
  assert.equal((await db.query('SELECT COUNT(*)::int n FROM customers WHERE phone = $1', [f.phone])).rows[0].n, 1);
});

test('signup: pending requests older than 30 days expire lazily and free the phone', async () => {
  const w = await setupWorld();
  const f = form(w);
  await submit(f);
  const row = await reqByPhone(f.phone);
  await db.query(`UPDATE customer_signup_requests SET created_at = NOW() - INTERVAL '31 days' WHERE id = $1`, [row.id]);
  const list = await api('GET', '/customer-portal/signup-requests', { token: w.tokens.admin });
  assert.ok(!list.data.some((x) => x.id === row.id));
  assert.equal((await reqByPhone(f.phone)).status, 'expired');
  assert.equal((await approve(w.tokens.admin, row.id, { door_number: door() })).status, 409);
  const again = await submit(form(w, { phone: f.phone }));
  assert.equal(again.status, 201, JSON.stringify(again.body));
});

test('portal login is deterministic when several customers share a phone: active account wins', async () => {
  const w = await setupWorld();
  const phone = uniqPhone();
  const mk = async (n) => (await api('POST', '/customers', { token: w.tokens.admin, body: { customer_type: 'residential', name: `Shared ${n} ${phone}`, phone, zone_id: w.zoneA.id, door_number: door() } })).data;
  const a = await mk(1); const b = await mk(2);
  await db.query(`INSERT INTO customer_portal_accounts (customer_id, password_hash, status) VALUES ($1,$2,'disabled')`, [a.id, await bcrypt.hash('other-pass-1', 4)]);
  await db.query(`INSERT INTO customer_portal_accounts (customer_id, password_hash, status) VALUES ($1,$2,'active')`, [b.id, await bcrypt.hash(PASSWORD, 4)]);
  for (let i = 0; i < 3; i++) {
    const r = await api('POST', '/customer-portal/auth/login', { body: { phone, password: PASSWORD } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.data.customer.id, b.id);
  }
});
