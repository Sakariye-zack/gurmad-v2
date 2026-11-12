const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { api, db, setupWorld, insertUser, tokenFor, createInvoice } = require('./helpers');
const { getInvoiceBalance } = require('../lib/financialCalculations');

// Customers list upgrade: GET /customers pagination/sort/new filters/new
// fields/balances, GET /customers/summary, GET /customers/export.csv and
// POST /customers/bulk/assign-subzone. Every test works on its own marker-
// named customers / own groups so the shared test world stays untouched.

const BASE = process.env.TEST_BASE;
const ALL_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
let seq = 0;
const uniq = () => `${Date.now().toString().slice(-6)}${++seq}`;
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const list = (token, o = {}) => api('GET', `/customers?${qs(o)}`, { token });
const summary = (token, o = {}) => api('GET', `/customers/summary?${qs(o)}`, { token });
const csv = (token, o = {}) => fetch(`${BASE}/api/v2/customers/export.csv?${qs(o)}`, { headers: { Authorization: 'Bearer ' + token } });
const bulk = (token, body) => api('POST', '/customers/bulk/assign-subzone', { token, body });

async function ensureRate(w) {
  const r = await db.query('SELECT rate FROM exchange_rates WHERE effective_from <= NOW() ORDER BY effective_from DESC LIMIT 1');
  if (r.rows[0]) return parseFloat(r.rows[0].rate);
  assert.equal((await api('POST', '/exchange-rates', { token: w.tokens.admin, body: { rate: 10000 } })).status, 201);
  return 10000;
}

async function mkCollector(zone, { type = 'residential', shift = null } = {}) {
  const username = 'cl_col_' + uniq();
  const uid = await insertUser(username, 'collector', zone.name);
  await db.query(
    `INSERT INTO employees (name, employee_type, collector_type, commercial_shift, phone, zone_id, user_id) VALUES ($1,'collector',$2,$3,$4,$5,$6)`,
    ['CL ' + username, type, shift, '0645' + String(uid).padStart(6, '0'), zone.id, uid]);
  return { uid, username };
}

async function mkSubZone(w, { zone = w.zoneA, code, name, collector = { type: 'residential' }, days = ['sat', 'mon', 'wed'], status } = {}) {
  const n = uniq();
  const g = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: zone.id, code: code || 'CLG' + n, name: name === undefined ? 'CL Group ' + n : name } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const gz = await api('POST', '/group-zones', { token: w.tokens.admin, body: { group_id: g.data.id, code: 'ZA' + n, name: 'Zone A' } });
  assert.equal(gz.status, 201, JSON.stringify(gz.body));
  const col = collector ? await mkCollector(zone, collector) : null;
  const body = { group_id: g.data.id, code: 'CLR' + n, name: 'Sub Zone ' + n, work_days: days, group_zone_id: gz.data.id };
  if (col) body.collector_user_id = col.uid;
  const r = await api('POST', '/routes', { token: w.tokens.admin, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (status) await db.query('UPDATE routes SET status = $1 WHERE id = $2', [status, r.data.id]);
  return { group: g.data, gz: gz.data, route: r.data, col };
}

async function mkCust(w, marker, extra = {}) {
  const n = uniq();
  const zone = extra.zone || w.zoneA;
  const { sz, ...rest } = extra;
  delete rest.zone;
  const body = {
    customer_type: 'residential', name: `${marker} ${extra.label || n}`, phone: '0646' + n.slice(-6).padStart(6, '0'), zone_id: zone.id,
    door_number: '6' + n, fee: 3.5, ...rest,
  };
  if (body.customer_type === 'commercial' && !body.business_name) body.business_name = 'Shop ' + n;
  delete body.label;
  const r = await api('POST', '/customers', { token: w.tokens.admin, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (sz) await db.query('UPDATE customers SET group_id = $1, route_id = $2 WHERE id = $3', [sz.group.id, sz.route.id, r.data.id]);
  return r.data;
}

// Leave no open invoices behind: later files (reports.test.js) assert exact
// deltas on company-wide outstanding totals.
after(async () => {
  await db.query(
    `UPDATE invoices SET status = 'voided', voided_at = NOW(), voided_by = 0, voided_reason = 'customersList test cleanup'
     WHERE status <> 'voided' AND customer_id IN (SELECT id FROM customers WHERE name ~ '(^| )CL[A-Z0-9]+[0-9]')`);
});

const ids = (r) => r.data.map((c) => c.id).sort((a, b) => a - b);
const sorted = (arr) => [...arr].sort((a, b) => a - b);

test('list: legacy limit/offset response without page; pagination with page/page_size', async () => {
  const w = await setupWorld();
  const m = 'CLPAGE' + uniq();
  const made = [];
  for (let i = 0; i < 7; i++) made.push(await mkCust(w, m));
  const legacy = await list(w.tokens.admin, { q: m });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.deepEqual(Object.keys(legacy.body.meta).sort(), ['can_see_balance', 'limit', 'offset', 'total']);
  assert.equal(legacy.body.meta.limit, 50);
  assert.equal(legacy.body.meta.total, 7);
  assert.equal(legacy.data.length, 7);
  // legacy rows still carry the historical fields
  for (const k of ['customer_number', 'zone_name', 'path', 'group_zone_id', 'status']) assert.ok(k in legacy.data[0], k);

  const p1 = await list(w.tokens.admin, { q: m, page: 1, page_size: 3 });
  assert.equal(p1.status, 200);
  assert.equal(p1.data.length, 3);
  assert.equal(p1.body.meta.page, 1);
  assert.equal(p1.body.meta.page_size, 3);
  assert.equal(p1.body.meta.pages, 3);
  assert.equal(p1.body.meta.total, 7);
  const p3 = await list(w.tokens.admin, { q: m, page: 3, page_size: 3 });
  assert.equal(p3.data.length, 1);
  const p2 = await list(w.tokens.admin, { q: m, page: 2, page_size: 3 });
  const seen = new Set([...p1.data, ...p2.data, ...p3.data].map((c) => c.id));
  assert.equal(seen.size, 7, 'pages do not overlap');
  const dflt = await list(w.tokens.admin, { q: m, page: 1 });
  assert.equal(dflt.body.meta.page_size, 25);
  const capped = await list(w.tokens.admin, { q: m, page: 1, page_size: 1000 });
  assert.equal(capped.body.meta.page_size, 100);
  for (const bad of ['0', '-1', 'x']) assert.equal((await list(w.tokens.admin, { q: m, page: bad })).status, 400, bad);
});

test('list: new per-row fields (group/zone/sub zone/collector/billing/work days/location/portal/status)', async () => {
  const w = await setupWorld();
  const m = 'CLFIELDS' + uniq();
  const sz = await mkSubZone(w, { code: 'Group ' + uniq(), name: 'Baarsiigo', days: ['sat', 'mon'] });
  const a = await mkCust(w, m, { sz, lat: 9.56, lng: 44.06, fee: 3.5, fee_currency: 'USD' });
  const b = await mkCust(w, m, { sz, customer_type: 'commercial', commercial_shift: 'day', fee: 2000, fee_currency: 'SLSH', work_days: ['fri'] });
  const c = await mkCust(w, m);
  await db.query(`INSERT INTO customer_portal_accounts (customer_id, password_hash, status) VALUES ($1,$2,'active')`, [a.id, await bcrypt.hash('x-pass-123', 4)]);
  await db.query(`UPDATE customers SET status = 'suspended', suspended_reason = 'debt', suspended_at = NOW() WHERE id = $1`, [c.id]);
  const r = await list(w.tokens.admin, { q: m, page: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const by = new Map(r.data.map((x) => [x.id, x]));
  const ra = by.get(a.id);
  assert.equal(ra.group_code, sz.group.code);
  assert.equal(ra.group_name, 'Baarsiigo');
  assert.equal(ra.group_zone_name, 'Zone A');
  assert.equal(ra.route_id, sz.route.id);
  assert.equal(ra.route_name, sz.route.name);
  assert.equal(ra.route_code, sz.route.code);
  assert.equal(ra.collector_id, sz.col.uid);
  assert.equal(ra.collector_name, sz.col.username);
  assert.equal(ra.billing_type, 'monthly');
  assert.equal(ra.fee_currency, 'USD');
  assert.deepEqual(ra.effective_work_days, ['sat', 'mon'], 'Sub Zone days when no override');
  assert.equal(ra.has_location, true);
  assert.equal(ra.portal_status, 'active');
  assert.equal(ra.zone_name, w.zoneA.name);
  const rb = by.get(b.id);
  assert.equal(rb.billing_type, 'daily');
  assert.equal(rb.fee_currency, 'SLSH');
  assert.deepEqual(rb.effective_work_days, ['fri'], 'customer override wins');
  assert.equal(rb.has_location, false);
  assert.equal(rb.portal_status, null);
  const rc = by.get(c.id);
  assert.equal(rc.status, 'suspended');
  assert.equal(rc.suspended_reason, 'debt');
  assert.equal(rc.route_id, null);
  assert.equal(rc.effective_work_days, null);
  assert.equal(rc.balance, undefined, 'no balance unless with_balance=1');
});

test('list: new filters (billing_type, owes, has_location, no_subzone, suspended_for_debt, portal, collector_id, route_id, status) + validation', async () => {
  const w = await setupWorld();
  const m = 'CLFILT' + uniq();
  const sz1 = await mkSubZone(w);
  const sz2 = await mkSubZone(w);
  const located = await mkCust(w, m, { sz: sz1, lat: 9.5, lng: 44.1 });
  const zeroLoc = await mkCust(w, m, { sz: sz1, lat: 0, lng: 0 });
  const daily = await mkCust(w, m, { sz: sz2, customer_type: 'commercial', commercial_shift: 'day' });
  const noSz = await mkCust(w, m);
  const debtS = await mkCust(w, m);
  const manualS = await mkCust(w, m);
  const archived = await mkCust(w, m);
  await db.query(`UPDATE customers SET status = 'suspended', suspended_reason = 'debt' WHERE id = $1`, [debtS.id]);
  await db.query(`UPDATE customers SET status = 'suspended', suspended_reason = 'manual' WHERE id = $1`, [manualS.id]);
  await db.query(`UPDATE customers SET status = 'archived' WHERE id = $1`, [archived.id]);
  const hash = await bcrypt.hash('x-pass-123', 4);
  await db.query(`INSERT INTO customer_portal_accounts (customer_id, password_hash, status) VALUES ($1,$2,'active'), ($3,$2,'disabled')`, [located.id, hash, daily.id]);
  const owing = await createInvoice(w.tokens.admin, noSz, 12);
  assert.ok(owing.id);
  const paid = await createInvoice(w.tokens.admin, located, 5);
  assert.equal((await api('POST', '/payments', { token: w.tokens.admin, body: { invoice_id: paid.id, amount: 5, currency: 'USD', method: 'cash' } })).status, 201);
  const voided = await createInvoice(w.tokens.admin, zeroLoc, 9);
  assert.equal((await api('PUT', `/invoices/${voided.id}/void`, { token: w.tokens.admin, body: { reason: 'test' } })).status, 200);

  const T = w.tokens.admin;
  const live = [located, zeroLoc, daily, noSz, debtS, manualS].map((c) => c.id);
  assert.deepEqual(ids(await list(T, { q: m })), sorted(live), 'default excludes archived');
  assert.deepEqual(ids(await list(T, { q: m, status: 'all' })), sorted([...live, archived.id]));
  assert.deepEqual(ids(await list(T, { q: m, status: 'active' })), sorted(live), "legacy 'active' = not archived");
  assert.deepEqual(ids(await list(T, { q: m, status: 'active_only' })), sorted([located.id, zeroLoc.id, daily.id, noSz.id]));
  assert.deepEqual(ids(await list(T, { q: m, status: 'suspended' })), sorted([debtS.id, manualS.id]));
  assert.deepEqual(ids(await list(T, { q: m, billing_type: 'daily' })), [daily.id]);
  assert.deepEqual(ids(await list(T, { q: m, has_location: 1 })), [located.id], '0,0 is not a location');
  assert.equal((await list(T, { q: m, has_location: 0 })).data.length, live.length - 1);
  assert.deepEqual(ids(await list(T, { q: m, no_subzone: 1 })), sorted([noSz.id, debtS.id, manualS.id]));
  assert.deepEqual(ids(await list(T, { q: m, suspended_for_debt: 1 })), [debtS.id]);
  assert.deepEqual(ids(await list(T, { q: m, portal: 1 })), [located.id], 'disabled account is not portal access');
  assert.equal((await list(T, { q: m, portal: 0 })).data.length, live.length - 1);
  assert.deepEqual(ids(await list(T, { q: m, collector_id: sz2.col.uid })), [daily.id]);
  assert.deepEqual(ids(await list(T, { q: m, route_id: sz1.route.id })), sorted([located.id, zeroLoc.id]));
  assert.deepEqual(ids(await list(T, { q: m, owes: 1 })), [noSz.id], 'paid and voided invoices do not count');
  // phone search in another style than stored
  const stored = noSz.phone; // 0646xxxxxx
  assert.deepEqual(ids(await list(T, { q: '+252 ' + stored.slice(1) })).filter((id) => id === noSz.id), [noSz.id]);

  for (const bad of [{ billing_type: 'weekly' }, { has_location: 'yes' }, { owes: '2' }, { portal: 'x' }, { collector_id: 'abc' }, { sort: 'phone' }, { no_subzone: 'z' }, { suspended_for_debt: '9' }]) {
    const r = await list(T, { q: m, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
});

test('list: sort whitelist (customer_number natural, name, balance, created_at, last_payment)', async () => {
  const w = await setupWorld();
  const m = 'CLSORT' + uniq();
  // Same prefix, different lengths: natural order is P3, P9, P10 (plain text order would put P10 first).
  const P = '5' + String(Math.floor(Math.random() * 900) + 100);
  const c9 = await mkCust(w, m, { door_number: P + '9', label: 'Charlie' });
  const c10 = await mkCust(w, m, { door_number: P + '10', label: 'alpha' });
  const c3 = await mkCust(w, m, { door_number: P + '3', label: 'Bravo' });
  await ensureRate(w);
  const big = await createInvoice(w.tokens.admin, c10, 50);
  const small = await createInvoice(w.tokens.admin, c3, 5);
  assert.ok(big && small);
  assert.equal((await api('POST', '/payments', { token: w.tokens.admin, body: { invoice_id: small.id, amount: 1, currency: 'USD', method: 'cash' } })).status, 201);
  const T = w.tokens.admin;
  const order = async (o) => (await list(T, { q: m, page: 1, ...o })).data.map((c) => c.id);

  assert.deepEqual(await order({ sort: 'customer_number', dir: 'asc' }), [c3.id, c9.id, c10.id]);
  assert.deepEqual(await order({ sort: 'customer_number', dir: 'desc' }), [c10.id, c9.id, c3.id]);
  assert.deepEqual(await order({ sort: 'name', dir: 'asc' }), [c10.id, c3.id, c9.id], 'case-insensitive name');
  assert.deepEqual(await order({ sort: 'balance', dir: 'desc' }), [c10.id, c3.id, c9.id]);
  assert.deepEqual(await order({ sort: 'created_at', dir: 'asc' }), [c9.id, c10.id, c3.id]);
  assert.equal((await order({ sort: 'last_payment', dir: 'desc' }))[0], c3.id, 'only c3 has a payment; nulls last');
  // money sorts are refused for roles that cannot see balances
  assert.equal((await list(w.tokens.collector, { q: m, sort: 'balance' })).status, 403);
});

test('balances: with_balance=1 per currency equals getInvoiceBalance over varied invoices; role and zone gating', async () => {
  const w = await setupWorld();
  const rate = await ensureRate(w);
  const m = 'CLBAL' + uniq();
  const a = await mkCust(w, m);
  const b = await mkCust(w, m);
  const none = await mkCust(w, m);
  const inv = [];
  const mk = async (cust, total, currency = 'USD') => {
    const r = await api('POST', '/invoices', { token: w.tokens.admin, body: { customer_id: cust.id, invoice_total: total, currency } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    inv.push(r.data);
    return r.data;
  };
  const pay = async (i, amount, currency = 'USD', method = 'cash') => {
    const r = await api('POST', '/payments', { token: w.tokens.admin, body: { invoice_id: i.id, amount, currency, method } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  };
  const a1 = await mk(a, 20); // unpaid USD
  const a2 = await mk(a, 30); await pay(a2, 12.5); // partial USD
  const a3 = await mk(a, Math.round(5 * rate), 'SLSH'); await pay(a3, 2, 'USD'); // partial SLSH paid in USD
  const a4 = await mk(a, 10); await pay(a4, 10); // paid
  const a5 = await mk(a, 7); await pay(a5, 3, 'USD', 'debt'); // debt-method payment counts like getInvoiceBalance
  const a6 = await mk(a, 99); // voided
  assert.equal((await api('PUT', `/invoices/${a6.id}/void`, { token: w.tokens.admin, body: { reason: 'test' } })).status, 200);
  const b1 = await mk(b, Math.round(2 * rate), 'SLSH'); await pay(b1, Math.round(rate / 2), 'SLSH', 'slsh'); // amounts exact in USD too
  assert.ok(a1);

  const expect = { [a.id]: { USD: 0, SLSH: 0, n: 0 }, [b.id]: { USD: 0, SLSH: 0, n: 0 }, [none.id]: { USD: 0, SLSH: 0, n: 0 } };
  for (const i of inv) {
    if (i.id === a6.id) continue;
    const bal = await getInvoiceBalance(i.id);
    if (bal.outstanding > 0.005) { expect[i.customer_id][bal.currency] += bal.outstanding; expect[i.customer_id].n += 1; }
  }
  const r = await list(w.tokens.admin, { q: m, page: 1, with_balance: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.meta.can_see_balance, true);
  for (const row of r.data) {
    const e = expect[row.id];
    assert.ok(Math.abs(row.balance.USD - e.USD) < 0.01, `USD ${row.id}: ${row.balance.USD} vs ${e.USD}`);
    assert.ok(Math.abs(row.balance.SLSH - e.SLSH) < 0.01, `SLSH ${row.id}: ${row.balance.SLSH} vs ${e.SLSH}`);
    assert.equal(row.open_invoice_count, e.n);
  }
  const ra = r.data.find((x) => x.id === a.id);
  assert.equal(ra.oldest_open_invoice_id, a1.id, 'oldest open invoice (Take payment link)');
  assert.ok(ra.last_payment_at);
  const rn = r.data.find((x) => x.id === none.id);
  assert.deepEqual(rn.balance, { USD: 0, SLSH: 0 });
  assert.equal(rn.oldest_open_invoice_id, null);

  // summary owing totals agree with the per-row figures
  const s = await summary(w.tokens.admin, { q: m });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.data.owing.count, 2);
  assert.ok(Math.abs(s.data.owing.USD - (expect[a.id].USD + expect[b.id].USD)) < 0.01);
  assert.ok(Math.abs(s.data.owing.SLSH - (expect[a.id].SLSH + expect[b.id].SLSH)) < 0.01);
  // owes filter and per-row balances agree
  assert.deepEqual(ids(await list(w.tokens.admin, { q: m, owes: 1 })), sorted([a.id, b.id]));

  // roles without invoice access never get money data
  assert.equal((await list(w.tokens.collector, { q: m, with_balance: 1 })).status, 403);
  assert.equal((await list(w.tokens.collector, { q: m, owes: 1 })).status, 403);
  const sc = await summary(w.tokens.collector, { q: m });
  assert.equal(sc.status, 200);
  assert.equal(sc.data.owing, null);
  const lc = await list(w.tokens.collector, { q: m });
  assert.equal(lc.status, 200);
  assert.equal(lc.body.meta.can_see_balance, false);
  assert.equal(lc.data[0].last_payment_at, null);
  // a zone-B cashier lists zone-A customers (historical unscoped list) but gets no balances for them
  const cb = await list(w.tokens.cashierB, { q: m, page: 1, with_balance: 1 });
  assert.equal(cb.status, 200);
  assert.ok(cb.data.length === 3 && cb.data.every((x) => x.balance === null && x.last_payment_at === null));
  const sb = await summary(w.tokens.cashierB, { q: m });
  assert.deepEqual(sb.data.owing, { count: 0, USD: 0, SLSH: 0 });
  // the zone-A cashier does
  const ca = await list(w.tokens.cashier, { q: m, page: 1, with_balance: 1 });
  assert.ok(Math.abs(ca.data.find((x) => x.id === a.id).balance.USD - expect[a.id].USD) < 0.01);
});

test('summary: counts match the list for the same filters; zone scoping', async () => {
  const w = await setupWorld();
  const m = 'CLSUM' + uniq();
  const sz = await mkSubZone(w);
  const c1 = await mkCust(w, m, { sz, lat: 9.5, lng: 44 });
  const c2 = await mkCust(w, m, { sz });
  const c3 = await mkCust(w, m);
  const c4 = await mkCust(w, m);
  const cB = await mkCust(w, m, { zone: w.zoneB });
  await db.query(`UPDATE customers SET status = 'suspended', suspended_reason = 'debt' WHERE id = $1`, [c3.id]);
  await db.query(`UPDATE customers SET status = 'suspended', suspended_reason = 'manual' WHERE id = $1`, [c4.id]);
  await db.query(`INSERT INTO customer_portal_accounts (customer_id, password_hash, status) VALUES ($1,$2,'active')`, [c2.id, await bcrypt.hash('x-pass-123', 4)]);
  await createInvoice(w.tokens.admin, c1, 8);
  await createInvoice(w.tokens.admin, cB, 6);

  const s = (await summary(w.tokens.admin, { q: m })).data;
  assert.deepEqual({ ...s, owing: undefined }, {
    total: 5, active: 3, suspended: 2, suspended_for_debt: 1, without_location: 4, without_subzone: 3, with_portal: 1, owing: undefined,
  });
  assert.equal(s.owing.count, 2);
  assert.equal(s.owing.USD, 14);
  // each count equals the list total under the matching quick filter
  const total = async (o) => (await list(w.tokens.admin, { q: m, ...o })).body.meta.total;
  assert.equal(await total({}), s.total);
  assert.equal(await total({ owes: 1 }), s.owing.count);
  assert.equal(await total({ has_location: 0 }), s.without_location);
  assert.equal(await total({ no_subzone: 1 }), s.without_subzone);
  assert.equal(await total({ suspended_for_debt: 1 }), s.suspended_for_debt);
  assert.equal(await total({ portal: 1 }), s.with_portal);
  // filters apply to the summary too
  assert.equal((await summary(w.tokens.admin, { q: m, route_id: sz.route.id })).data.total, 2);
  // gudoomiye (zone A) never sees the zone-B customer
  const g = (await summary(w.tokens.gudoomiye, { q: m })).data;
  assert.equal(g.total, 4);
  assert.deepEqual({ count: g.owing.count, USD: g.owing.USD }, { count: 1, USD: 8 });
  assert.equal((await summary(w.tokens.gudoomiye, { q: m, zone_id: w.zoneB.id })).status, 403);
  assert.equal((await list(w.tokens.gudoomiye, { q: m })).body.meta.total, 4);
});

test('export.csv: columns, filters, zone scope, formula safety, phone/hierarchy formatting', async () => {
  const w = await setupWorld();
  const m = 'CLCSV' + uniq();
  const sz = await mkSubZone(w, { code: 'Group ' + uniq(), name: 'Baarsiigo', days: ['sat', 'mon'] });
  const a = await mkCust(w, m, { sz, phone: '634259981', whatsapp: '+252 63 4259981', fee: 3.5 });
  await db.query(`UPDATE customers SET name = $2 WHERE id = $1`, [a.id, `=HYPERLINK("x") ${m}`]);
  const b = await mkCust(w, m, { zone: w.zoneB });
  await createInvoice(w.tokens.admin, a, 11);

  const r = await csv(w.tokens.admin, { q: m });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  const text = await r.text();
  const lines = text.replace(/^﻿/, '').split('\r\n');
  assert.equal(lines[0], '"Customer #","Name","Business","Type","Phone","Alternate phone","WhatsApp","Group","District","Zone","Sub Zone","Door #","Billing type","Fee","Fee currency","Collector","Work days","Status","Suspended reason","Balance USD","Balance SLSH"');
  assert.equal(lines.length, 3, 'header + 2 rows');
  const rowA = lines.find((l) => l.includes(a.customer_number));
  assert.ok(rowA.includes(`"'=HYPERLINK(""x"") ${m}"`), 'formula neutralised: ' + rowA);
  assert.ok(rowA.includes('"063 4259981","","063 4259981"'), 'phones formatted: ' + rowA);
  assert.ok(rowA.includes(`"${sz.group.code} (Baarsiigo)","${w.zoneA.name}","Zone A","${sz.route.name}"`), 'hierarchy: ' + rowA);
  assert.ok(rowA.includes('"monthly","3.50","USD"'));
  assert.ok(rowA.includes('"Sat Mon"'));
  assert.ok(rowA.includes('"11.00","0"'), 'balances: ' + rowA);

  // gudoomiye export is zone-scoped
  const g = await (await csv(w.tokens.gudoomiye, { q: m })).text();
  assert.ok(g.includes(a.customer_number) && !g.includes(b.customer_number));
  // filters apply
  const f = await (await csv(w.tokens.admin, { q: m, route_id: sz.route.id })).text();
  assert.equal(f.replace(/^﻿/, '').split('\r\n').length, 2);
  // no balance columns for roles without invoice access
  const c = await (await csv(w.tokens.collector, { q: m })).text();
  assert.ok(!c.includes('Balance USD'));
  assert.equal((await csv(w.tokens.collector, { q: m, owes: 1 })).status, 403);
});

test('export.csv: more than 20,000 matching customers -> 413 TOO_MANY_ROWS (never truncated)', async () => {
  const w = await setupWorld();
  const m = 'CLCAP' + uniq();
  await db.query(
    `INSERT INTO customers (customer_number, customer_type, name, phone, zone_id)
     SELECT 'KCAP-' || g, 'residential', $1 || ' ' || g, '0630000000', $2 FROM generate_series(1, 20001) g`,
    [m, w.zoneA.id]);
  try {
    const r = await csv(w.tokens.admin, { q: m });
    assert.equal(r.status, 413);
    assert.equal((await r.json()).error.code, 'TOO_MANY_ROWS');
    await db.query(`DELETE FROM customers WHERE name = $1`, [m + ' 1']);
    const ok = await csv(w.tokens.admin, { q: m });
    assert.equal(ok.status, 200);
    assert.equal((await ok.text()).replace(/^﻿/, '').split('\r\n').length, 20001);
  } finally {
    await db.query(`DELETE FROM customers WHERE name LIKE $1`, [m + ' %']);
  }
});

test('bulk assign-subzone: moves route+group in one go, skips with reasons, audits each change + one summary', async () => {
  const w = await setupWorld();
  const m = 'CLBULK' + uniq();
  const from = await mkSubZone(w);
  const to = await mkSubZone(w);
  const c1 = await mkCust(w, m, { sz: from });
  const c2 = await mkCust(w, m);
  const already = await mkCust(w, m, { sz: to });
  const arch = await mkCust(w, m);
  await db.query(`UPDATE customers SET status = 'archived' WHERE id = $1`, [arch.id]);
  const zoneB = await mkCust(w, m, { zone: w.zoneB });
  const missing = 99999999;
  const before = (await db.query('SELECT id, door_number, customer_number FROM customers WHERE id = ANY($1)', [[c1.id, c2.id]])).rows;
  const auditStart = (await db.query('SELECT COALESCE(MAX(id), 0) AS id FROM v2_audit_log')).rows[0].id;

  const r = await bulk(w.tokens.admin, { customer_ids: [c1.id, c2.id, already.id, arch.id, zoneB.id, missing, c1.id], route_id: to.route.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.data.updated, 2);
  assert.deepEqual(sorted(r.data.updated_ids), sorted([c1.id, c2.id]));
  const reasons = Object.fromEntries(r.data.skipped.map((s) => [s.id, s.reason]));
  assert.deepEqual(reasons, { [already.id]: 'already_assigned', [arch.id]: 'archived', [zoneB.id]: 'district_mismatch', [missing]: 'not_found' });
  const after = (await db.query('SELECT id, route_id, group_id, door_number, customer_number FROM customers WHERE id = ANY($1) ORDER BY id', [[c1.id, c2.id]])).rows;
  for (const row of after) {
    assert.equal(row.route_id, to.route.id);
    assert.equal(row.group_id, to.group.id);
    const b = before.find((x) => x.id === row.id);
    assert.equal(row.door_number, b.door_number, 'door untouched');
    assert.equal(row.customer_number, b.customer_number, 'customer # untouched');
  }
  const audits = (await db.query('SELECT action, entity_id, before_data, after_data FROM v2_audit_log WHERE id > $1 ORDER BY id', [auditStart])).rows;
  const upd = audits.filter((x) => x.action === 'customer.update');
  assert.deepEqual(sorted(upd.map((x) => x.entity_id)), sorted([c1.id, c2.id]));
  const u1 = upd.find((x) => x.entity_id === c1.id);
  assert.deepEqual(u1.before_data, { route_id: from.route.id, group_id: from.group.id });
  assert.equal(u1.after_data.route_id, to.route.id);
  assert.equal(audits.filter((x) => x.action === 'customer.route_change').length, 2);
  const sum = audits.filter((x) => x.action === 'customer.bulk_assign_subzone');
  assert.equal(sum.length, 1);
  assert.equal(sum[0].after_data.route_id, to.route.id);
  assert.equal(sum[0].after_data.skipped.length, 4);
  // the audit taxonomy knows the new action
  assert.equal(require('../lib/auditTaxonomy').classify('customer.bulk_assign_subzone').category, 'Customer');
});

test('bulk assign-subzone: DR-7 — customers whose type/shift the Sub Zone collector cannot serve are skipped', async () => {
  const w = await setupWorld();
  const m = 'CLDR7' + uniq();
  const commDay = await mkSubZone(w, { collector: { type: 'commercial', shift: 'day' } });
  const res = await mkCust(w, m);
  const day = await mkCust(w, m, { customer_type: 'commercial', commercial_shift: 'day' });
  const night = await mkCust(w, m, { customer_type: 'commercial', commercial_shift: 'night' });
  const r = await bulk(w.tokens.admin, { customer_ids: [res.id, day.id, night.id], route_id: commDay.route.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.data.updated_ids, [day.id]);
  const sk = Object.fromEntries(r.data.skipped.map((s) => [s.id, s]));
  assert.equal(sk[res.id].reason, 'collector_type_mismatch');
  assert.equal(sk[night.id].reason, 'collector_type_mismatch');
  assert.match(sk[res.id].message, /DR-7/);
  // a Sub Zone without a collector accepts any type
  const open = await mkSubZone(w, { collector: null });
  const r2 = await bulk(w.tokens.admin, { customer_ids: [res.id, night.id], route_id: open.route.id });
  assert.equal(r2.data.updated, 2);
});

test('bulk assign-subzone: validation, inactive Sub Zone, max 500, RBAC and gudoomiye zone scope', async () => {
  const w = await setupWorld();
  const m = 'CLBRB' + uniq();
  const szA = await mkSubZone(w);
  const szB = await mkSubZone(w, { zone: w.zoneB, collector: null });
  const inactive = await mkSubZone(w, { status: 'inactive' });
  const cA = await mkCust(w, m);
  const cB = await mkCust(w, m, { zone: w.zoneB });

  for (const body of [{}, { customer_ids: [], route_id: szA.route.id }, { customer_ids: [cA.id] }, { customer_ids: ['x'], route_id: szA.route.id }, { customer_ids: [cA.id], route_id: 'abc' }, { customer_ids: [-1], route_id: szA.route.id }]) {
    assert.equal((await bulk(w.tokens.admin, body)).status, 400, JSON.stringify(body));
  }
  const tooMany = await bulk(w.tokens.admin, { customer_ids: Array.from({ length: 501 }, (_, i) => i + 1), route_id: szA.route.id });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.body.error.code, 'TOO_MANY');
  assert.equal((await bulk(w.tokens.admin, { customer_ids: Array.from({ length: 500 }, (_, i) => 90000000 + i), route_id: szA.route.id })).status, 200, 'exactly 500 is allowed');
  assert.equal((await bulk(w.tokens.admin, { customer_ids: [cA.id], route_id: 99999999 })).status, 404);
  const ina = await bulk(w.tokens.admin, { customer_ids: [cA.id], route_id: inactive.route.id });
  assert.equal(ina.status, 400);
  assert.equal(ina.body.error.code, 'INACTIVE');

  for (const k of ['cashier', 'collector', 'accountant', 'head']) {
    assert.equal((await bulk(w.tokens[k], { customer_ids: [cA.id], route_id: szA.route.id })).status, 403, k);
  }
  // gudoomiye: Sub Zone outside their zone -> 403; customer outside their zone -> skipped out_of_scope
  assert.equal((await bulk(w.tokens.gudoomiye, { customer_ids: [cB.id], route_id: szB.route.id })).status, 403);
  const g = await bulk(w.tokens.gudoomiye, { customer_ids: [cA.id, cB.id], route_id: szA.route.id });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.deepEqual(g.data.updated_ids, [cA.id]);
  assert.deepEqual(g.data.skipped, [{ id: cB.id, reason: 'out_of_scope' }]);
  const unchanged = (await db.query('SELECT route_id FROM customers WHERE id = $1', [cB.id])).rows[0];
  assert.equal(unchanged.route_id, null);
  // a gudoomiye with no resolvable zone cannot move anyone
  const lost = 'cl_gud_' + uniq();
  await insertUser(lost, 'gudoomiye', null);
  assert.equal((await bulk(await tokenFor(lost), { customer_ids: [cA.id], route_id: szA.route.id })).status, 403);
});
