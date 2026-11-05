const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, createInvoice } = require('./helpers');

let seq = 0;
// Every new customer needs a door number; default to a unique one per call.
const body = (w, extra = {}) => ({ customer_type: 'residential', name: 'Manual Number ' + (++seq), phone: '06399' + String(seq).padStart(5, '0'), zone_id: w.zoneA.id, door_number: String(70000 + seq), ...extra });

test('customer number is C- plus the door number', async () => {
  const w = await setupWorld();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: ' 9572 ' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.data.customer_number, 'C-9572');
  assert.equal(r.data.door_number, '9572');
});

test('single-digit door is padded to two digits', async () => {
  const w = await setupWorld();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '7' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.data.customer_number, 'C-07');
});

test('door number is required on create', async () => {
  const w = await setupWorld();
  for (const missing of [undefined, '', '   ']) {
    const b = body(w, { door_number: missing });
    if (missing === undefined) delete b.door_number;
    const r = await api('POST', '/customers', { token: w.tokens.admin, body: b });
    assert.equal(r.status, 400, JSON.stringify(missing) + ' -> ' + JSON.stringify(r.body));
  }
});

test('door number must be digits', async () => {
  const w = await setupWorld();
  for (const bad of ['57A', '5-7', 'abc']) {
    const r = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: bad }) });
    assert.equal(r.status, 400, bad + ' -> ' + JSON.stringify(r.body));
  }
});

test('door whose C- number is already taken is rejected with 409, nothing created', async () => {
  const w = await setupWorld();
  assert.equal((await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '9301' }) })).status, 201);
  const b = body(w, { door_number: '09301' });
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: b });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  const n = await db.query('SELECT COUNT(*)::int AS n FROM customers WHERE name = $1', [b.name]);
  assert.equal(n.rows[0].n, 0);
});

test('door change creates pending request, customer unchanged', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '9401' }) });
  const p = await api('PUT', '/customers/' + a.data.id, { token: w.tokens.admin, body: { door_number: '9402' } });
  assert.equal(p.status, 202, JSON.stringify(p.body));
  assert.equal(p.data.status, 'pending');
  assert.equal(p.data.new_door, '9402');
  assert.equal(p.data.new_number, 'C-9402');
  assert.equal(p.data.old_number, 'C-9401');
  const g = await api('GET', '/customers/' + a.data.id, { token: w.tokens.admin });
  assert.equal(g.data.customer_number, 'C-9401');
  assert.equal(g.data.door_number, '9401');
  const l = await api('GET', '/customers/number-requests?status=pending', { token: w.tokens.gudoomiye });
  assert.equal(l.status, 200, JSON.stringify(l.body));
  assert.ok(l.data.some((r) => r.id === p.data.id));
});

test('PUT with same door is a normal update; door plus other fields applies the others and requests the door', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '9411' }) });
  const same = await api('PUT', '/customers/' + a.data.id, { token: w.tokens.admin, body: { door_number: '9411', name: 'Same Door' } });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.data.name, 'Same Door');
  const mixed = await api('PUT', '/customers/' + a.data.id, { token: w.tokens.admin, body: { door_number: '9412', name: 'Mixed' } });
  assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
  assert.equal(mixed.body.data.name, 'Mixed');
  assert.equal(mixed.body.data.door_number, '9411');
  assert.equal(mixed.body.number_request.new_door, '9412');
});

test('edit-number endpoint creates a request instead of changing the number', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '9421' }) });
  const p = await api('PUT', '/customers/' + a.data.id + '/customer-number', { token: w.tokens.gudoomiye, body: { customer_number: 'C-9499' } });
  assert.equal(p.status, 202, JSON.stringify(p.body));
  assert.equal(p.data.new_number, 'C-9499');
  assert.equal(p.data.new_door, '9499');
  const g = await api('GET', '/customers/' + a.data.id, { token: w.tokens.admin });
  assert.equal(g.data.customer_number, 'C-9421');
  const ap = await api('POST', `/customers/number-requests/${p.data.id}/approve`, { token: w.tokens.admin });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const g2 = await api('GET', '/customers/' + a.data.id, { token: w.tokens.admin });
  assert.equal(g2.data.customer_number, 'C-9499');
  assert.equal(g2.data.door_number, '9499');
});

test('leading-zero door that derives the same number is not a change', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '9491' }) });
  const p = await api('PUT', '/customers/' + a.data.id, { token: w.tokens.admin, body: { door_number: '09491' } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.data.door_number, '9491');
  const l = await api('GET', '/customers/number-requests?status=pending&customer_id=' + a.data.id, { token: w.tokens.admin });
  assert.equal(l.data.length, 0);
});

test('second pending request for same customer is 409', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '9431' }) });
  assert.equal((await api('PUT', '/customers/' + a.data.id, { token: w.tokens.admin, body: { door_number: '9432' } })).status, 202);
  const second = await api('PUT', '/customers/' + a.data.id, { token: w.tokens.admin, body: { door_number: '9433' } });
  assert.equal(second.status, 409, JSON.stringify(second.body));
});

test('request for a door already taken is 409', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '9441' }) });
  await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '9442' }) });
  const p = await api('PUT', '/customers/' + a.data.id, { token: w.tokens.admin, body: { door_number: '9442' } });
  assert.equal(p.status, 409, JSON.stringify(p.body));
});

test('gudoomiye cannot approve (403); admin approves and door and C-number update', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '9451' }) });
  const p = await api('PUT', '/customers/' + a.data.id, { token: w.tokens.gudoomiye, body: { door_number: '9452' } });
  assert.equal(p.status, 202, JSON.stringify(p.body));
  assert.equal((await api('POST', `/customers/number-requests/${p.data.id}/approve`, { token: w.tokens.gudoomiye })).status, 403);
  assert.equal((await api('POST', `/customers/number-requests/${p.data.id}/reject`, { token: w.tokens.gudoomiye })).status, 403);
  const ap = await api('POST', `/customers/number-requests/${p.data.id}/approve`, { token: w.tokens.admin });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.data.status, 'approved');
  const g = await api('GET', '/customers/' + a.data.id, { token: w.tokens.admin });
  assert.equal(g.data.door_number, '9452');
  assert.equal(g.data.customer_number, 'C-9452');
  const again = await api('POST', `/customers/number-requests/${p.data.id}/approve`, { token: w.tokens.admin });
  assert.equal(again.status, 409);
});

test('reject leaves customer unchanged', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '9461' }) });
  const p = await api('PUT', '/customers/' + a.data.id, { token: w.tokens.admin, body: { door_number: '9462' } });
  const rj = await api('POST', `/customers/number-requests/${p.data.id}/reject`, { token: w.tokens.admin, body: { reason: 'no' } });
  assert.equal(rj.status, 200, JSON.stringify(rj.body));
  assert.equal(rj.data.status, 'rejected');
  const g = await api('GET', '/customers/' + a.data.id, { token: w.tokens.admin });
  assert.equal(g.data.door_number, '9461');
  assert.equal(g.data.customer_number, 'C-9461');
  const p2 = await api('PUT', '/customers/' + a.data.id, { token: w.tokens.admin, body: { door_number: '9463' } });
  assert.equal(p2.status, 202, 'a new request is allowed after a rejection');
});

test('approve fails 409 if the new number got taken meanwhile', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '9471' }) });
  const p = await api('PUT', '/customers/' + a.data.id, { token: w.tokens.admin, body: { door_number: '9472' } });
  assert.equal(p.status, 202);
  assert.equal((await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '9472' }) })).status, 201);
  const ap = await api('POST', `/customers/number-requests/${p.data.id}/approve`, { token: w.tokens.admin });
  assert.equal(ap.status, 409, JSON.stringify(ap.body));
  const g = await api('GET', '/customers/' + a.data.id, { token: w.tokens.admin });
  assert.equal(g.data.customer_number, 'C-9471');
});

test('invoice created before approval keeps old number; invoice after shows new number', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '9481' }) });
  const inv1 = await createInvoice(w.tokens.admin, a.data, 5);
  const p = await api('PUT', '/customers/' + a.data.id, { token: w.tokens.admin, body: { door_number: '9482' } });
  await api('POST', `/customers/number-requests/${p.data.id}/approve`, { token: w.tokens.admin });
  const inv2 = await createInvoice(w.tokens.admin, a.data, 6);
  const g1 = await api('GET', '/invoices/' + inv1.id, { token: w.tokens.admin });
  const g2 = await api('GET', '/invoices/' + inv2.id, { token: w.tokens.admin });
  assert.equal(g1.data.customer_number, 'C-9481');
  assert.equal(g2.data.customer_number, 'C-9482');
  const list = await api('GET', '/invoices?customer_id=' + a.data.id, { token: w.tokens.admin });
  const byId = Object.fromEntries(list.data.map((i) => [i.id, i.customer_number]));
  assert.equal(byId[inv1.id], 'C-9481');
  assert.equal(byId[inv2.id], 'C-9482');
});

test('door number: saved trimmed', async () => {
  const w = await setupWorld();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: ' 572 ' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.data.door_number, '572');
});

test('door number: duplicate rejected with 409', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '573' }) });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '573' }) });
  assert.equal(b.status, 409);
  assert.equal(b.body.error.code, 'DUPLICATE');
});

test('door number: PUT without the field keeps it', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '574' }) });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const p = await api('PUT', '/customers/' + a.data.id, { token: w.tokens.admin, body: { name: 'x' } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const g = await api('GET', '/customers/' + a.data.id, { token: w.tokens.admin });
  assert.equal(g.data.door_number, '574');
});

test('door number: searchable', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '575' }) });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const r = await api('GET', '/customers?search=575', { token: w.tokens.admin });
  assert.equal(r.status, 200);
  assert.ok(r.data.some((c) => c.id === a.data.id));
});

test('door number: non-scalar type rejected', async () => {
  const w = await setupWorld();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: {} }) });
  assert.equal(r.status, 400, JSON.stringify(r.body));
});
