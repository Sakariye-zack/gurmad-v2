// Cashout V2 — cashier ↔ Sub Zone assignment, the assignment panel
// (information only), merchant-statement attachments, setup health.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, createInvoice, insertUser, tokenFor } = require('./helpers');

const BASE = process.env.TEST_BASE;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let seq = 0;
const uniq = () => `${Date.now().toString().slice(-6)}${++seq}`;
const iso = (ms) => new Date(ms).toISOString();
const close = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;

async function mkCashier(zoneName, active = true) {
  const name = 'ka_' + uniq();
  const id = await insertUser(name, 'cashier', zoneName);
  if (!active) await db.query('UPDATE v2_users SET is_active = FALSE WHERE id = $1', [id]);
  return { id, token: active ? await tokenFor(name) : null };
}
async function mkGroupRoute(w, zone) {
  const g = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: zone.id, code: 'KG' + uniq(), name: 'Cashier group' } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const r = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.data.id, code: 'KR' + uniq(), name: 'Cashier sub ' + uniq() } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { group: g.data, route: r.data };
}
async function mkCustomer(w, zone, routeId = null) {
  const n = uniq();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: { customer_type: 'residential', name: 'KCust ' + n, phone: '0673' + n.slice(-6).padStart(6, '0'), zone_id: zone.id, door_number: '7' + n, fee: 5 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (routeId) await db.query('UPDATE customers SET route_id = $1 WHERE id = $2', [routeId, r.data.id]);
  return r.data;
}
async function pay(token, invoiceId, amount, method = 'cash') {
  const r = await api('POST', '/payments', { token, body: { invoice_id: invoiceId, amount, currency: 'USD', method } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}
async function upload(path, token, fields, buf, filename, type) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([buf], { type }), filename);
  const res = await fetch(BASE + '/api/v2' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  let body = null; try { body = await res.json(); } catch (_) { /* none */ }
  return { status: res.status, body };
}

test('Sub Zone cashier: only an active cashier of the same district; shown on the Sub Zone; setup-health recommends missing ones', async () => {
  const w = await setupWorld();
  const { group, route } = await mkGroupRoute(w, w.zoneA);
  const put = (body, token = w.tokens.admin) => api('PUT', `/routes/${route.id}`, { token, body });
  const collectorId = (await db.query(`SELECT id FROM v2_users WHERE username = 't_collector'`)).rows[0].id;
  assert.equal((await put({ cashier_user_id: collectorId })).status, 400, 'not a cashier');
  const other = await mkCashier(w.zoneB.name);
  assert.equal((await put({ cashier_user_id: other.id })).status, 400, 'other district');
  const inactive = await mkCashier(w.zoneA.name, false);
  assert.equal((await put({ cashier_user_id: inactive.id })).status, 400, 'inactive cashier');
  const before = await api('GET', '/dashboard/setup-health', { token: w.tokens.admin });
  assert.ok(before.data.subzones_without_cashier.some((s) => s.route_id === route.id), 'listed as without cashier');
  assert.ok(before.data.recommended.some((r) => r.key === 'subzones_without_cashier'), 'recommended, not blocking');
  assert.ok(!before.data.blocking.some((r) => r.key === 'subzones_without_cashier'));
  const k = await mkCashier(w.zoneA.name);
  assert.equal((await put({ cashier_user_id: k.id })).status, 200);
  const g = await api('GET', `/groups/${group.id}`, { token: w.tokens.admin });
  const row = g.data.routes.find((r) => r.id === route.id);
  assert.equal(row.cashier_user_id, k.id);
  assert.ok(row.cashier_name, 'cashier name on the Sub Zone row');
  const after = await api('GET', '/dashboard/setup-health', { token: w.tokens.admin });
  assert.ok(!after.data.subzones_without_cashier.some((s) => s.route_id === route.id));
  // a second Sub Zone for the same cashier is fine (one cashier, many Sub Zones)
  const second = await mkGroupRoute(w, w.zoneA);
  assert.equal((await api('PUT', `/routes/${second.route.id}`, { token: w.tokens.admin, body: { cashier_user_id: k.id } })).status, 200);
  assert.equal((await api('PUT', `/routes/${second.route.id}`, { token: w.tokens.admin, body: { cashier_user_id: null } })).status, 200, 'can be cleared');
});

test('assignment panel: opening due, new invoices, collected, other channels, remaining, outside area; RBAC; snapshot persisted', async () => {
  const w = await setupWorld();
  const { route } = await mkGroupRoute(w, w.zoneA);
  const k = await mkCashier(w.zoneA.name);
  assert.equal((await api('PUT', `/routes/${route.id}`, { token: w.tokens.admin, body: { cashier_user_id: k.id } })).status, 200);
  const inside = await mkCustomer(w, w.zoneA, route.id);
  const outside = await mkCustomer(w, w.zoneA, null);

  // Opening: a $30 invoice issued 3 h ago, $10 paid 2.5 h ago -> $20 open at period start.
  const i1 = await createInvoice(k.token, inside, 30);
  await db.query(`UPDATE invoices SET created_at = NOW() - INTERVAL '3 hours' WHERE id = $1`, [i1.id]);
  const early = await pay(k.token, i1.id, 10);
  await db.query(`UPDATE payments SET created_at = NOW() - INTERVAL '150 minutes' WHERE id = $1`, [early.id]);
  const start = iso(Date.now() - 3600e3);
  // In the period: new $15 invoice; cashier collects 5 + 4; another cashier 3; a $1 debt mark; $6 outside his area.
  const i2 = await createInvoice(k.token, inside, 15);
  await pay(k.token, i1.id, 5);
  await pay(k.token, i2.id, 4);
  await pay(w.tokens.cashier, i2.id, 3);
  await pay(k.token, i1.id, 1, 'debt');
  const io = await createInvoice(k.token, outside, 10);
  await pay(k.token, io.id, 6);
  const end = iso(Date.now() + 30 * 1000);

  const q = `cashier_id=${k.id}&period_start=${encodeURIComponent(start)}&period_end=${encodeURIComponent(end)}`;
  for (const role of ['gudoomiye', 'cashier', 'accountant', 'collector']) {
    assert.equal((await api('GET', `/cashouts/assignment-preview?${q}`, { token: w.tokens[role] })).status, 403, role);
  }
  const r = await api('GET', `/cashouts/assignment-preview?${q}`, { token: w.tokens.head });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.data;
  assert.equal(a.no_subzone, false);
  assert.equal(a.subzones.length, 1);
  assert.match(a.subzones[0].path, / › /, 'Group › District › Zone › Sub Zone');
  assert.equal(a.subzones[0].customer_count, 1);
  const t = a.totals.USD;
  assert.ok(close(t.opening_due, 20), JSON.stringify(t));
  assert.ok(close(t.new_invoices, 15));
  assert.ok(close(t.total_sent, 35));
  assert.ok(close(t.collected, 9), 'his money only, debt mark excluded');
  assert.ok(close(t.other_channels, 3));
  assert.ok(close(t.remaining_due, 22), '30-10-5-1 + 15-4-3');
  assert.ok(close(a.outside_area.USD, 6) && a.outside_area.payment_count === 1);

  // information only: the cashout's math is unaffected; the snapshot is stored
  const pv = await api('GET', `/cashouts/reconciliation-preview?${q}`, { token: w.tokens.head });
  const co = await api('POST', '/cashouts', { token: w.tokens.head, body: {
    zone_id: w.zoneA.id, cashier_id: k.id, period_start: start, period_end: end,
    cash_count: { USD: { mode: 'manual', total: pv.data.breakdown.currencies.USD.cash.expected, remark: 'count' } } } });
  assert.equal(co.status, 201, JSON.stringify(co.body));
  assert.equal(Number(co.data.shortage), 0);
  const detail = await api('GET', `/cashouts/${co.data.id}`, { token: w.tokens.head });
  assert.ok(close(detail.data.assignment_snapshot.totals.USD.total_sent, 35), 'snapshot persisted');
  assert.ok(close(detail.data.assignment_snapshot.outside_area.USD, 6));

  // a cashier with no Sub Zone: clear note, cashout still allowed
  const lone = await mkCashier(w.zoneA.name);
  const n = await api('GET', `/cashouts/assignment-preview?cashier_id=${lone.id}&period_start=${encodeURIComponent(start)}&period_end=${encodeURIComponent(end)}`, { token: w.tokens.head });
  assert.equal(n.data.no_subzone, true);
  assert.equal(n.data.totals.USD.total_sent, 0);
  const co2 = await api('POST', '/cashouts', { token: w.tokens.head, body: { zone_id: w.zoneA.id, cashier_id: lone.id, period_start: start, period_end: end, cash_count: {} } });
  assert.equal(co2.status, 201);
});

test('merchant statement attachments: kind = statement; detail shows statement_required / count; Word document renders', async () => {
  const w = await setupWorld();
  const k = await mkCashier(w.zoneA.name);
  const start = iso(Date.now() - 60 * 1000);
  const inv = await createInvoice(k.token, w.custA, 20);
  const r = await api('POST', '/payments', { token: k.token, body: { invoice_id: inv.id, amount: 4, currency: 'USD', method: 'edahab', reference_code: 'EDS' + uniq() } });
  assert.equal(r.status, 201);
  const end = iso(Date.now() + 30 * 1000);
  const co = await api('POST', '/cashouts', { token: w.tokens.head, body: {
    zone_id: w.zoneA.id, cashier_id: k.id, period_start: start, period_end: end, cash_count: {},
    electronic_confirm: { USD: { edahab: { confirmed_ids: [r.data.id] } } } } });
  assert.equal(co.status, 201, JSON.stringify(co.body));
  let d = await api('GET', `/cashouts/${co.data.id}`, { token: w.tokens.head });
  assert.deepEqual([d.data.statement_required, d.data.statement_count], [true, 0], '"No statement attached"');
  const up = await upload(`/cashouts/${co.data.id}/attachments`, w.tokens.head, { document_type: 'merchant_statement' }, PNG, 'statement.png', 'image/png');
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.data.kind, 'statement');
  const signed = await upload(`/cashouts/${co.data.id}/attachments`, w.tokens.head, { document_type: 'signed_cashout_form' }, PNG, 'signed.png', 'image/png');
  assert.equal(signed.body.data.kind, 'signed');
  d = await api('GET', `/cashouts/${co.data.id}`, { token: w.tokens.head });
  assert.equal(d.data.statement_count, 1);
  const res = await fetch(`${BASE}/api/v2/cashouts/${co.data.id}/document.docx`, { headers: { Authorization: 'Bearer ' + w.tokens.head } });
  assert.equal(res.status, 200);
});
