const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld } = require('./helpers');

let seq = 0;
const body = (w, extra = {}) => ({ customer_type: 'residential', name: 'Manual Number ' + (++seq), phone: '06399' + String(seq).padStart(5, '0'), zone_id: w.zoneA.id, ...extra });

test('customer number: left blank -> generated automatically (C-NN)', async () => {
  const w = await setupWorld();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: body(w) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.data.customer_number, /^C-\d{2,}$/);
});

test('customer number: entered manually is used as-is (normalised to upper case)', async () => {
  const w = await setupWorld();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { customer_number: ' c-9105 ' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.data.customer_number, 'C-9105');
});

test('customer number: wrong format is rejected with 400', async () => {
  const w = await setupWorld();
  for (const bad of ['105', 'X-12', 'C-1', 'C-12A']) {
    const r = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { customer_number: bad }) });
    assert.equal(r.status, 400, bad + ' -> ' + JSON.stringify(r.body));
  }
});

test('customer number: one already in use is rejected with 409 and nothing is created', async () => {
  const w = await setupWorld();
  const first = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { customer_number: 'C-9200' }) });
  assert.equal(first.status, 201);
  const dupBody = body(w, { customer_number: 'C-9200' });
  const dup = await api('POST', '/customers', { token: w.tokens.admin, body: dupBody });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DUPLICATE');
  const n = await db.query('SELECT COUNT(*)::int AS n FROM customers WHERE name = $1', [dupBody.name]);
  assert.equal(n.rows[0].n, 0);
});

test('automatic numbering skips a number that was already taken manually', async () => {
  const w = await setupWorld();
  const last = Number((await db.query('SELECT last_value FROM customer_number_seq')).rows[0].last_value);
  const next = `C-${String(last + 1).padStart(2, '0')}`;
  assert.equal((await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { customer_number: next }) })).status, 201);
  const auto = await api('POST', '/customers', { token: w.tokens.admin, body: body(w) });
  assert.equal(auto.status, 201, JSON.stringify(auto.body));
  assert.notEqual(auto.data.customer_number, next);
});

test('door number: saved trimmed', async () => {
  const w = await setupWorld();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: ' 572 ' }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.data.door_number, '572');
});

test('door number: blank stored as null', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '  ' }) });
  const b = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { door_number: '' }) });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(a.data.door_number, null);
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
