const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, createInvoice } = require('./helpers');

// Migrated to the Cashout V2 request format (cash_count + electronic_confirm;
// the legacy actual_amount body is removed). Every period now lies in the
// past (a cashout cannot end in the future); each test keeps its intent.
const num = (x) => Number(x);
const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
const nowish = () => new Date(Date.now() + 30 * 1000).toISOString();

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

// A count that matches the preview exactly, except `usdShort` dollars of USD cash.
function countFrom(rec, usdShort = 0) {
  const b = rec.breakdown.currencies;
  const cash_count = {
    USD: { mode: 'manual', total: Number((b.USD.cash.expected - usdShort).toFixed(2)), remark: 'test count' },
    SLSH: { mode: 'manual', total: b.SLSH.cash.expected, remark: 'test count' },
  };
  // tick every manually recorded electronic payment as found on the statement
  const electronic_confirm = {};
  for (const e of rec.electronic || []) {
    if (e.gateway_verified) continue;
    const cur = e.currency === 'SLSH' ? 'SLSH' : 'USD';
    electronic_confirm[cur] = electronic_confirm[cur] || {};
    (electronic_confirm[cur][e.method] = electronic_confirm[cur][e.method] || { confirmed_ids: [] }).confirmed_ids.push(e.id);
  }
  return { cash_count, electronic_confirm };
}

function body(w, start, end, counts, extra = {}) {
  return { zone_id: w.zoneA.id, cashier_id: w.ids.t_cashier, period_start: start, period_end: end, ...counts, ...extra };
}
const EMPTY = { cash_count: {} };

let cashoutId;

test('only head_of_cashiers/admin can create a cashout', async () => {
  const w = await setupWorld();
  await seedPayments(w);
  const s = hoursFromNow(-48), e = nowish();
  const rec = await preview(w, s, e);
  for (const r of ['gudoomiye', 'accountant', 'cashier', 'collector']) {
    const res = await api('POST', '/cashouts', { token: w.tokens[r], body: body(w, s, e, countFrom(rec)) });
    assert.equal(res.status, 403, r);
  }
});

test('cashout reconciliation: shortage is computed server-side; the legacy body is refused; overlaps rejected', async () => {
  const w = await setupWorld();
  const s = hoursFromNow(-72), e = nowish();
  const rec = await preview(w, s, e);
  const expected = num(rec.expectedAmount);
  assert.ok(expected > 0, 'seeded payments produce an expected amount');

  const legacy = await api('POST', '/cashouts', { token: w.tokens.head, body: { zone_id: w.zoneA.id, cashier_id: w.ids.t_cashier, period_start: s, period_end: e, actual_amount: expected, cash_amount: expected, zaad_amount: 0, edahab_amount: 0, slsh_amount: 0 } });
  assert.equal(legacy.status, 400, 'the old actual_amount body is rejected');
  assert.equal(legacy.body.error.code, 'LEGACY_FORMAT_REMOVED');

  const created = await api('POST', '/cashouts', { token: w.tokens.head, body: body(w, s, e, countFrom(rec, 2), { shortage_reason: 'counted twice' }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const c = created.data;
  assert.equal(c.status, 'pending');
  assert.ok(Math.abs(num(c.shortage) - 2) < 1e-6);
  assert.equal(num(c.expected_amount), expected);
  cashoutId = c.id;

  const dup = await api('POST', '/cashouts', { token: w.tokens.head, body: body(w, s, e, countFrom(rec)) });
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
  const created = await api('POST', '/cashouts', { token: w.tokens.admin, body: body(w, hoursFromNow(-300), hoursFromNow(-298), EMPTY) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await api('PUT', `/cashouts/${created.data.id}/approve`, { token: w.tokens.admin, body: {} })).status, 403);
});

test('void: admin only and needs a reason', async () => {
  const w = await setupWorld();
  const created = await api('POST', '/cashouts', { token: w.tokens.head, body: body(w, hoursFromNow(-400), hoursFromNow(-397), EMPTY) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.data.id;
  assert.equal((await api('PUT', `/cashouts/${id}/void`, { token: w.tokens.gudoomiye, body: { reason: 'x' } })).status, 403);
  assert.equal((await api('PUT', `/cashouts/${id}/void`, { token: w.tokens.admin, body: {} })).status, 400);
  assert.equal((await api('PUT', `/cashouts/${id}/void`, { token: w.tokens.admin, body: { reason: 'created in error' } })).status, 200);
});

test('a zone-scoped gudoomiye cannot approve a cashout from another zone', async () => {
  const w = await setupWorld();
  const created = await api('POST', '/cashouts', { token: w.tokens.head, body: { zone_id: w.zoneB.id, cashier_id: w.ids.t_cashier_b, period_start: hoursFromNow(-500), period_end: hoursFromNow(-498), cash_count: {} } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await api('PUT', `/cashouts/${created.data.id}/approve`, { token: w.tokens.gudoomiye, body: {} })).status, 403);
});
