const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, createInvoice } = require('./helpers');

let seq = 0;
async function hierarchy(w) {
  const token = w.tokens.admin;
  const n = ++seq;
  const g = await api('POST', '/groups', { token, body: { zone_id: w.zoneA.id, code: 'MPG' + n } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const gz = await api('POST', '/group-zones', { token, body: { group_id: g.data.id, code: 'MPZ' + n, name: 'MapZone ' + n } });
  assert.equal(gz.status, 201, JSON.stringify(gz.body));
  const cid = (await db.query(`SELECT id FROM v2_users WHERE username='t_collector'`)).rows[0].id;
  const r = await api('POST', '/routes', { token, body: { group_id: g.data.id, code: 'MPR' + n, group_zone_id: gz.data.id, collector_user_id: cid } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { group: g.data, gz: gz.data, route: r.data };
}

async function mkCust(w, h, extra = {}, loc) {
  seq += 1;
  if (loc === undefined) loc = [9.5 + seq / 1000, 45.5];
  const zone = extra.zone || w.zoneA;
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: {
    customer_type: 'residential', name: 'MapCust ' + seq + ' ' + Date.now(), phone: '06388' + String(seq).padStart(5, '0'),
    zone_id: zone.id, door_number: String(Date.now()).slice(-9) + String(seq).padStart(3, '0'), billing_type: 'monthly', fee: 30000, fee_currency: 'SLSH' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = r.data;
  await db.query('UPDATE customers SET group_id=$1, route_id=$2, lat=$3, lng=$4 WHERE id=$5',
    [h ? h.group.id : null, h ? h.route.id : null, loc ? loc[0] : null, loc ? loc[1] : null, c.id]);
  return c;
}

let invSeq = 0;
async function slshInvoice(c, total, paid = 0, voided = false) {
  const n = 'MP' + Date.now().toString().slice(-6) + (++invSeq);
  const i = await db.query(
    `INSERT INTO invoices (invoice_number, customer_id, invoice_total, currency, status, created_by) VALUES ($1,$2,$3,'SLSH',$4,1) RETURNING id`,
    [n.slice(0, 20), c.id, total, voided ? 'voided' : 'unpaid']);
  if (paid > 0) {
    // USD-method row carrying a frozen SLSH value (no exchange-rate row needed)
    await db.query(
      `INSERT INTO payments (invoice_id, amount, currency, method, amount_usd, cashier_id, amount_invoice_currency, created_at) VALUES ($1,$2,'USD','cash',$3,1,$4, NOW() - INTERVAL '40 days')`,
      [i.rows[0].id, paid / 10000, paid / 10000, paid]);
  }
  return i.rows[0].id;
}

const get = (w, qs, token) => api('GET', '/map/customers' + (qs ? '?' + qs : ''), { token: token || w.tokens.admin });
const find = (r, c) => r.data.find((p) => p.id === c.id);

test('map: filters by group, group_zone and route; invalid group_zone_id is 400', async () => {
  const w = await setupWorld();
  const h1 = await hierarchy(w); const h2 = await hierarchy(w);
  const a = await mkCust(w, h1); const b = await mkCust(w, h2);
  let r = await get(w, 'group_zone_id=' + h1.gz.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(find(r, a)); assert.ok(!find(r, b));
  r = await get(w, `group_id=${h1.group.id}&group_zone_id=${h1.gz.id}&route_id=${h1.route.id}`);
  assert.ok(find(r, a) && !find(r, b));
  r = await get(w, `group_id=${h2.group.id}&group_zone_id=${h1.gz.id}`);
  assert.equal(r.data.length, 0);
  r = await get(w, 'group_zone_id=abc');
  assert.equal(r.status, 400);
  const p = (await get(w, 'route_id=' + h1.route.id)).data[0];
  assert.equal(p.group_zone_name, h1.gz.name);
  assert.equal(p.door_number, a.door_number);
  assert.equal(p.billing_type, 'monthly');
  assert.equal(p.fee_currency, 'SLSH');
  assert.equal(p.collector_name, 't_collector');
  assert.equal(p.zone_name, w.zoneA.name);
});

test('map: payment_status clear / partial / unpaid / none (SLSH invoices, voided ignored)', async () => {
  const w = await setupWorld();
  const h = await hierarchy(w);
  const clear = await mkCust(w, h); await slshInvoice(clear, 30000, 30000);
  const partial = await mkCust(w, h); await slshInvoice(partial, 30000, 10000);
  const unpaid = await mkCust(w, h); await slshInvoice(unpaid, 30000, 0);
  const none = await mkCust(w, h);
  const oldPaidNewOpen = await mkCust(w, h); await slshInvoice(oldPaidNewOpen, 30000, 30000); await slshInvoice(oldPaidNewOpen, 30000, 0);
  const onlyVoid = await mkCust(w, h); await slshInvoice(onlyVoid, 30000, 0, true);
  const r = await get(w, 'route_id=' + h.route.id);
  assert.equal(find(r, clear).payment_status, 'clear');
  assert.equal(find(r, partial).payment_status, 'partial');
  assert.equal(Number(find(r, partial).outstanding_slsh), 20000);
  assert.equal(find(r, unpaid).payment_status, 'unpaid');
  assert.equal(find(r, oldPaidNewOpen).payment_status, 'partial');
  assert.equal(find(r, none).payment_status, 'none');
  assert.equal(find(r, onlyVoid).payment_status, 'none');
});

test('map: USD invoice paid in full is clear', async () => {
  const w = await setupWorld();
  const h = await hierarchy(w);
  const c = await mkCust(w, h);
  const inv = await createInvoice(w.tokens.cashier, c, 12);
  // dated in the past so it cannot perturb the 'today' revenue figures other suites assert on
  await db.query(`INSERT INTO payments (invoice_id, amount, currency, method, amount_usd, cashier_id, created_at) VALUES ($1,12,'USD','cash',12,1, NOW() - INTERVAL '40 days')`, [inv.id]);
  const r = await get(w, 'route_id=' + h.route.id);
  assert.equal(find(r, c).payment_status, 'clear');
});

test('map: today status uses company-local date (22:30 UTC visit counts on the next local day)', async () => {
  const w = await setupWorld();
  const h = await hierarchy(w);
  const cs = (await db.query(`SELECT timezone FROM company_settings WHERE timezone IS NOT NULL AND timezone <> '' ORDER BY id LIMIT 1`)).rows[0];
  const tz = cs ? cs.timezone : 'Africa/Mogadishu';
  assert.equal(tz, 'Africa/Mogadishu', 'test assumes the default UTC+3 company timezone');
  const todayStr = (await db.query(`SELECT to_char((NOW() AT TIME ZONE '${tz}')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
  const ctoday = await mkCust(w, h); const cold = await mkCust(w, h); const cpend = await mkCust(w, h); const cnone = await mkCust(w, h);
  const cyc = (await db.query(
    `INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date) VALUES ($1,'custom',$2::date - 5,$2::date + 5) RETURNING id`,
    [w.zoneA.id, todayStr])).rows[0].id;
  const mkBatch = async (status, endOffset = null) => (await db.query(
    `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, start_date, end_date, status) VALUES ($1,$2,$3,$4,$5::date - 1,CASE WHEN $7::int IS NULL THEN NULL ELSE $5::date + $7::int END,$6) RETURNING id`,
    ['MPB' + Date.now() + (++seq), w.zoneA.id, cyc, seq, todayStr, status, endOffset])).rows[0].id;
  const b1 = await mkBatch('in_progress'); const b2 = await mkBatch('assigned');
  const b3 = await mkBatch('in_progress', -1); // stale: ended yesterday
  const cstale = await mkCust(w, h);
  await db.query(`INSERT INTO batch_customers (batch_id, customer_id, status) VALUES ($1,$2,'pending')`, [b3, cstale.id]);
  // yesterday 22:30 UTC == today 01:30 local (UTC+3): counts as today
  await db.query(`INSERT INTO batch_customers (batch_id, customer_id, status, status_at) VALUES ($1,$2,'serviced',($3::date - 1)::timestamp + interval '22:30')`, [b1, ctoday.id, todayStr]);
  // yesterday 20:00 UTC == yesterday 23:00 local: not today
  await db.query(`INSERT INTO batch_customers (batch_id, customer_id, status, status_at) VALUES ($1,$2,'serviced',($3::date - 1)::timestamp + interval '20:00')`, [b1, cold.id, todayStr]);
  await db.query(`INSERT INTO batch_customers (batch_id, customer_id, status) VALUES ($1,$2,'pending')`, [b2, cpend.id]);
  const r = await get(w, 'today=1&route_id=' + h.route.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(find(r, cstale).today_status, 'not_scheduled');
  assert.equal((await get(w, 'route_id=' + h.route.id)).data[0].today_status, null);
  assert.equal(find(r, ctoday).today_status, 'serviced');
  assert.equal(find(r, cold).today_status, 'not_scheduled');
  assert.equal(find(r, cpend).today_status, 'pending');
  assert.equal(find(r, cnone).today_status, 'not_scheduled');
});

test('map: missing-location list is filtered and carries the path', async () => {
  const w = await setupWorld();
  const h = await hierarchy(w);
  const noLoc = await mkCust(w, h, {}, null);
  const placeholder = await mkCust(w, h, {}, [0, 0]);
  const located = await mkCust(w, h);
  const r = await api('GET', '/map/customers/missing-location?route_id=' + h.route.id, { token: w.tokens.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ids = r.data.map((x) => x.id);
  assert.ok(ids.includes(noLoc.id) && ids.includes(placeholder.id) && !ids.includes(located.id));
  const row = r.data.find((x) => x.id === noLoc.id);
  assert.ok(row.customer_number && row.name && row.group_name && row.group_zone_name && row.route_name);
  assert.equal((await api('GET', '/map/customers/missing-location?group_zone_id=x', { token: w.tokens.admin })).status, 400);
  const rb = await api('GET', '/map/customers/missing-location?zone_id=' + w.zoneB.id, { token: w.tokens.admin });
  assert.ok(!rb.data.map((x) => x.id).includes(noLoc.id));
});

test('map: scoped role cannot see another district', async () => {
  const w = await setupWorld();
  const h = await hierarchy(w);
  const mine = await mkCust(w, h, {}, null);
  const mineLoc = await mkCust(w, h);
  const other = await mkCust(w, null, { zone: w.zoneB }, [9.9, 45.9]);
  const otherNoLoc = await mkCust(w, null, { zone: w.zoneB }, null);
  const r = await get(w, 'zone_id=' + w.zoneB.id, w.tokens.gudoomiye);
  assert.equal(r.status, 200);
  assert.ok(!find(r, other)); assert.ok(find(r, mineLoc));
  const m = await api('GET', '/map/customers/missing-location?zone_id=' + w.zoneB.id, { token: w.tokens.gudoomiye });
  const ids = m.data.map((x) => x.id);
  assert.ok(ids.includes(mine.id) && !ids.includes(otherNoLoc.id));
  const adm = await get(w, 'zone_id=' + w.zoneB.id);
  assert.ok(find(adm, other));
});
