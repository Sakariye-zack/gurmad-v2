const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, insertUser, tokenFor } = require('./helpers');

// Live trucks on the Map: ping history, trucks list (status, speed,
// progress, truck/batch/sub zone), today's trail + scoping, history pruning.
let seq = 0;
let live;

async function employeeFor(username, zoneId) {
  const uid = (await db.query('SELECT id FROM v2_users WHERE username = $1', [username])).rows[0].id;
  const ex = await db.query('SELECT id FROM employees WHERE user_id = $1', [uid]);
  if (ex.rows[0]) return ex.rows[0].id;
  return (await db.query(
    `INSERT INTO employees (name, employee_type, collector_type, phone, zone_id, user_id) VALUES ($1,'collector','residential',$2,$3,$4) RETURNING id`,
    ['Live ' + username, '0639' + String(uid).padStart(6, '0'), zoneId, uid])).rows[0].id;
}

async function mkCustomer(w, zone) {
  seq += 1;
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: {
    customer_type: 'residential', name: 'LiveCust ' + seq + ' ' + Date.now(), phone: '06377' + String(seq).padStart(5, '0'),
    zone_id: zone.id, door_number: String(Date.now()).slice(-8) + String(seq).padStart(3, '0'), fee: 10 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}

async function setupLive() {
  if (live) return live;
  const w = await setupWorld();
  const empA = await employeeFor('t_collector', w.zoneA.id);
  await insertUser('t_collector_b', 'collector', w.zoneB.name);
  const tokenB = await tokenFor('t_collector_b');
  const empB = await employeeFor('t_collector_b', w.zoneB.id);

  // Sub Zone (route) for the batch.
  const g = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: w.zoneA.id, code: 'LVG' + Date.now().toString().slice(-6) } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const route = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.data.id, code: 'LVR1', name: 'Live Sub Zone' } });
  assert.equal(route.status, 201, JSON.stringify(route.body));

  const cyc = (await db.query(
    `INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date) VALUES ($1,'custom',CURRENT_DATE - 5,CURRENT_DATE + 5) RETURNING id`,
    [w.zoneA.id])).rows[0].id;
  const batchCode = 'LVB' + Date.now();
  const batch = (await db.query(
    `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, start_date, status, route_id) VALUES ($1,$2,$3,1,CURRENT_DATE - 1,'in_progress',$4) RETURNING id`,
    [batchCode, w.zoneA.id, cyc, route.data.id])).rows[0].id;
  const task = (await db.query(`INSERT INTO tasks (batch_id, status) VALUES ($1,'in_progress') RETURNING id`, [batch])).rows[0].id;
  const plate = 'LV-' + Date.now().toString().slice(-6);
  const truck = (await db.query(`INSERT INTO trucks (plate_number, model, zone_id) VALUES ($1,'Isuzu NPR',$2) RETURNING id`, [plate, w.zoneA.id])).rows[0].id;
  await db.query(`INSERT INTO task_resources (task_id, resource_type, resource_id) VALUES ($1,'collector',$2),($1,'truck',$3)`, [task, empA, truck]);

  // 1 serviced today, 1 missed today, 2 pending, 1 serviced long ago (not today's work).
  const kinds = [['serviced', "NOW() AT TIME ZONE 'UTC'"], ['missed', "NOW() AT TIME ZONE 'UTC'"], ['pending', 'NULL'], ['pending', 'NULL'], ['serviced', "(NOW() AT TIME ZONE 'UTC') - INTERVAL '3 days'"]];
  for (const [status, at] of kinds) {
    const c = await mkCustomer(w, w.zoneA);
    await db.query(`INSERT INTO batch_customers (batch_id, customer_id, status, status_at) VALUES ($1,$2,$3,${at})`, [batch, c.id, status]);
  }
  live = { w, empA, empB, tokenB, batchCode, plate };
  return live;
}

// A batch + task assigned to a collector; startOffset in days from today.
async function mkWork(zone, empId, { startOffset = 0, batchStatus = 'assigned', taskStatus = 'pending' } = {}) {
  seq += 1;
  const cyc = (await db.query(
    `INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date) VALUES ($1,'custom',CURRENT_DATE - 30,CURRENT_DATE + 30) RETURNING id`,
    [zone.id])).rows[0].id;
  const batch = (await db.query(
    `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, start_date, end_date, status) VALUES ($1,$2,$3,1,CURRENT_DATE + $4::int,CURRENT_DATE + $4::int + 2,$5) RETURNING id`,
    ['LVW' + Date.now() + seq, zone.id, cyc, startOffset, batchStatus])).rows[0].id;
  const task = (await db.query(`INSERT INTO tasks (batch_id, status) VALUES ($1,$2) RETURNING id`, [batch, taskStatus])).rows[0].id;
  await db.query(`INSERT INTO task_resources (task_id, resource_type, resource_id) VALUES ($1,'collector',$2)`, [task, empId]);
  return { batch, task };
}

const historyCount = async (emp) => (await db.query('SELECT COUNT(*)::int AS n FROM collector_location_history WHERE employee_id = $1', [emp])).rows[0].n;

test('maplive: an accepted ping writes a history row; an ineligible ping does not', async () => {
  const { w, empA, empB, tokenB } = await setupLive();
  const before = await historyCount(empA);
  const r = await api('POST', '/collection-sync/location', { token: w.tokens.collector, body: { lat: 9.5221, lng: 45.5336 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.data.recorded, true);
  assert.equal(await historyCount(empA), before + 1);
  const last = (await db.query('SELECT lat::float AS lat, lng::float AS lng FROM collector_location_history WHERE employee_id = $1 ORDER BY recorded_at DESC LIMIT 1', [empA])).rows[0];
  assert.deepEqual(last, { lat: 9.5221, lng: 45.5336 });
  // Collector B only has next week's batch and a finished task today: accepted
  // silently, nothing tracked.
  await mkWork(w.zoneB, empB, { startOffset: 7 });
  await mkWork(w.zoneB, empB, { startOffset: -1, batchStatus: 'in_progress', taskStatus: 'completed' });
  const beforeB = await historyCount(empB);
  const rb = await api('POST', '/collection-sync/location', { token: tokenB, body: { lat: 9.9, lng: 45.9 } });
  assert.equal(rb.status, 200);
  assert.equal(rb.data.recorded, false);
  assert.equal(await historyCount(empB), beforeB);
});

test('maplive: trucks list carries status, speed, truck, progress, batch and sub zone', async () => {
  const { w, empA, empB, batchCode, plate } = await setupLive();
  // A point 30 s ago ~111 m south, then a fresh ping: ~13 km/h.
  await db.query('DELETE FROM collector_location_history WHERE employee_id = $1', [empA]);
  await db.query(`INSERT INTO collector_location_history (employee_id, lat, lng, recorded_at) VALUES ($1, 9.5211, 45.5336, NOW() - INTERVAL '30 seconds')`, [empA]);
  const p = await api('POST', '/collection-sync/location', { token: w.tokens.collector, body: { lat: 9.5221, lng: 45.5336 } });
  assert.equal(p.data.recorded, true);
  // Collector B in district B: an idle position (5 min old).
  await db.query(`INSERT INTO collector_locations (employee_id, lat, lng, recorded_at) VALUES ($1, 9.9, 45.9, LOCALTIMESTAMP - INTERVAL '5 minutes')
                  ON CONFLICT (employee_id) DO UPDATE SET lat = 9.9, lng = 45.9, recorded_at = LOCALTIMESTAMP - INTERVAL '5 minutes'`, [empB]);

  const r = await api('GET', '/map/trucks', { token: w.tokens.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = r.data.find((x) => x.employee_id === empA);
  assert.ok(a, 'collector A on the map');
  assert.equal(a.status, 'live');
  assert.ok(a.seconds_ago >= 0 && a.seconds_ago < 120);
  assert.equal(a.plate_number, plate);
  assert.equal(a.truck_name, 'Isuzu NPR');
  assert.equal(a.collector_name, 'Live t_collector');
  assert.deepEqual(a.progress, { serviced: 1, missed: 1, pending: 2, total: 4 });
  assert.deepEqual(a.batch_codes, [batchCode]);
  assert.deepEqual(a.sub_zone_names, ['Live Sub Zone']);
  assert.ok(a.speed_kmh > 8 && a.speed_kmh < 20, 'speed ' + a.speed_kmh);
  assert.equal(a.lat, 9.5221);
  const b = r.data.find((x) => x.employee_id === empB);
  assert.ok(b, 'collector B on the admin map');
  assert.equal(b.status, 'idle');
  assert.equal(b.speed_kmh, null);
  assert.deepEqual(b.progress, { serviced: 0, missed: 0, pending: 0, total: 0 });

  // Scoped role sees only its own district.
  const g = await api('GET', '/map/trucks?zone_id=' + w.zoneB.id, { token: w.tokens.gudoomiye });
  assert.equal(g.status, 200);
  assert.ok(g.data.find((x) => x.employee_id === empA));
  assert.ok(!g.data.find((x) => x.employee_id === empB));
  // Stale (> 10 min) positions drop off.
  await db.query(`UPDATE collector_locations SET recorded_at = LOCALTIMESTAMP - INTERVAL '11 minutes' WHERE employee_id = $1`, [empB]);
  const r2 = await api('GET', '/map/trucks', { token: w.tokens.admin });
  assert.ok(!r2.data.find((x) => x.employee_id === empB));
});

test('maplive: trail returns today in order and is district-scoped', async () => {
  const { w, empA, empB } = await setupLive();
  await db.query(`INSERT INTO collector_location_history (employee_id, lat, lng, recorded_at) VALUES ($1, 9.9, 45.9, NOW() - INTERVAL '2 minutes'), ($1, 9.91, 45.91, NOW() - INTERVAL '1 minute')`, [empB]);
  // Yesterday-and-earlier points are not "today".
  await db.query(`INSERT INTO collector_location_history (employee_id, lat, lng, recorded_at) VALUES ($1, 1, 1, NOW() - INTERVAL '2 days')`, [empA]);

  const r = await api('GET', `/map/trucks/${empA}/trail?since=today`, { token: w.tokens.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pts = r.data.points;
  assert.ok(pts.length >= 2);
  assert.ok(!pts.some((p) => p.lat === 1 && p.lng === 1));
  for (let i = 1; i < pts.length; i++) assert.ok(new Date(pts[i].recorded_at) >= new Date(pts[i - 1].recorded_at));

  const own = await api('GET', `/map/trucks/${empA}/trail`, { token: w.tokens.gudoomiye });
  assert.equal(own.status, 200);
  const other = await api('GET', `/map/trucks/${empB}/trail`, { token: w.tokens.gudoomiye });
  assert.equal(other.status, 404);
  const adminB = await api('GET', `/map/trucks/${empB}/trail`, { token: w.tokens.admin });
  assert.equal(adminB.status, 200);
  assert.equal(adminB.data.points.length, 2);
  assert.equal((await api('GET', '/map/trucks/abc/trail', { token: w.tokens.admin })).status, 400);
  assert.equal((await api('GET', `/map/trucks/${empA}/trail?since=week`, { token: w.tokens.admin })).status, 400);
  assert.equal((await api('GET', '/map/trucks/99999999/trail', { token: w.tokens.admin })).status, 404);
  // Trail is admin + gudoomiye only; the other map roles still see live trucks.
  for (const role of ['cashier', 'accountant', 'head']) {
    assert.equal((await api('GET', `/map/trucks/${empA}/trail`, { token: w.tokens[role] })).status, 403, role);
  }
  assert.equal((await api('GET', '/map/trucks', { token: w.tokens.accountant })).status, 200);
});

test('maplive: prune drops history older than 3 days and keeps recent rows', async () => {
  const { empB } = await setupLive();
  const old = (await db.query(`INSERT INTO collector_location_history (employee_id, lat, lng, recorded_at) VALUES ($1, 2, 2, NOW() - INTERVAL '4 days') RETURNING id`, [empB])).rows[0].id;
  const recent = (await db.query(`INSERT INTO collector_location_history (employee_id, lat, lng, recorded_at) VALUES ($1, 3, 3, NOW() - INTERVAL '1 day') RETURNING id`, [empB])).rows[0].id;
  const { pruneLocationHistory } = require('../lib/locationHistory');
  const removed = await pruneLocationHistory({ force: true });
  assert.ok(removed >= 1);
  const left = (await db.query('SELECT id FROM collector_location_history WHERE id = ANY($1::bigint[])', [[old, recent]])).rows.map((x) => Number(x.id));
  assert.deepEqual(left, [Number(recent)]);
  // Throttled: a non-forced call right after does nothing.
  assert.equal(await pruneLocationHistory(), null);
});

test('maplive: a collector working a batch in my district today is in scope (trucks + trail)', async () => {
  const { w, empB, tokenB } = await setupLive();
  // Home district B, but today's batch is in district A.
  await mkWork(w.zoneA, empB, { startOffset: -1, batchStatus: 'in_progress', taskStatus: 'in_progress' });
  const p = await api('POST', '/collection-sync/location', { token: tokenB, body: { lat: 9.53, lng: 45.54 } });
  assert.equal(p.data.recorded, true);
  const g = await api('GET', '/map/trucks', { token: w.tokens.gudoomiye });
  const b = g.data.find((x) => x.employee_id === empB);
  assert.ok(b, 'collector B visible to district A while working there');
  assert.equal(b.status, 'live');
  assert.equal((await api('GET', `/map/trucks/${empB}/trail`, { token: w.tokens.gudoomiye })).status, 200);
});
