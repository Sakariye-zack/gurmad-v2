const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, setupWorld } = require('./helpers');

let seq = 0;
const body = (w, extra = {}) => ({ customer_type: 'residential', name: 'Billing Fields ' + (++seq), phone: '06388' + String(seq).padStart(5, '0'), zone_id: w.zoneA.id, door_number: String(81000 + seq), ...extra });

test('billing fields: SLSH fixed monthly fee with work days is saved', async () => {
  const w = await setupWorld();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { billing_type: 'monthly', fee: 30000, fee_currency: 'SLSH', work_days: ['sat', 'tue', 'thu'] }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.data.billing_type, 'monthly');
  assert.equal(r.data.fee_currency, 'SLSH');
  assert.equal(Number(r.data.fee), 30000);
  assert.deepEqual(r.data.work_days, ['sat', 'tue', 'thu']);
});

test('billing fields: residential defaults to monthly USD; commercial defaults to daily', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w) });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.data.billing_type, 'monthly');
  assert.equal(a.data.fee_currency, 'USD');
  const b = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, { customer_type: 'commercial', business_name: 'Shop', commercial_shift: 'day' }) });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal(b.data.billing_type, 'daily');
});

test('billing fields: invalid values rejected with 400', async () => {
  const w = await setupWorld();
  for (const bad of [{ billing_type: 'weekly' }, { fee_currency: 'EUR' }, { work_days: ['mon', 'funday'] }, { work_days: 'sat' }]) {
    const r = await api('POST', '/customers', { token: w.tokens.admin, body: body(w, bad) });
    assert.equal(r.status, 400, JSON.stringify(bad) + ' -> ' + JSON.stringify(r.body));
  }
});

test('billing fields: PUT updates currency and work days, duplicates removed in week order', async () => {
  const w = await setupWorld();
  const a = await api('POST', '/customers', { token: w.tokens.admin, body: body(w) });
  const p = await api('PUT', '/customers/' + a.data.id, { token: w.tokens.admin, body: { fee_currency: 'SLSH', fee: 25000, work_days: ['thu', 'sat', 'thu'] } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.data.fee_currency, 'SLSH');
  assert.deepEqual(p.data.work_days, ['sat', 'thu']);
});
