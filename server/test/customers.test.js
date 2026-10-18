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
