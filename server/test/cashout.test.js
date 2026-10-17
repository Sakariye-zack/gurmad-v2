const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, createInvoice } = require('./helpers');

const num = (x) => Number(x);
const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

async function seedPayments(w, amount = 20) {
  const inv = await createInvoice(w.tokens.cashier, w.custA, amount);
  const p = await api('POST', '/payments', { token: w.tokens.cashier, body: { invoice_id: inv.id, amount, currency: 'USD', method: 'cash' } });
  assert.equal(p.status, 201);
}

async function preview(w, start, end) {
  const q = `cashier_id=${w.ids.t_cashier}&period_start=${encodeURIComponent(start)}&period_end=${encodeURIComponent(end)}`;
  const r = await api('GET', `/cashouts/reconciliation-preview?${q}`, { token: w.tokens.head });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
}

function body(w, start, end, actual, extra = {}) {
  return { zone_id: w.zoneA.id, cashier_id: w.ids.t_cashier, period_start: start, period_end: end, actual_amount: actual, cash_amount: actual, zaad_amount: 0, edahab_amount: 0, slsh_amount: 0, ...extra };
}
const unwrap = (d) => d.cashout || d;
const expectedOf = (rec) => num(rec.expected ?? rec.expectedAmount ?? rec.expected_amount);

let cashoutId;

test('only head_of_cashiers/admin can create a cashout', async () => {
  const w = await setupWorld();
  await seedPayments(w);
  const s = hoursFromNow(-48), e = hoursFromNow(1);
  const rec = await preview(w, s, e);
  for (const r of ['gudoomiye', 'accountant', 'cashier', 'collector']) {
    const res = await api('POST', '/cashouts', { token: w.tokens[r], body: body(w, s, e, expectedOf(rec)) });
    assert.equal(res.status, 403, r);
  }
});

test('cashout reconciliation: shortage is computed server-side; method breakdown must sum to actual; overlaps rejected', async () => {
  const w = await setupWorld();
  const s = hoursFromNow(-72), e = hoursFromNow(2);
  const rec = await preview(w, s, e);
  const expected = expectedOf(rec);
  assert.ok(expected > 0, 'seeded payments produce an expected amount');

  const mismatch = await api('POST', '/cashouts', { token: w.tokens.head, body: { ...body(w, s, e, expected - 2), cash_amount: 1 } });
  assert.equal(mismatch.status, 400, 'breakdown that does not sum to actual is rejected');

  const created = await api('POST', '/cashouts', { token: w.tokens.head, body: body(w, s, e, expected - 2, { shortage_reason: 'counted twice' }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const c = unwrap(created.data);
  assert.equal(c.status, 'pending');
  assert.equal(num(c.shortage), 2);
  assert.equal(num(c.expected_amount), expected);
  cashoutId = c.id;

  const dup = await api('POST', '/cashouts', { token: w.tokens.head, body: body(w, s, e, expected - 2) });
  assert.equal(dup.status, 409, 'overlap rejected');
});

test('approve: admin/gudoomiye only; signed document required; approved is final', async () => {
  const w = await setupWorld();
  assert.ok(cashoutId, 'previous test created a cashout');
  for (const r of ['head', 'cashier', 'accountant', 'collector']) {
    assert.equal((await api('PUT', `/cashouts/${cashoutId}/approve`, { token: w.tokens[r], body: {} })).status, 403, r + ' approve');
  }
  const noDoc = await api('PUT', `/cashouts/${cashoutId}/approve`, { token: w.tokens.gudoomiye, body: {} });
  assert.equal(noDoc.status, 400);
  assert.equal(noDoc.body.error.code, 'SIGNED_DOCUMENT_REQUIRED');

  // attach a signed form (row inserted directly; the upload endpoint is multipart)
  await db.query("INSERT INTO cashout_attachments (cashout_id, document_type, original_filename, storage_path, uploaded_by) VALUES ($1,'signed_cashout_form','t.pdf','x/t.pdf',$2)", [cashoutId, w.ids.t_head]);
  assert.equal((await api('PUT', `/cashouts/${cashoutId}/approve`, { token: w.tokens.gudoomiye, body: {} })).status, 200);
  assert.equal((await api('PUT', `/cashouts/${cashoutId}/approve`, { token: w.tokens.admin, body: {} })).status, 409, 'already approved');
  const reject = await api('PUT', `/cashouts/${cashoutId}/reject`, { token: w.tokens.admin, body: { reason: 'too late' } });
  assert.ok(reject.status >= 400, 'an approved cashout cannot then be rejected, got ' + reject.status);
});

test('self-approval is blocked: an admin who created a cashout cannot approve it', async () => {
  const w = await setupWorld();
  const created = await api('POST', '/cashouts', { token: w.tokens.admin, body: body(w, hoursFromNow(20), hoursFromNow(22), 0) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = unwrap(created.data).id;
  assert.equal((await api('PUT', `/cashouts/${id}/approve`, { token: w.tokens.admin, body: {} })).status, 403);
});

test('void: admin only and needs a reason', async () => {
  const w = await setupWorld();
  const created = await api('POST', '/cashouts', { token: w.tokens.head, body: body(w, hoursFromNow(3), hoursFromNow(6), 0) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = unwrap(created.data).id;
  assert.equal((await api('PUT', `/cashouts/${id}/void`, { token: w.tokens.gudoomiye, body: { reason: 'x' } })).status, 403);
  assert.equal((await api('PUT', `/cashouts/${id}/void`, { token: w.tokens.admin, body: {} })).status, 400);
  assert.equal((await api('PUT', `/cashouts/${id}/void`, { token: w.tokens.admin, body: { reason: 'created in error' } })).status, 200);
});

test('a zone-scoped gudoomiye cannot approve a cashout from another zone', async () => {
  const w = await setupWorld();
  const created = await api('POST', '/cashouts', { token: w.tokens.head, body: { zone_id: w.zoneB.id, cashier_id: w.ids.t_cashier_b, period_start: hoursFromNow(30), period_end: hoursFromNow(32), actual_amount: 0, cash_amount: 0, zaad_amount: 0, edahab_amount: 0, slsh_amount: 0 } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = unwrap(created.data).id;
  assert.equal((await api('PUT', `/cashouts/${id}/approve`, { token: w.tokens.gudoomiye, body: {} })).status, 403);
});
