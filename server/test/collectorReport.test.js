const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, insertUser } = require('./helpers');
const { collectorDistanceKm } = require('../lib/reportsCalculations');
const { haversineMeters } = require('../lib/geo');

// F5 collector performance report: km driven (incl. GPS jump filter),
// proof overrides / no-location counts, average proof distance, first/last
// visit, daily drill-down, RBAC + zone scoping, CSV export.
let seq = 0;
const uniq = () => `${Date.now().toString().slice(-6)}${++seq}`;

// 0.009 deg latitude ~ 1 km.
const P0 = { lat: 9.56, lng: 44.06 };
const up = (p, dLat) => ({ lat: Number((p.lat + dLat).toFixed(6)), lng: p.lng });

// A track with: two good ~1 km legs, a spike out and back (> 2 km within
// 60 s, both legs ignored), and a > 5 km leg after an hour (ignored).
function track() {
  const a = { ...P0, t: 0 };
  const b = { ...up(P0, 0.009), t: 120 };
  const spike = { ...up(P0, 0.04), t: 150 };
  const c = { ...up(P0, 0.0095), t: 180 };
  const d = { ...up(P0, 0.0185), t: 600 };
  const far = { ...up(P0, 0.08), t: 4200 };
  const pts = [a, b, spike, c, d, far];
  const expected = (haversineMeters(a, b) + haversineMeters(c, d)) / 1000;
  return { pts, expected };
}

test('collector km: consecutive haversine with the jump filter', () => {
  const { pts, expected } = track();
  assert.ok(Math.abs(collectorDistanceKm(pts) - expected) < 1e-9);
  assert.ok(expected > 1.9 && expected < 2.1, String(expected));
  // A 3 km leg over 10 minutes is real driving (not a jump): counted.
  const slow = [{ ...P0, t: 0 }, { ...up(P0, 0.027), t: 600 }];
  assert.ok(Math.abs(collectorDistanceKm(slow) - haversineMeters(slow[0], slow[1]) / 1000) < 1e-9);
  // > 5 km is ignored whatever the time gap.
  assert.equal(collectorDistanceKm([{ ...P0, t: 0 }, { ...up(P0, 0.05), t: 7200 }]), 0);
  assert.equal(collectorDistanceKm([]), 0);
  assert.equal(collectorDistanceKm([{ ...P0, t: 0 }]), 0);
});

async function mkCollector(zone) {
  const n = uniq();
  const username = 'cr_col_' + n;
  const uid = await insertUser(username, 'collector', zone.name);
  const emp = (await db.query(
    `INSERT INTO employees (name, employee_type, collector_type, phone, zone_id, user_id) VALUES ($1,'collector','residential',$2,$3,$4) RETURNING id`,
    ['CR ' + username, '0653' + String(uid).padStart(6, '0'), zone.id, uid])).rows[0].id;
  return { uid, emp, username };
}

async function mkCustomerRow(w, zone) {
  const n = uniq();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: {
    customer_type: 'residential', name: 'CRCust ' + n, phone: '0654' + n.slice(-6).padStart(6, '0'), zone_id: zone.id,
    door_number: '8' + n, fee: 5 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}

// A batch created now with one collector task and the given visit rows.
async function mkBatch(w, zone, emp, visits) {
  const cyc = (await db.query(
    `INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date) VALUES ($1,'custom',CURRENT_DATE - 5,CURRENT_DATE + 5) RETURNING id`,
    [zone.id])).rows[0].id;
  const batch = (await db.query(
    `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, start_date, status) VALUES ($1,$2,$3,1,CURRENT_DATE,'in_progress') RETURNING id`,
    ['CRB' + uniq(), zone.id, cyc])).rows[0].id;
  const task = (await db.query(`INSERT INTO tasks (batch_id, status) VALUES ($1,'in_progress') RETURNING id`, [batch])).rows[0].id;
  await db.query(`INSERT INTO task_resources (task_id, resource_type, resource_id) VALUES ($1,'collector',$2)`, [task, emp]);
  for (const v of visits) {
    const c = await mkCustomerRow(w, zone);
    await db.query(
      `INSERT INTO batch_customers (batch_id, customer_id, status, status_at, proof_flag, proof_distance_m)
       VALUES ($1,$2,$3,${v.minutesAgo == null ? 'NULL' : `(NOW() AT TIME ZONE 'UTC') - make_interval(mins => ${Number(v.minutesAgo)})`},$4,$5)`,
      [batch, c.id, v.status, v.flag || null, v.dist ?? null]);
  }
  return batch;
}

let fixture;
async function setup() {
  if (fixture) return fixture;
  const w = await setupWorld();
  const col = await mkCollector(w.zoneA);
  await mkBatch(w, w.zoneA, col.emp, [
    { status: 'serviced', minutesAgo: 30, dist: 10 },
    { status: 'serviced', minutesAgo: 20, dist: 30 },
    { status: 'serviced', minutesAgo: 15, dist: 200, flag: 'override' },
    { status: 'serviced', minutesAgo: 12, flag: 'no_customer_location' },
    { status: 'missed', minutesAgo: 5 },
    { status: 'pending' },
  ]);
  // Ping history for the collector: the jump-filter track, starting 20 min ago.
  const { pts, expected } = track();
  const base = Math.floor(Date.now() / 1000) - 20 * 60;
  // The track's last point is ~70 min after the first; keep everything in the
  // past by shifting the far point (already ignored) to just before now.
  for (const p of pts) {
    const t = Math.min(base + p.t, Math.floor(Date.now() / 1000) - 5);
    await db.query(`INSERT INTO collector_location_history (employee_id, lat, lng, recorded_at) VALUES ($1,$2,$3,to_timestamp($4))`, [col.emp, p.lat, p.lng, t]);
  }
  const other = await mkCollector(w.zoneB);
  await mkBatch(w, w.zoneB, other.emp, [{ status: 'serviced', minutesAgo: 3, dist: 5 }]);
  fixture = { w, col, other, expectedKm: Math.round(expected * 100) / 100 };
  return fixture;
}

const perf = (token, extra = '') => api('GET', `/reports/collector-performance?period=today${extra}`, { token });
const daily = (token, emp) => api('GET', `/reports/collector-performance/${emp}/daily?period=today`, { token });

test('collector report: overrides, no-location, avg distance, km and visit times', async () => {
  const { w, col, expectedKm } = await setup();
  const r = await perf(w.tokens.admin, `&employee_id=${col.emp}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.data.length, 1);
  const row = r.data[0];
  assert.equal(row.assigned, 6);
  assert.equal(row.serviced, 4);
  assert.equal(row.missed, 1);
  assert.equal(row.completionRate, 66.7);
  assert.equal(row.overrides, 1);
  assert.equal(row.no_location, 1);
  assert.equal(row.avg_proof_distance_m, 80); // (10 + 30 + 200) / 3
  assert.equal(row.km_driven, expectedKm);
  assert.match(row.first_visit_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.ok(row.first_visit_at < row.last_visit_at, `${row.first_visit_at} < ${row.last_visit_at}`);
  // Existing fields stay.
  for (const k of ['employee_id', 'collector_name', 'zone_name', 'skipped', 'rescheduled']) assert.ok(k in row, k);
});

test('collector report: daily drill-down sums to the period row', async () => {
  const { w, col, expectedKm } = await setup();
  const r = await daily(w.tokens.admin, col.emp);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.data.length >= 1);
  const sum = (k) => r.data.reduce((s, d) => s + d[k], 0);
  assert.equal(sum('assigned'), 6);
  assert.equal(sum('serviced'), 4);
  assert.equal(sum('overrides'), 1);
  assert.equal(sum('no_location'), 1);
  assert.ok(Math.abs(sum('km_driven') - expectedKm) < 0.011);
  for (const d of r.data) {
    assert.match(d.day, /^\d{4}-\d{2}-\d{2}$/);
    if (d.first_visit_at) assert.match(d.first_visit_at, /^\d{2}:\d{2}$/);
  }
});

test('collector report RBAC: zone scoping, collector own-only, cashier denied', async () => {
  const { w, col, other } = await setup();
  // Gudoomiye (zone A) sees the zone A collector, not the zone B one.
  const g = await perf(w.tokens.gudoomiye);
  assert.equal(g.status, 200);
  assert.ok(g.data.some((r) => r.employee_id === col.emp));
  assert.ok(!g.data.some((r) => r.employee_id === other.emp));
  assert.equal((await daily(w.tokens.gudoomiye, col.emp)).status, 200);
  assert.equal((await daily(w.tokens.gudoomiye, other.emp)).status, 404);
  // Admin sees both.
  const a = await perf(w.tokens.admin);
  assert.ok(a.data.some((r) => r.employee_id === other.emp));
  // A collector can only read their own days.
  assert.equal((await daily(w.tokens.collector, col.emp)).status, 403);
  // Not a report role.
  assert.equal((await daily(w.tokens.cashier, col.emp)).status, 403);
  assert.equal((await perf(w.tokens.cashier)).status, 403);
  // Bad input.
  assert.equal((await api('GET', '/reports/collector-performance/abc/daily?period=today', { token: w.tokens.admin })).status, 400);
  assert.equal((await api('GET', '/reports/collector-performance/99999999/daily?period=today', { token: w.tokens.admin })).status, 404);
});

async function csv(token, path) {
  const res = await fetch(process.env.TEST_BASE + '/api/v2' + path, { headers: { Authorization: 'Bearer ' + token } });
  return { status: res.status, type: res.headers.get('content-type') || '', text: await res.text() };
}

test('collector report CSV: collectors + daily exports', async () => {
  const { w, col, other } = await setup();
  const all = await csv(w.tokens.admin, '/reports/collectors/export.csv?period=today');
  assert.equal(all.status, 200, all.text);
  assert.match(all.type, /text\/csv/);
  const header = all.text.split('\r\n')[0];
  for (const h of ['Collector', 'Overrides', 'No location', 'Avg distance (m)', 'Km driven', 'First visit', 'Last visit']) assert.ok(header.includes(`"${h}"`), h);
  assert.ok(all.text.includes(`CR cr_col_`), 'collector row present');

  const gud = await csv(w.tokens.gudoomiye, '/reports/collectors/export.csv?period=today');
  assert.equal(gud.status, 200);
  const otherName = (await db.query('SELECT name FROM employees WHERE id = $1', [other.emp])).rows[0].name;
  assert.ok(!gud.text.includes(otherName), 'zone B collector not in gudoomiye export');

  const d = await csv(w.tokens.admin, `/reports/collector-daily/export.csv?period=today&employee_id=${col.emp}`);
  assert.equal(d.status, 200, d.text);
  assert.ok(d.text.split('\r\n')[0].startsWith('"Date"'));
  assert.ok(d.text.split('\r\n').length >= 2);
  assert.equal((await csv(w.tokens.admin, '/reports/collector-daily/export.csv?period=today')).status, 400);
  assert.equal((await csv(w.tokens.gudoomiye, `/reports/collector-daily/export.csv?period=today&employee_id=${other.emp}`)).status, 404);
  assert.equal((await csv(w.tokens.cashier, '/reports/collectors/export.csv?period=today')).status, 403);
});
