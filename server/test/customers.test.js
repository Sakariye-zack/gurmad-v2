const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld } = require('./helpers');

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

test('changing the door later does not change the customer number', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '9401' }) });
  const p = await api('PUT', '/customers/' + a.data.id, { token: w.tokens.admin, body: { door_number: '9402' } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const g = await api('GET', '/customers/' + a.data.id, { token: w.tokens.admin });
  assert.equal(g.data.customer_number, 'C-9401');
  assert.equal(g.data.door_number, '9402');
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
