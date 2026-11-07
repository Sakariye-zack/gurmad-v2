const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { api, db, setupWorld, insertUser, tokenFor } = require('./helpers');
const { runForDate } = require('../lib/dailyLists');
const { haversineMeters, nearestNeighbourOrder } = require('../lib/geo');

// F1 proof of service (geofence on Serviced) and F2 route order (visit_order,
// "next house"): online + replay + late marks, supervisor override, generator
// ordering, reorder / move endpoints, /my-assignments ordering.
const ALL_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const JS_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const wd = (date) => JS_DAYS[new Date(date + 'T00:00:00Z').getUTCDay()];
const shift = (date, n) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
let seq = 0;
const uniq = () => `${Date.now().toString().slice(-6)}${++seq}`;

// Base point; 0.0001 deg latitude ~ 11 m.
const HOUSE = { lat: 9.5600, lng: 44.0600 };
const near = (p, dLat) => ({ lat: Number((p.lat + dLat).toFixed(6)), lng: p.lng });

let todayCache = null;
async function today(w) {
  if (todayCache) return todayCache;
  const r = await api('GET', '/daily-lists', { token: w.tokens.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  todayCache = r.data.today;
  return todayCache;
}
async function run(w, date) {
  const t = await today(w);
  if (date !== t) return runForDate({ date });
  const r = await api('POST', '/daily-lists/run', { token: w.tokens.admin, body: { date } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
}

async function mkSubZone(w, { days = ALL_DAYS, start } = {}) {
  const n = uniq();
  const username = 'pr_col_' + n;
  const uid = await insertUser(username, 'collector', w.zoneA.name);
  const emp = (await db.query(
    `INSERT INTO employees (name, employee_type, collector_type, phone, zone_id, user_id) VALUES ($1,'collector','residential',$2,$3,$4) RETURNING id`,
    ['PR ' + username, '0651' + String(uid).padStart(6, '0'), w.zoneA.id, uid])).rows[0].id;
  const g = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: w.zoneA.id, code: 'PRG' + n, name: 'PR Group ' + n } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const body = { group_id: g.data.id, code: 'PRR' + n, name: 'PR Sub ' + n, work_days: days, collector_user_id: uid };
  if (start) { body.start_lat = start.lat; body.start_lng = start.lng; }
  const r = await api('POST', '/routes', { token: w.tokens.admin, body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { group: g.data, route: r.data, col: { uid, emp, username } };
}

async function mkCust(w, sz, loc) {
  const n = uniq();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: {
    customer_type: 'residential', name: 'PRCust ' + n, phone: '0652' + n.slice(-6).padStart(6, '0'), zone_id: w.zoneA.id,
    door_number: '9' + n, fee: 5, ...(loc ? { lat: loc.lat, lng: loc.lng } : {}) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await db.query('UPDATE customers SET group_id = $1, route_id = $2 WHERE id = $3', [sz.group.id, sz.route.id, r.data.id]);
  return r.data;
}

async function batchFor(routeId, date) {
  return (await db.query(`SELECT * FROM batches WHERE auto_generated AND route_id = $1 AND start_date = $2::date ORDER BY id`, [routeId, date])).rows[0];
}
async function taskOf(batchId) {
  return (await db.query('SELECT id FROM tasks WHERE batch_id = $1 ORDER BY id LIMIT 1', [batchId])).rows[0].id;
}
async function bcRow(batchId, customerId) {
  return (await db.query('SELECT * FROM batch_customers WHERE batch_id = $1 AND customer_id = $2', [batchId, customerId])).rows[0];
}
async function orderOf(batchId) {
  return (await db.query('SELECT customer_id FROM batch_customers WHERE batch_id = $1 ORDER BY visit_order, id', [batchId])).rows.map((r) => r.customer_id);
}
const replay = (token, a) => api('POST', '/collection-sync/replay', { token, body: { actions: [{ action_uuid: crypto.randomUUID(), action_type: 'batch_customer.status_change', ...a }] } });

// A today's list with the given customer locations (null = no location).
async function todaysList(w, locs, opts = {}) {
  const t = await today(w);
  const sz = await mkSubZone(w, opts);
  const custs = [];
  for (const l of locs) custs.push(await mkCust(w, sz, l));
  await run(w, t);
  const b = await batchFor(sz.route.id, t);
  assert.ok(b, 'list generated');
  return { t, sz, custs, b, token: await tokenFor(sz.col.username), taskId: await taskOf(b.id) };
}
const mark = (token, b, c, taskId, body) => api('PUT', `/batches/${b.id}/customers/${c.id}/status`, { token, body: { task_id: taskId, ...body } });

test('geo: haversine and nearest-neighbour helpers', () => {
  const d = haversineMeters(HOUSE, near(HOUSE, 0.001));
  assert.ok(d > 105 && d < 117, String(d));
  const order = nearestNeighbourOrder([
    { id: 1, lat: 9.6, lng: 44.06 }, { id: 2, lat: null, lng: null }, { id: 3, lat: 9.57, lng: 44.06 }, { id: 4, lat: 9.58, lng: 44.06 },
  ], { lat: 9.56, lng: 44.06 });
  assert.deepEqual(order, [3, 4, 1, 2]);
  assert.deepEqual(nearestNeighbourOrder([{ id: 5, lat: 9.6, lng: 44 }, { id: 2, lat: 9.7, lng: 44 }, { id: 9, lat: 9.65, lng: 44 }], null), [2, 9, 5]);
});

test('proof: serviced within radius accepted and distance stored; outside radius and missing GPS rejected', async () => {
  const w = await setupWorld();
  const { custs: [c], b, token, taskId } = await todaysList(w, [HOUSE]);
  const far = await mark(token, b, c, taskId, { status: 'serviced', ...near(HOUSE, 0.001) });
  assert.equal(far.status, 400, JSON.stringify(far.body));
  assert.equal(far.body.error.code, 'VALIDATION');
  assert.match(far.body.error.message, /You are 1\d\d m from this house \(limit 50 m\)/);
  const noGps = await mark(token, b, c, taskId, { status: 'serviced' });
  assert.equal(noGps.status, 400);
  assert.match(noGps.body.error.message, /Turn on GPS/);
  assert.equal((await bcRow(b.id, c.id)).status, 'pending');

  const ok = await mark(token, b, c, taskId, { status: 'serviced', ...near(HOUSE, 0.0002) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = await bcRow(b.id, c.id);
  assert.equal(row.status, 'serviced');
  assert.ok(row.proof_distance_m >= 20 && row.proof_distance_m <= 24, String(row.proof_distance_m));
  assert.equal(row.proof_flag, null);
});

test('proof: radius setting is respected and validated', async () => {
  const w = await setupWorld();
  const bad = await api('PUT', '/settings/company', { token: w.tokens.admin, body: { proof_radius_m: 5 } });
  assert.equal(bad.status, 400);
  const badPhoto = await api('PUT', '/settings/company', { token: w.tokens.admin, body: { proof_require_photo: 'yes' } });
  assert.equal(badPhoto.status, 400);
  const set = await api('PUT', '/settings/company', { token: w.tokens.admin, body: { proof_radius_m: 200, proof_require_photo: true } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.data.proof_radius_m, 200);
  assert.equal(set.data.proof_require_photo, true);
  try {
    const { custs: [c], b, token, taskId } = await todaysList(w, [HOUSE]);
    const my = await api('GET', '/collection-sync/my-assignments', { token });
    assert.deepEqual(my.data.proof, { radius_m: 200, require_photo: true });
    const ok = await mark(token, b, c, taskId, { status: 'serviced', ...near(HOUSE, 0.001) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  } finally {
    const reset = await api('PUT', '/settings/company', { token: w.tokens.admin, body: { proof_radius_m: 50, proof_require_photo: false } });
    assert.equal(reset.status, 200);
  }
});

test('proof: customer without location accepted with proof_flag; missed/skipped not geofenced', async () => {
  const w = await setupWorld();
  const { custs: [noLoc, missed, skipped], b, token, taskId } = await todaysList(w, [null, HOUSE, HOUSE]);
  const a = await mark(token, b, noLoc, taskId, { status: 'serviced' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const r = await bcRow(b.id, noLoc.id);
  assert.equal(r.proof_flag, 'no_customer_location');
  assert.equal(r.proof_distance_m, null);
  const m = await mark(token, b, missed, taskId, { status: 'missed', reason: 'gate closed' });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  const s = await mark(token, b, skipped, taskId, { status: 'skipped', ...near(HOUSE, 0.01) });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal((await bcRow(b.id, missed.id)).proof_flag, null);
  assert.equal((await bcRow(b.id, skipped.id)).proof_distance_m, null);
});

test('proof: replay path enforces the geofence', async () => {
  const w = await setupWorld();
  const { custs: [c], b, token, taskId } = await todaysList(w, [HOUSE]);
  const far = await replay(token, { batch_id: b.id, customer_id: c.id, task_id: taskId, status: 'serviced', ...near(HOUSE, 0.002) });
  assert.equal(far.body.results[0].outcome, 'rejected_invalid_state', JSON.stringify(far.body));
  assert.match(far.body.results[0].message, /m from this house/);
  const noGps = await replay(token, { batch_id: b.id, customer_id: c.id, task_id: taskId, status: 'serviced' });
  assert.equal(noGps.body.results[0].outcome, 'rejected_invalid_state');
  assert.match(noGps.body.results[0].message, /Turn on GPS/);
  // A client cannot smuggle an override through replay.
  const smuggle = await replay(token, { batch_id: b.id, customer_id: c.id, task_id: taskId, status: 'serviced', override: { reason: 'x', by: 1 } });
  assert.equal(smuggle.body.results[0].outcome, 'rejected_invalid_state');
  const ok = await replay(token, { batch_id: b.id, customer_id: c.id, task_id: taskId, status: 'serviced', ...near(HOUSE, 0.0001) });
  assert.equal(ok.body.results[0].outcome, 'accepted', JSON.stringify(ok.body));
  const row = await bcRow(b.id, c.id);
  assert.ok(row.proof_distance_m <= 12, String(row.proof_distance_m));
});

test('proof: late mark on a closed list passes the geofence too', async () => {
  const w = await setupWorld();
  const t = await today(w);
  const y = shift(t, -1);
  const sz = await mkSubZone(w, { days: [wd(y)] });
  const c = await mkCust(w, sz, HOUSE);
  await run(w, y);
  const by = await batchFor(sz.route.id, y);
  const token = await tokenFor(sz.col.username);
  const taskId = await taskOf(by.id);
  await run(w, t); // closes yesterday's list: c -> missed 'not visited'
  const tz = (await db.query(`SELECT COALESCE((SELECT timezone FROM company_settings WHERE timezone IS NOT NULL AND timezone <> '' ORDER BY id LIMIT 1), 'Africa/Mogadishu') AS tz`)).rows[0].tz;
  const capturedAt = new Date((await db.query(`SELECT (($1::date + TIME '18:30') AT TIME ZONE $2) AS at`, [y, tz])).rows[0].at).toISOString();
  // Rollout long before this list: no legacy grace applies.
  const prevEnforced = (await db.query(`SELECT proof_enforced_from FROM company_settings ORDER BY id LIMIT 1`)).rows[0]?.proof_enforced_from ?? null;
  await db.query(`UPDATE company_settings SET proof_enforced_from = NOW() - INTERVAL '30 days'`);
  const far = await replay(token, { batch_id: by.id, customer_id: c.id, task_id: taskId, status: 'serviced', captured_at: capturedAt, ...near(HOUSE, 0.003) });
  await db.query(`UPDATE company_settings SET proof_enforced_from = $1`, [prevEnforced]);
  assert.equal(far.body.results[0].outcome, 'rejected_invalid_state', JSON.stringify(far.body));
  assert.match(far.body.results[0].message, /m from this house/);
  const ok = await replay(token, { batch_id: by.id, customer_id: c.id, task_id: taskId, status: 'serviced', captured_at: capturedAt, ...near(HOUSE, 0.0001) });
  assert.equal(ok.body.results[0].outcome, 'accepted', JSON.stringify(ok.body));
  const row = await bcRow(by.id, c.id);
  assert.equal(row.status, 'serviced');
  assert.ok(row.proof_distance_m !== null);
});

test('override: supervisor can mark serviced with a reason (audited); collector cannot', async () => {
  const w = await setupWorld();
  const { custs: [c, c2], b, token } = await todaysList(w, [HOUSE, HOUSE]);
  const url = `/daily-lists/${b.id}/customers/${c.id}/override`;
  const col = await api('POST', url, { token, body: { reason: 'phone broken' } });
  assert.equal(col.status, 403);
  const acc = await api('POST', url, { token: w.tokens.accountant, body: { reason: 'phone broken' } });
  assert.equal(acc.status, 403);
  const noReason = await api('POST', url, { token: w.tokens.gudoomiye, body: { reason: '  ' } });
  assert.equal(noReason.status, 400);
  const ok = await api('POST', url, { token: w.tokens.gudoomiye, body: { reason: 'GPS failed on phone' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = await bcRow(b.id, c.id);
  assert.equal(row.status, 'serviced');
  assert.equal(row.proof_flag, 'override');
  assert.equal(row.proof_override_reason, 'GPS failed on phone');
  const gid = (await db.query(`SELECT id FROM v2_users WHERE username = 't_gudoomiye'`)).rows[0].id;
  assert.equal(row.proof_override_by, gid);
  const audit = await db.query(`SELECT 1 FROM v2_audit_log WHERE action = 'daily_list.override_serviced' AND entity_id = $1 AND actor_id = $2`, [row.id, gid]);
  assert.equal(audit.rows.length, 1);
  const again = await api('POST', url, { token: w.tokens.admin, body: { reason: 'again' } });
  assert.equal(again.status, 409);
  const admin = await api('POST', `/daily-lists/${b.id}/customers/${c2.id}/override`, { token: w.tokens.admin, body: { reason: 'checked by phone' } });
  assert.equal(admin.status, 200, JSON.stringify(admin.body));
});

test('route order: nearest-neighbour from the Sub Zone start, no-location customers last', async () => {
  const w = await setupWorld();
  const start = { lat: 9.5000, lng: 44.0000 };
  // Created in a scrambled order so id order != visit order.
  const locs = [{ lat: 9.5300, lng: 44.0000 }, null, { lat: 9.5100, lng: 44.0000 }, { lat: 9.5200, lng: 44.0000 }, null];
  const { custs, b } = await todaysList(w, locs, { start });
  const [far3, none1, n1, n2, none2] = custs;
  assert.deepEqual(await orderOf(b.id), [n1.id, n2.id, far3.id, none1.id, none2.id]);
  const vo = (await db.query('SELECT visit_order FROM batch_customers WHERE batch_id = $1 ORDER BY visit_order', [b.id])).rows.map((r) => r.visit_order);
  assert.deepEqual(vo, [1, 2, 3, 4, 5]);
});

test('route order: falls back to the collector last location, else first customer by id', async () => {
  const w = await setupWorld();
  const t = await today(w);
  // Fallback 1: collector's last known location (near the "far" end).
  const sz = await mkSubZone(w);
  const a = await mkCust(w, sz, { lat: 9.5100, lng: 44.0 });
  const bb = await mkCust(w, sz, { lat: 9.5300, lng: 44.0 });
  const c = await mkCust(w, sz, { lat: 9.5200, lng: 44.0 });
  await db.query(`INSERT INTO collector_locations (employee_id, lat, lng) VALUES ($1, 9.5400, 44.0) ON CONFLICT (employee_id) DO UPDATE SET lat = 9.54, lng = 44.0`, [sz.col.emp]);
  await run(w, t);
  const b1 = await batchFor(sz.route.id, t);
  assert.deepEqual(await orderOf(b1.id), [bb.id, c.id, a.id]);
  // Fallback 2: nothing -> start at the first located customer by id.
  const sz2 = await mkSubZone(w);
  const x = await mkCust(w, sz2, { lat: 9.5300, lng: 44.0 });
  const y = await mkCust(w, sz2, { lat: 9.5100, lng: 44.0 });
  const z = await mkCust(w, sz2, { lat: 9.5250, lng: 44.0 });
  await run(w, t);
  const b2 = await batchFor(sz2.route.id, t);
  assert.deepEqual(await orderOf(b2.id), [x.id, z.id, y.id]);
});

test('route order: reorder and move endpoints; added customer goes last; my-assignments follows visit order', async () => {
  const w = await setupWorld();
  const start = { lat: 9.5000, lng: 44.0000 };
  const { sz, custs, b, token } = await todaysList(w, [{ lat: 9.5300, lng: 44.0 }, { lat: 9.5100, lng: 44.0 }, { lat: 9.5200, lng: 44.0 }], { start });
  const [c3, c1, c2] = custs;
  assert.deepEqual(await orderOf(b.id), [c1.id, c2.id, c3.id]);

  // my-assignments: visit order, with visit_order and proof settings.
  const my = await api('GET', '/collection-sync/my-assignments', { token });
  assert.equal(my.status, 200, JSON.stringify(my.body));
  const mine = my.data.batches.find((x) => x.id === b.id);
  assert.deepEqual(mine.customers.map((x) => x.customer_id), [c1.id, c2.id, c3.id]);
  assert.deepEqual(mine.customers.map((x) => x.visit_order), [1, 2, 3]);
  assert.equal(my.data.proof.radius_m, 50);

  // Move c3 up -> c1, c3, c2. Collector / accountant cannot.
  const moveUrl = `/daily-lists/${b.id}/customers/${c3.id}/order`;
  assert.equal((await api('PUT', moveUrl, { token, body: { direction: 'up' } })).status, 403);
  assert.equal((await api('PUT', moveUrl, { token: w.tokens.accountant, body: { direction: 'up' } })).status, 403);
  assert.equal((await api('PUT', moveUrl, { token: w.tokens.gudoomiye, body: { direction: 'sideways' } })).status, 400);
  const up = await api('PUT', moveUrl, { token: w.tokens.gudoomiye, body: { direction: 'up' } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.deepEqual(await orderOf(b.id), [c1.id, c3.id, c2.id]);
  const down = await api('PUT', `/daily-lists/${b.id}/customers/${c1.id}/order`, { token: w.tokens.admin, body: { direction: 'down' } });
  assert.equal(down.status, 200);
  assert.deepEqual(await orderOf(b.id), [c3.id, c1.id, c2.id]);
  // Moving the first row up is a no-op.
  await api('PUT', moveUrl, { token: w.tokens.admin, body: { direction: 'up' } });
  assert.deepEqual(await orderOf(b.id), [c3.id, c1.id, c2.id]);
  const after = await api('GET', '/collection-sync/my-assignments', { token });
  assert.deepEqual(after.data.batches.find((x) => x.id === b.id).customers.map((x) => x.customer_id), [c3.id, c1.id, c2.id]);
  // Web Today's-list rows come back in visit order too.
  const web = await api('GET', `/batches/${b.id}/customers`, { token: w.tokens.admin });
  assert.deepEqual(web.data.map((r) => r.customer_id), [c3.id, c1.id, c2.id]);

  // Added by hand -> last.
  const extra = await mkCust(w, sz, { lat: 9.5050, lng: 44.0 });
  await db.query('UPDATE customers SET route_id = NULL WHERE id = $1', [extra.id]);
  const add = await api('POST', `/daily-lists/${b.id}/customers`, { token: w.tokens.admin, body: { customer_id: extra.id } });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal(add.data.visit_order, 4);

  // Start point moved to the far end, then Re-order recomputes everything.
  const put = await api('PUT', `/routes/${sz.route.id}`, { token: w.tokens.admin, body: { start_lat: 9.6, start_lng: 44.0 } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await api('POST', `/daily-lists/${b.id}/reorder`, { token })).status, 403);
  const re = await api('POST', `/daily-lists/${b.id}/reorder`, { token: w.tokens.gudoomiye });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.deepEqual(await orderOf(b.id), [c3.id, c2.id, c1.id, extra.id]);
  assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM v2_audit_log WHERE action IN ('daily_list.reorder', 'daily_list.move_customer') AND entity_id = $1`, [b.id])).rows[0].n, 3);

  // Start point validation: both or neither.
  const half = await api('PUT', `/routes/${sz.route.id}`, { token: w.tokens.admin, body: { start_lat: 9.6 } });
  assert.equal(half.status, 400);
  const clear = await api('PUT', `/routes/${sz.route.id}`, { token: w.tokens.admin, body: { start_lat: null, start_lng: null } });
  assert.equal(clear.status, 200);
  assert.equal(clear.data.start_lat, null);
});

// ---------- Fix round ----------
const { backfillVisitOrder } = require('../lib/dailyLists');

test('office serviced on a located customer is an override: reason required, flagged, audited', async () => {
  const w = await setupWorld();
  const { custs: [c, c2, c3], b, token, taskId } = await todaysList(w, [HOUSE, HOUSE, HOUSE]);
  const url = (x) => `/batches/${b.id}/customers/${x.id}/status`;
  const noReason = await api('PUT', url(c), { token: w.tokens.admin, body: { status: 'serviced' } });
  assert.equal(noReason.status, 400, JSON.stringify(noReason.body));
  assert.equal(noReason.body.error.code, 'OVERRIDE_REASON_REQUIRED');
  const ok = await api('PUT', url(c), { token: w.tokens.admin, body: { status: 'serviced', override_reason: 'confirmed by phone call' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = await bcRow(b.id, c.id);
  assert.equal(row.proof_flag, 'override');
  assert.equal(row.proof_override_reason, 'confirmed by phone call');
  const adminId = (await db.query(`SELECT id FROM v2_users WHERE username = 't_admin'`)).rows[0].id;
  assert.equal(row.proof_override_by, adminId);
  assert.equal((await db.query(`SELECT 1 FROM v2_audit_log WHERE action = 'batch_customer.override_serviced' AND entity_id = $1`, [row.id])).rows.length, 1);
  // Office with GPS inside the radius: a normal mark.
  const inside = await api('PUT', url(c2), { token: w.tokens.admin, body: { status: 'serviced', ...near(HOUSE, 0.0001), accuracy: 6 } });
  assert.equal(inside.status, 200, JSON.stringify(inside.body));
  assert.equal((await bcRow(b.id, c2.id)).proof_flag, null);
  // A collector can never turn a geofence rejection into an override.
  const col = await mark(token, b, c3, taskId, { status: 'serviced', override_reason: 'trust me' });
  assert.equal(col.status, 400);
  assert.equal(col.body.error.code, 'VALIDATION');
  // The collector does not see who overrode or why.
  const view = await api('GET', `/batches/${b.id}/customers`, { token });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const seen = view.data.find((r) => r.customer_id === c.id);
  assert.equal(seen.proof_flag, 'override');
  assert.ok(!('proof_override_reason' in seen) && !('proof_override_by' in seen));
  const adminView = await api('GET', `/batches/${b.id}/customers`, { token: w.tokens.admin });
  assert.equal(adminView.data.find((r) => r.customer_id === c.id).proof_override_reason, 'confirmed by phone call');
});

test('legacy offline marks: no GPS, captured before the rollout -> accepted as legacy_no_gps; otherwise strict', async () => {
  const w = await setupWorld();
  await api('PUT', '/settings/company', { token: w.tokens.admin, body: { proof_radius_m: 50 } });
  const orig = (await db.query('SELECT id, proof_enforced_from FROM company_settings ORDER BY id LIMIT 1')).rows[0];
  assert.ok(orig && orig.proof_enforced_from, 'rollout time set');
  const { custs: [a, b2, c3], b, token, taskId } = await todaysList(w, [HOUSE, HOUSE, HOUSE]);
  try {
    await db.query(`UPDATE company_settings SET proof_enforced_from = NOW() - INTERVAL '2 minutes' WHERE id = $1`, [orig.id]);
    const before = new Date(Date.now() - 4 * 60 * 1000).toISOString();
    const legacy = await replay(token, { batch_id: b.id, customer_id: a.id, task_id: taskId, status: 'serviced', captured_at: before });
    assert.equal(legacy.body.results[0].outcome, 'accepted', JSON.stringify(legacy.body));
    assert.equal((await bcRow(b.id, a.id)).proof_flag, 'legacy_no_gps');
    const after = await replay(token, { batch_id: b.id, customer_id: b2.id, task_id: taskId, status: 'serviced', captured_at: new Date().toISOString() });
    assert.equal(after.body.results[0].outcome, 'rejected_invalid_state');
    const noCap = await replay(token, { batch_id: b.id, customer_id: c3.id, task_id: taskId, status: 'serviced' });
    assert.equal(noCap.body.results[0].outcome, 'rejected_invalid_state');
  } finally {
    await db.query('UPDATE company_settings SET proof_enforced_from = $2 WHERE id = $1', [orig.id, orig.proof_enforced_from]);
  }
});

test('suspect exact point and accuracy stored (online and replay)', async () => {
  const w = await setupWorld();
  const { custs: [a, b2, c3], b, token, taskId } = await todaysList(w, [HOUSE, HOUSE, HOUSE]);
  const exact = await mark(token, b, a, taskId, { status: 'serviced', lat: HOUSE.lat, lng: HOUSE.lng });
  assert.equal(exact.status, 200, JSON.stringify(exact.body));
  assert.equal((await bcRow(b.id, a.id)).proof_flag, 'suspect_exact');
  const withAcc = await mark(token, b, b2, taskId, { status: 'serviced', lat: HOUSE.lat, lng: HOUSE.lng, accuracy: 7.6 });
  assert.equal(withAcc.status, 200);
  const r2 = await bcRow(b.id, b2.id);
  assert.equal(r2.proof_flag, null);
  assert.equal(r2.proof_accuracy_m, 8);
  const rp = await replay(token, { batch_id: b.id, customer_id: c3.id, task_id: taskId, status: 'serviced', ...near(HOUSE, 0.0001), accuracy: 12 });
  assert.equal(rp.body.results[0].outcome, 'accepted');
  assert.equal((await bcRow(b.id, c3.id)).proof_accuracy_m, 12);
});

test('override only on the list of today', async () => {
  const w = await setupWorld();
  const { t, custs: [c], b } = await todaysList(w, [HOUSE]);
  await db.query('UPDATE batches SET start_date = $2::date, end_date = $2::date WHERE id = $1', [b.id, shift(t, 1)]);
  const r = await api('POST', `/daily-lists/${b.id}/customers/${c.id}/override`, { token: w.tokens.admin, body: { reason: 'early' } });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal((await bcRow(b.id, c.id)).status, 'pending');
});

test('visit order backfill: lists without any order get one (move, boot backfill), id tiebreak', async () => {
  const w = await setupWorld();
  const start = { lat: 9.5000, lng: 44.0000 };
  const one = await todaysList(w, [{ lat: 9.5300, lng: 44.0 }, { lat: 9.5100, lng: 44.0 }], { start });
  const [f1, n1] = one.custs;
  await db.query('UPDATE batch_customers SET visit_order = NULL WHERE batch_id = $1', [one.b.id]);
  const mv = await api('PUT', `/daily-lists/${one.b.id}/customers/${f1.id}/order`, { token: w.tokens.admin, body: { direction: 'up' } });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  // Backfilled (route start -> n1, f1) and then f1 moved up.
  assert.deepEqual(await orderOf(one.b.id), [f1.id, n1.id]);

  const two = await todaysList(w, [{ lat: 9.5300, lng: 44.0 }, { lat: 9.5100, lng: 44.0 }], { start });
  await db.query('UPDATE batch_customers SET visit_order = NULL WHERE batch_id = $1', [two.b.id]);
  const n = await backfillVisitOrder();
  assert.ok(n >= 1);
  assert.deepEqual(await orderOf(two.b.id), [two.custs[1].id, two.custs[0].id]);
  // Ordering tiebreak is batch_customers.id everywhere.
  await db.query('UPDATE batch_customers SET visit_order = NULL WHERE batch_id = $1', [two.b.id]);
  const web = await api('GET', `/batches/${two.b.id}/customers`, { token: w.tokens.admin });
  const ids = (await db.query('SELECT customer_id FROM batch_customers WHERE batch_id = $1 ORDER BY id', [two.b.id])).rows.map((r) => r.customer_id);
  assert.deepEqual(web.data.map((r) => r.customer_id), ids);
});

test('re-order keeps finished rows first; pending from fresh collector location, else last finished house', async () => {
  const w = await setupWorld();
  const start = { lat: 9.5000, lng: 44.0000 };
  const L = (lat) => ({ lat, lng: 44.0 });
  const { sz, custs, b, token, taskId } = await todaysList(w, [L(9.5100), L(9.5200), L(9.5300), L(9.5400)], { start });
  const [c1, c2, c3, c4] = custs;
  assert.deepEqual(await orderOf(b.id), [c1.id, c2.id, c3.id, c4.id]);
  // c3 visited first (out of order).
  const m = await mark(token, b, c3, taskId, { status: 'serviced', ...near(L(9.5300), 0.0001) });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  // Fresh collector location at the far end -> c4 first among pending.
  await db.query(`INSERT INTO collector_locations (employee_id, lat, lng, recorded_at) VALUES ($1, 9.55, 44.0, CURRENT_TIMESTAMP)
    ON CONFLICT (employee_id) DO UPDATE SET lat = 9.55, lng = 44.0, recorded_at = CURRENT_TIMESTAMP`, [sz.col.emp]);
  const r1 = await api('POST', `/daily-lists/${b.id}/reorder`, { token: w.tokens.admin });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.deepEqual(await orderOf(b.id), [c3.id, c4.id, c2.id, c1.id]);
  // Stale collector location -> start from the last finished house (c3, 9.53).
  await db.query(`UPDATE collector_locations SET recorded_at = CURRENT_TIMESTAMP - INTERVAL '2 hours' WHERE employee_id = $1`, [sz.col.emp]);
  await db.query('UPDATE customers SET lat = 9.5000 WHERE id = $1', [c4.id]); // c4 now at the far bottom
  const r2 = await api('POST', `/daily-lists/${b.id}/reorder`, { token: w.tokens.admin });
  assert.equal(r2.status, 200);
  assert.deepEqual(await orderOf(b.id), [c3.id, c2.id, c1.id, c4.id]);
});

test('generation ignores a stale collector location', async () => {
  const w = await setupWorld();
  const t = await today(w);
  const sz = await mkSubZone(w);
  const x = await mkCust(w, sz, { lat: 9.5300, lng: 44.0 });
  const y = await mkCust(w, sz, { lat: 9.5100, lng: 44.0 });
  const z = await mkCust(w, sz, { lat: 9.5250, lng: 44.0 });
  await db.query(`INSERT INTO collector_locations (employee_id, lat, lng, recorded_at) VALUES ($1, 9.50, 44.0, CURRENT_TIMESTAMP - INTERVAL '2 hours')
    ON CONFLICT (employee_id) DO UPDATE SET lat = 9.50, lng = 44.0, recorded_at = CURRENT_TIMESTAMP - INTERVAL '2 hours'`, [sz.col.emp]);
  await run(w, t);
  const b = await batchFor(sz.route.id, t);
  // Stale -> lowest-id start (x), not the collector point near y.
  assert.deepEqual(await orderOf(b.id), [x.id, z.id, y.id]);
});
