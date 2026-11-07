const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, insertUser, tokenFor } = require('./helpers');
// Past/future days are simulated by calling the generator directly (the
// admin endpoint only ever runs today).
const { runForDate } = require('../lib/dailyLists');
const { runDaily } = require('../lib/autoBilling');

// Daily lists: generator (Sub Zone work days, customer override, carry-over,
// idempotency, DR-7 split), Sub Zone truck/work-day validation, edit
// endpoints scoping/roles, warnings, and the tracking gate on auto batches.
const ALL_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const JS_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const wd = (date) => JS_DAYS[new Date(date + 'T00:00:00Z').getUTCDay()];
const shift = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
let seq = 0;
const uniq = () => `${Date.now().toString().slice(-6)}${++seq}`;

async function today(w) {
  const r = await api('GET', '/daily-lists', { token: w.tokens.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data.today;
}

async function mkCollector(zone, { type = 'residential', shiftName = null } = {}) {
  const username = 'dl_col_' + uniq();
  const uid = await insertUser(username, 'collector', zone.name);
  const emp = (await db.query(
    `INSERT INTO employees (name, employee_type, collector_type, commercial_shift, phone, zone_id, user_id) VALUES ($1,'collector',$2,$3,$4,$5,$6) RETURNING id`,
    ['DL ' + username, type, shiftName, '0641' + String(uid).padStart(6, '0'), zone.id, uid])).rows[0].id;
  return { uid, emp, username };
}

async function mkSubZone(w, { zone = w.zoneA, collector = true, days = ALL_DAYS, truckId, colType } = {}) {
  const n = uniq();
  const g = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: zone.id, code: 'DLG' + n, name: 'DL Group ' + n } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const col = collector ? await mkCollector(zone, colType || {}) : null;
  const body = { group_id: g.data.id, code: 'DLR' + n, name: 'DL Sub ' + n, work_days: days };
  if (col) body.collector_user_id = col.uid;
  if (truckId) body.truck_id = truckId;
  const r = await api('POST', '/routes', { token: w.tokens.admin, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { group: g.data, route: r.data, col };
}

async function mkCust(w, sz, extra = {}) {
  const n = uniq();
  const zone = extra.zone || w.zoneA;
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: {
    customer_type: extra.type || 'residential', name: 'DLCust ' + n, phone: '0642' + n.slice(-6).padStart(6, '0'), zone_id: zone.id,
    door_number: '7' + n, fee: 5, ...(extra.type === 'commercial' ? { commercial_shift: extra.shift || 'day', business_name: 'DL Shop ' + n } : {}),
    ...(extra.work_days ? { work_days: extra.work_days } : {}) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (sz) await db.query('UPDATE customers SET group_id = $1, route_id = $2 WHERE id = $3', [sz.group.id, sz.route.id, r.data.id]);
  return r.data;
}

let todayCache = null;
async function run(w, date) {
  if (!todayCache) todayCache = await today(w);
  if (date !== todayCache) return runForDate({ date });
  const r = await api('POST', '/daily-lists/run', { token: w.tokens.admin, body: { date } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
}

async function autoBatches(routeId, date) {
  return (await db.query(`SELECT * FROM batches WHERE auto_generated AND route_id = $1 AND start_date = $2::date ORDER BY customer_type, id`, [routeId, date])).rows;
}
async function rows(batchId) {
  return (await db.query(`SELECT customer_id, status, status_reason, to_char(carried_over_from, 'YYYY-MM-DD') AS carried FROM batch_customers WHERE batch_id = $1 ORDER BY customer_id`, [batchId])).rows;
}
async function mark(w, batchId, customerId, status) {
  const r = await api('PUT', `/batches/${batchId}/customers/${customerId}/status`, { token: w.tokens.admin, body: { status, reason: status === 'missed' ? 'gate closed' : undefined } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

test('sub zone: work days required with a collector; default truck validated', async () => {
  const w = await setupWorld();
  const g = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: w.zoneA.id, code: 'DLV' + uniq() } });
  const col = await mkCollector(w.zoneA);
  const noDays = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.data.id, code: 'V1', collector_user_id: col.uid } });
  assert.equal(noDays.status, 400, JSON.stringify(noDays.body));
  const bad = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.data.id, code: 'V1', collector_user_id: col.uid, work_days: ['mon', 'xyz'] } });
  assert.equal(bad.status, 400);
  const truckB = (await db.query(`INSERT INTO trucks (plate_number, zone_id) VALUES ($1,$2) RETURNING id`, ['DLB-' + uniq(), w.zoneB.id])).rows[0].id;
  const retired = (await db.query(`INSERT INTO trucks (plate_number, zone_id, status) VALUES ($1,$2,'retired') RETURNING id`, ['DLR-' + uniq(), w.zoneA.id])).rows[0].id;
  const shared = (await db.query(`INSERT INTO trucks (plate_number) VALUES ($1) RETURNING id`, ['DLS-' + uniq()])).rows[0].id;
  for (const t of [truckB, retired]) {
    const r = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.data.id, code: 'V1', collector_user_id: col.uid, work_days: ['mon'], truck_id: t } });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  }
  const ok = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.data.id, code: 'V1', collector_user_id: col.uid, work_days: ['thu', 'sat', 'thu'], truck_id: shared } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual(ok.data.work_days, ['sat', 'thu']);
  assert.equal(ok.data.truck_id, shared);
  const clear = await api('PUT', '/routes/' + ok.data.id, { token: w.tokens.admin, body: { work_days: [] } });
  assert.equal(clear.status, 400, JSON.stringify(clear.body));
  const get = await api('GET', '/routes/' + ok.data.id, { token: w.tokens.admin });
  assert.ok(get.data.truck_plate);
  // Customer work days stay optional on create.
  const c = await api('POST', '/customers', { token: w.tokens.admin, body: { customer_type: 'residential', name: 'DLNoDays ' + uniq(), phone: '0643000001', zone_id: w.zoneA.id, door_number: '8' + uniq() } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
});

test('generator: Sub Zone days drive inclusion, customer override wins, no Sub Zone -> not listed', async () => {
  const w = await setupWorld();
  const t = await today(w);
  const d1 = shift(t, -5);
  const sz = await mkSubZone(w, { days: [wd(t)] });
  const regular = await mkCust(w, sz);
  const override = await mkCust(w, sz, { work_days: [wd(d1)] });
  const loose = await mkCust(w, null);

  const r1 = await run(w, d1);
  assert.ok(r1.run_id);
  assert.equal((await api('POST', '/daily-lists/run', { token: w.tokens.admin, body: { date: d1 } })).status, 400);
  const b1 = await autoBatches(sz.route.id, d1);
  assert.equal(b1.length, 1);
  assert.deepEqual((await rows(b1[0].id)).map((x) => x.customer_id), [override.id]);

  await run(w, t);
  const bt = await autoBatches(sz.route.id, t);
  assert.equal(bt.length, 1);
  const rt = await rows(bt[0].id);
  // override customer's d1 entry was never visited -> carried; regular scheduled today.
  assert.deepEqual(rt.map((x) => x.customer_id).sort((a, b) => a - b), [regular.id, override.id].sort((a, b) => a - b));
  assert.equal(rt.find((x) => x.customer_id === override.id).carried, d1);
  assert.equal(rt.find((x) => x.customer_id === regular.id).carried, null);
  const any = await db.query('SELECT 1 FROM batch_customers WHERE customer_id = $1', [loose.id]);
  assert.equal(any.rows.length, 0);
  assert.equal(bt[0].status, 'assigned');
  assert.equal((await db.query(`SELECT to_char(end_date, 'YYYY-MM-DD') AS d FROM batches WHERE id = $1`, [bt[0].id])).rows[0].d, t);
});

test('generator: missed and untouched pending carried over; serviced carry not carried again', async () => {
  const w = await setupWorld();
  const t = await today(w);
  const d0 = shift(t, -3);
  const d1 = shift(t, -2);
  const sz = await mkSubZone(w, { days: [wd(d0)] });
  const done = await mkCust(w, sz);
  const missed = await mkCust(w, sz);
  const untouched = await mkCust(w, sz);

  await run(w, d0);
  const [b0] = await autoBatches(sz.route.id, d0);
  assert.equal((await rows(b0.id)).length, 3);
  await mark(w, b0.id, done.id, 'serviced');
  await mark(w, b0.id, missed.id, 'missed');

  await run(w, d1);
  const closed = (await db.query('SELECT status FROM batches WHERE id = $1', [b0.id])).rows[0];
  assert.equal(closed.status, 'partially_completed');
  const after0 = await rows(b0.id);
  const u0 = after0.find((x) => x.customer_id === untouched.id);
  assert.equal(u0.status, 'missed');
  assert.equal(u0.status_reason, 'not visited');
  const tz = (await db.query(`SELECT COALESCE((SELECT timezone FROM company_settings WHERE timezone IS NOT NULL AND timezone <> '' ORDER BY id LIMIT 1), 'Africa/Mogadishu') AS tz`)).rows[0].tz;
  const localDay = (await db.query(`SELECT to_char((status_at AT TIME ZONE 'UTC' AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS d FROM batch_customers WHERE batch_id = $1 AND customer_id = $2`, [b0.id, untouched.id, tz])).rows[0].d;
  assert.equal(localDay, d0);
  const tasks = (await db.query('SELECT status FROM tasks WHERE batch_id = $1', [b0.id])).rows;
  assert.ok(tasks.every((x) => x.status === 'completed'));

  const [b1] = await autoBatches(sz.route.id, d1);
  const r1 = await rows(b1.id);
  assert.deepEqual(r1.map((x) => x.customer_id).sort((a, b) => a - b), [missed.id, untouched.id].sort((a, b) => a - b));
  assert.ok(r1.every((x) => x.carried === d0));
  await mark(w, b1.id, missed.id, 'serviced');

  await run(w, t);
  const bt = await autoBatches(sz.route.id, t);
  assert.equal(bt.length, 1);
  const rt = await rows(bt[0].id);
  assert.deepEqual(rt.map((x) => x.customer_id), [untouched.id]);
  assert.equal(rt[0].carried, d0);
  // Day list API reports the carried count.
  const list = await api('GET', '/daily-lists?date=' + t, { token: w.tokens.admin });
  const card = list.data.lists.find((l) => l.route_id === sz.route.id);
  assert.equal(card.counts.carried, 1);
  assert.equal(card.counts.total, 1);
  assert.match(card.path, / › /);
});

test('generator: idempotent — two runs give one batch, cancelled list not recreated', async () => {
  const w = await setupWorld();
  const t = await today(w);
  const sz = await mkSubZone(w);
  await mkCust(w, sz);
  await run(w, t);
  const again = await run(w, t);
  assert.ok(!again.skipped.some((s) => s.route_id === sz.route.id && s.reason === 'already_on_batch'));
  const bs = await autoBatches(sz.route.id, t);
  assert.equal(bs.length, 1);
  const cycles = (await db.query(`SELECT COUNT(*)::int AS n FROM collection_cycles WHERE auto AND zone_id = $1 AND start_date = date_trunc('month', $2::date)::date`, [w.zoneA.id, t])).rows[0].n;
  assert.equal(cycles, 1);
  const cancel = await api('PUT', `/batches/${bs[0].id}/cancel`, { token: w.tokens.admin, body: { reason: 'holiday' } });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  await run(w, t);
  assert.equal((await autoBatches(sz.route.id, t)).length, 1);
});

test('generator: Sub Zone without a collector is skipped', async () => {
  const w = await setupWorld();
  const t = await today(w);
  const sz = await mkSubZone(w, { collector: false });
  await mkCust(w, sz);
  const r = await run(w, t);
  assert.equal((await autoBatches(sz.route.id, t)).length, 0);
  assert.ok(r.skipped.some((s) => s.route_id === sz.route.id && s.reason === 'no_collector'));
  const list = await api('GET', '/daily-lists?date=' + t, { token: w.tokens.admin });
  assert.equal(list.data.lists.find((l) => l.route_id === sz.route.id).not_generated, 'no_collector');
});

test('generator: separate lists per customer type; DR-7 mismatch creates nothing and is reported', async () => {
  const w = await setupWorld();
  const t = await today(w);
  const truck = (await db.query(`INSERT INTO trucks (plate_number, zone_id) VALUES ($1,$2) RETURNING id`, ['DLT-' + uniq(), w.zoneA.id])).rows[0].id;
  const sz = await mkSubZone(w, { truckId: truck });
  const res = await mkCust(w, sz);
  await mkCust(w, sz, { type: 'commercial', shift: 'night' });
  const szN = await mkSubZone(w, { colType: { type: 'commercial', shiftName: 'night' } });
  await mkCust(w, szN);
  const comN = await mkCust(w, szN, { type: 'commercial', shift: 'night' });
  const r = await run(w, t);

  const bs = await autoBatches(sz.route.id, t);
  assert.equal(bs.length, 1);
  assert.equal(bs[0].customer_type, 'residential');
  assert.equal(bs[0].status, 'assigned');
  assert.deepEqual((await rows(bs[0].id)).map((x) => x.customer_id), [res.id]);
  const resRes = (await db.query(`SELECT tr.resource_type, tr.resource_id FROM tasks t JOIN task_resources tr ON tr.task_id = t.id WHERE t.batch_id = $1 ORDER BY tr.resource_type`, [bs[0].id])).rows;
  assert.deepEqual(resRes, [{ resource_type: 'collector', resource_id: sz.col.emp }, { resource_type: 'truck', resource_id: truck }]);
  assert.ok(r.skipped.some((s) => s.route_id === sz.route.id && s.reason === 'collector_type_mismatch' && s.customer_type === 'commercial'));

  const bn = await autoBatches(szN.route.id, t);
  assert.equal(bn.length, 1);
  assert.equal(bn[0].customer_type, 'commercial');
  assert.equal(bn[0].commercial_shift, 'night');
  assert.deepEqual((await rows(bn[0].id)).map((x) => x.customer_id), [comN.id]);

  const list = await api('GET', '/daily-lists?date=' + t, { token: w.tokens.admin });
  assert.ok(list.data.mismatches.some((m) => m.route_id === sz.route.id && m.customer_type === 'commercial'));
  assert.ok(list.data.mismatches.some((m) => m.route_id === szN.route.id && m.customer_type === 'residential'));
});

test('sub zone: PUT checks the merged collector + work days state', async () => {
  const w = await setupWorld();
  const sz = await mkSubZone(w, { collector: false, days: null });
  const col = await mkCollector(w.zoneA);
  const bad = await api('PUT', '/routes/' + sz.route.id, { token: w.tokens.admin, body: { collector_user_id: col.uid } });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  const ok = await api('PUT', '/routes/' + sz.route.id, { token: w.tokens.admin, body: { collector_user_id: col.uid, work_days: ['mon'] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const keep = await api('PUT', '/routes/' + sz.route.id, { token: w.tokens.admin, body: { name: 'renamed' } });
  assert.equal(keep.status, 200, JSON.stringify(keep.body));
});

test('customer: moving district while keeping a group of the old district is refused', async () => {
  const w = await setupWorld();
  const sz = await mkSubZone(w, { collector: false });
  const c = await mkCust(w, sz);
  const r = await api('PUT', '/customers/' + c.id, { token: w.tokens.admin, body: { zone_id: w.zoneB.id } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
});

test('edit endpoints: add / remove / reassign with scoping and roles', async () => {
  const w = await setupWorld();
  const t = await today(w);
  const sz = await mkSubZone(w);
  const c1 = await mkCust(w, sz);
  const c2 = await mkCust(w, sz);
  const extra = await mkCust(w, null);
  const other = await mkCust(w, null, { zone: w.zoneB });
  const szB = await mkSubZone(w, { zone: w.zoneB });
  await mkCust(w, szB, { zone: w.zoneB });
  await run(w, t);
  const [b] = await autoBatches(sz.route.id, t);
  const [bB] = await autoBatches(szB.route.id, t);
  assert.ok(b && bB);

  const g = w.tokens.gudoomiye;
  assert.equal((await api('POST', `/daily-lists/${b.id}/customers`, { token: g, body: { customer_id: other.id } })).status, 400);
  assert.equal((await api('POST', `/daily-lists/${b.id}/customers`, { token: g, body: { customer_id: c1.id } })).status, 409);
  const add = await api('POST', `/daily-lists/${b.id}/customers`, { token: g, body: { customer_id: extra.id } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal((await api('POST', `/daily-lists/${bB.id}/customers`, { token: g, body: { customer_id: extra.id } })).status, 403);
  for (const tok of [w.tokens.accountant, w.tokens.collector, w.tokens.cashier]) {
    assert.equal((await api('POST', `/daily-lists/${b.id}/customers`, { token: tok, body: { customer_id: extra.id } })).status, 403);
  }
  await mark(w, b.id, c2.id, 'serviced');
  assert.equal((await api('DELETE', `/daily-lists/${b.id}/customers/${c2.id}`, { token: g })).status, 409);
  const del = await api('DELETE', `/daily-lists/${b.id}/customers/${c1.id}`, { token: g });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal((await db.query('SELECT total_customers FROM batches WHERE id = $1', [b.id])).rows[0].total_customers, 2);

  const col2 = await mkCollector(w.zoneA);
  const colB = await mkCollector(w.zoneB);
  assert.equal((await api('PUT', `/daily-lists/${b.id}/assignment`, { token: g, body: { collector_user_id: colB.uid } })).status, 400);
  assert.equal((await api('PUT', `/daily-lists/${bB.id}/assignment`, { token: g, body: { collector_user_id: col2.uid } })).status, 403);
  const truck = (await db.query(`INSERT INTO trucks (plate_number, zone_id) VALUES ($1,$2) RETURNING id`, ['DLE-' + uniq(), w.zoneA.id])).rows[0].id;
  const re = await api('PUT', `/daily-lists/${b.id}/assignment`, { token: g, body: { collector_user_id: col2.uid, truck_id: truck } });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  const res = (await db.query(`SELECT tr.resource_type, tr.resource_id FROM tasks t JOIN task_resources tr ON tr.task_id = t.id WHERE t.batch_id = $1 ORDER BY tr.resource_type`, [b.id])).rows;
  assert.deepEqual(res, [{ resource_type: 'collector', resource_id: col2.emp }, { resource_type: 'truck', resource_id: truck }]);
  const hist = (await db.query(`SELECT action FROM task_resource_history h JOIN tasks t ON t.id = h.task_id WHERE t.batch_id = $1 AND h.resource_type = 'collector' ORDER BY h.id`, [b.id])).rows.map((x) => x.action);
  assert.deepEqual(hist, ['assigned', 'removed', 'assigned']);

  // Past lists are read-only; GET is scoped to the gudoomiye's district.
  const past = (await db.query(`SELECT id FROM batches WHERE auto_generated AND end_date < $1::date LIMIT 1`, [t])).rows[0];
  if (past) assert.equal((await api('DELETE', `/daily-lists/${past.id}/customers/1`, { token: w.tokens.admin })).status, 409);
  const gl = await api('GET', '/daily-lists?date=' + t, { token: g });
  assert.equal(gl.status, 200);
  assert.ok(gl.data.lists.some((l) => l.route_id === sz.route.id));
  assert.ok(!gl.data.lists.some((l) => l.route_id === szB.route.id));
  assert.equal((await api('GET', '/daily-lists', { token: w.tokens.collector })).status, 403);
  assert.equal((await api('POST', '/daily-lists/run', { token: g, body: {} })).status, 403);
  assert.equal((await api('POST', '/daily-lists/run', { token: w.tokens.admin, body: { date: shift(t, 1) } })).status, 400);
});

test('warnings: Sub Zones without work days and customers without a Sub Zone (scoped)', async () => {
  const w = await setupWorld();
  const szNoDays = await mkSubZone(w, { collector: false, days: null });
  const szB = await mkSubZone(w, { zone: w.zoneB, collector: false, days: null });
  const loose = await mkCust(w, null);
  const looseB = await mkCust(w, null, { zone: w.zoneB });
  const a = await api('GET', '/daily-lists/warnings', { token: w.tokens.admin });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.ok(a.data.subzones_without_days.some((s) => s.id === szNoDays.route.id));
  assert.ok(a.data.subzones_without_days.some((s) => s.id === szB.route.id));
  assert.ok(a.data.customers_without_subzone.some((c) => c.id === loose.id));
  const g = await api('GET', '/daily-lists/warnings', { token: w.tokens.gudoomiye });
  assert.ok(g.data.subzones_without_days.some((s) => s.id === szNoDays.route.id));
  assert.ok(!g.data.subzones_without_days.some((s) => s.id === szB.route.id));
  assert.ok(!g.data.customers_without_subzone.some((c) => c.id === looseB.id));
});

test('collector app + tracking gate accept auto batches without a Start', async () => {
  const w = await setupWorld();
  const t = await today(w);
  const sz = await mkSubZone(w);
  const c = await mkCust(w, sz);
  await run(w, t);
  const [b] = await autoBatches(sz.route.id, t);
  const token = await tokenFor(sz.col.username);
  const my = await api('GET', '/collection-sync/my-assignments', { token });
  assert.equal(my.status, 200, JSON.stringify(my.body));
  const mine = my.data.batches.find((x) => x.id === b.id);
  assert.ok(mine);
  const ping = await api('POST', '/collection-sync/location', { token, body: { lat: 9.56, lng: 44.06 } });
  assert.equal(ping.status, 200);
  assert.equal(ping.data.recorded, true);
  const taskId = mine.customers[0].task_id;
  const m = await api('PUT', `/batches/${b.id}/customers/${c.id}/status`, { token, body: { status: 'serviced', task_id: taskId } });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  // Serviced on today's list -> cannot go on a manual batch for today.
  const manual = await api('POST', '/batches', { token: w.tokens.admin, body: { zone_id: w.zoneA.id, cycle_id: b.cycle_id, start_date: t, customer_ids: [c.id] } });
  assert.equal(manual.status, 400, JSON.stringify(manual.body));
  assert.equal(manual.body.error.code, 'already_serviced_today');
});

test('options: collectors and trucks scoped to the district', async () => {
  const w = await setupWorld();
  const a = await mkCollector(w.zoneA);
  const b = await mkCollector(w.zoneB);
  const g = await api('GET', '/daily-lists/options?zone_id=' + w.zoneB.id, { token: w.tokens.gudoomiye });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.ok(g.data.collectors.some((c) => c.user_id === a.uid));
  assert.ok(!g.data.collectors.some((c) => c.user_id === b.uid));
  const adm = await api('GET', '/daily-lists/options?zone_id=' + w.zoneB.id, { token: w.tokens.admin });
  assert.ok(adm.data.collectors.some((c) => c.user_id === b.uid));
});

async function companyTz() {
  return (await db.query(`SELECT COALESCE((SELECT timezone FROM company_settings WHERE timezone IS NOT NULL AND timezone <> '' ORDER BY id LIMIT 1), 'Africa/Mogadishu') AS tz`)).rows[0].tz;
}
async function localAt(date, time, tz) {
  return new Date((await db.query(`SELECT (($1::date + $2::time) AT TIME ZONE $3) AS at`, [date, time, tz])).rows[0].at);
}
// Yesterday's list closed by today's run, with one never-visited customer.
async function closedYesterday(w, extra = {}) {
  const t = await today(w);
  const y = shift(t, -1);
  const sz = await mkSubZone(w, { days: [wd(y)] });
  const c = await mkCust(w, sz);
  if (extra.daily) await db.query(`UPDATE customers SET billing_type = 'daily', fee = 4 WHERE id = $1`, [c.id]);
  await run(w, y);
  const [by] = await autoBatches(sz.route.id, y);
  const token = await tokenFor(sz.col.username);
  const taskId = (await db.query('SELECT id FROM tasks WHERE batch_id = $1', [by.id])).rows[0].id;
  return { t, y, sz, c, by, token, taskId };
}
const replay = (token, a) => api('POST', '/collection-sync/replay', { token, body: { actions: [{ action_uuid: require('crypto').randomUUID(), action_type: 'batch_customer.status_change', ...a }] } });

test('late offline mark: captured before the 05:00 close, synced after it -> accepted, dated, billed once; carried copy removed', async () => {
  const w = await setupWorld();
  const { t, y, sz, c, by, token, taskId } = await closedYesterday(w, { daily: true });
  // Before today's run, yesterday's list is still open but no longer shown in the app.
  const myBefore = await api('GET', '/collection-sync/my-assignments', { token });
  assert.ok(!myBefore.data.batches.some((x) => x.id === by.id));

  await run(w, t); // the morning close: never visited -> missed 'not visited', carried to today
  const [bt] = await autoBatches(sz.route.id, t);
  assert.deepEqual((await rows(bt.id)).map((x) => x.customer_id), [c.id]);
  const total0 = (await db.query('SELECT total_customers FROM batches WHERE id = $1', [bt.id])).rows[0].total_customers;
  const tz = await companyTz();
  const capturedAt = (await localAt(y, '18:30', tz)).toISOString();

  assert.equal((await replay(token, { batch_id: by.id, customer_id: c.id, task_id: taskId, status: 'skipped', captured_at: capturedAt })).body.results[0].outcome, 'rejected_stale');
  assert.equal((await replay(token, { batch_id: by.id, customer_id: c.id, task_id: taskId, status: 'serviced' })).body.results[0].outcome, 'rejected_invalid_state');
  const early = (await localAt(shift(y, -1), '23:00', tz)).toISOString();
  assert.equal((await replay(token, { batch_id: by.id, customer_id: c.id, task_id: taskId, status: 'serviced', captured_at: early })).body.results[0].outcome, 'rejected_invalid_state');
  const putNoCap = await api('PUT', `/batches/${by.id}/customers/${c.id}/status`, { token: w.tokens.admin, body: { status: 'serviced' } });
  assert.equal(putNoCap.status, 400, JSON.stringify(putNoCap.body));

  const ok = await replay(token, { batch_id: by.id, customer_id: c.id, task_id: taskId, status: 'serviced', captured_at: capturedAt });
  assert.equal(ok.body.results[0].outcome, 'accepted', JSON.stringify(ok.body));
  const row = (await db.query(`SELECT id, status, to_char(status_at, 'YYYY-MM-DD"T"HH24:MI') AS at FROM batch_customers WHERE batch_id = $1 AND customer_id = $2`, [by.id, c.id])).rows[0];
  assert.equal(row.status, 'serviced');
  assert.equal(row.at, capturedAt.slice(0, 16));
  assert.equal((await rows(bt.id)).length, 0);
  assert.equal((await db.query('SELECT total_customers FROM batches WHERE id = $1', [bt.id])).rows[0].total_customers, total0 - 1);
  assert.equal((await db.query('SELECT status FROM batches WHERE id = $1', [by.id])).rows[0].status, 'completed');
  const again = await api('PUT', `/batches/${by.id}/customers/${c.id}/status`, { token: w.tokens.admin, body: { status: 'missed', reason: 'x', captured_at: capturedAt } });
  assert.equal(again.status, 409);
  await db.query(`INSERT INTO billing_settings (id, daily_start_date) VALUES (1, $1::date) ON CONFLICT (id) DO UPDATE SET daily_start_date = LEAST(COALESCE(billing_settings.daily_start_date, $1::date), $1::date)`, [y]);
  await runDaily({ date: y });
  await runDaily({ date: y });
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM invoices WHERE customer_id = $1', [c.id])).rows[0].n, 1);
});

test('late mark bounds: older list, after noon, and someone else\'s batch with own task', async () => {
  const w = await setupWorld();
  const { t, c, by, taskId } = await closedYesterday(w);
  const tz = await companyTz();
  // An older list (two days ago) is history: refused.
  const old = await closedYesterday(w); // fresh sub zone, list for yesterday
  await run(w, t);
  await db.query(`UPDATE batches SET start_date = start_date - 1, end_date = end_date - 1 WHERE id = $1`, [old.by.id]);
  const capOld = (await localAt(shift(t, -2), '10:00', tz)).toISOString();
  const r1 = await api('PUT', `/batches/${old.by.id}/customers/${old.c.id}/status`, { token: w.tokens.admin, body: { status: 'serviced', captured_at: capOld } });
  assert.equal(r1.status, 409, JSON.stringify(r1.body));

  // After 12:00 local today: refused (the suite raises the cut-off, so call the rule directly).
  const { pool } = require('../db');
  const { applyBatchCustomerStatusChange } = require('../lib/collectionValidation');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await applyBatchCustomerStatusChange(client, { batchId: by.id, customerId: c.id, status: 'serviced',
      capturedAt: (await localAt(shift(t, -1), '18:00', tz)).toISOString(), now: await localAt(t, '12:30', tz), lateUntilHour: 12 });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'CONFLICT');
    const before = await applyBatchCustomerStatusChange(client, { batchId: by.id, customerId: c.id, status: 'serviced',
      capturedAt: (await localAt(shift(t, -1), '18:00', tz)).toISOString(), now: await localAt(t, '11:30', tz), lateUntilHour: 12 });
    assert.equal(before.ok, true, JSON.stringify(before));
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }

  // Another collector's batch with my own task id: 403 online, rejected in sync.
  const other = await mkSubZone(w);
  const oc = await mkCust(w, other);
  await run(w, t);
  const [ob] = await autoBatches(other.route.id, t);
  const mine = await mkSubZone(w);
  await mkCust(w, mine);
  await run(w, t);
  const [mb] = await autoBatches(mine.route.id, t);
  const myTask = (await db.query('SELECT id FROM tasks WHERE batch_id = $1', [mb.id])).rows[0].id;
  const myToken = await tokenFor(mine.col.username);
  const put = await api('PUT', `/batches/${ob.id}/customers/${oc.id}/status`, { token: myToken, body: { status: 'serviced', task_id: myTask } });
  assert.equal(put.status, 403, JSON.stringify(put.body));
  const sync = await replay(myToken, { batch_id: ob.id, customer_id: oc.id, task_id: myTask, status: 'serviced' });
  assert.equal(sync.body.results[0].outcome, 'rejected_invalid_state');
  void taskId;
});

test('daily billing: one invoice per customer per local service day', async () => {
  const w = await setupWorld();
  const t = await today(w);
  const c = await mkCust(w, null);
  await db.query(`UPDATE customers SET billing_type = 'daily', fee = 3 WHERE id = $1`, [c.id]);
  const cyc = (await db.query(`INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date) VALUES ($1,'custom',CURRENT_DATE - 1,CURRENT_DATE + 1) RETURNING id`, [w.zoneA.id])).rows[0].id;
  for (let k = 0; k < 2; k++) {
    const b = (await db.query(`INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, start_date, status) VALUES ($1,$2,$3,$4,$5::date,'in_progress') RETURNING id`,
      ['DLBILL' + uniq(), w.zoneA.id, cyc, 900 + k, t])).rows[0].id;
    await db.query(`INSERT INTO batch_customers (batch_id, customer_id, status, status_at) VALUES ($1,$2,'serviced', NOW() AT TIME ZONE 'UTC')`, [b, c.id]);
  }
  const tz = await companyTz();
  const day = (await db.query(`SELECT to_char((NOW() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [tz])).rows[0].d;
  await runDaily({ date: day });
  await runDaily({ date: day });
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM invoices WHERE customer_id = $1', [c.id])).rows[0].n, 1);
});

// Runs a future day (it closes today's lists), so it is the last test in this file.
test('removing a carried customer from today\'s list ends the carry-over', async () => {
  const w = await setupWorld();
  const t = await today(w);
  const y = shift(t, -1);
  const sz = await mkSubZone(w, { days: [wd(y)] });
  const c = await mkCust(w, sz);
  await run(w, y);
  await run(w, t);
  const [bt] = await autoBatches(sz.route.id, t);
  assert.deepEqual((await rows(bt.id)).map((x) => x.customer_id), [c.id]);
  const del = await api('DELETE', `/daily-lists/${bt.id}/customers/${c.id}`, { token: w.tokens.gudoomiye });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  const resolved = (await db.query(`SELECT carry_resolved_at FROM batch_customers bc JOIN batches b ON b.id = bc.batch_id WHERE b.route_id = $1 AND b.start_date = $2::date AND bc.customer_id = $3`, [sz.route.id, y, c.id])).rows[0];
  assert.ok(resolved.carry_resolved_at);
  const tomorrow = shift(t, 1);
  await runForDate({ date: tomorrow });
  const any = await db.query(`SELECT 1 FROM batch_customers bc JOIN batches b ON b.id = bc.batch_id WHERE b.start_date = $1::date AND bc.customer_id = $2`, [tomorrow, c.id]);
  assert.equal(any.rows.length, 0);
});
