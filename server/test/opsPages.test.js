const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, insertUser, tokenFor } = require('./helpers');

// Ops pages clarity: read-only aggregates on the Districts list (GET /zones),
// Groups list (GET /groups), Batches list (GET /batches: source / Sub Zone /
// collector / truck / date + source filters) and the dashboard setup
// checklist (GET /dashboard/setup-health). Every test builds its own fresh
// district so counts are exact regardless of what other files created.
let seq = 0;
const uniq = () => `${Date.now().toString().slice(-6)}${++seq}`;
const ALL_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];

async function mkDistrict(w) {
  const n = uniq();
  const r = await api('POST', '/zones', { token: w.tokens.admin, body: { name: 'Ops District ' + n, zone_code: 'OPS' + n } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}
async function mkGroup(w, zone, name) {
  const r = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: zone.id, code: 'OG' + uniq(), name } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}
async function mkGroupZone(group) {
  return (await db.query(`INSERT INTO group_zones (group_id, code, name) VALUES ($1,$2,$3) RETURNING id`, [group.id, 'GZ' + uniq(), 'GZ'])).rows[0].id;
}
async function mkUser(zone, fullName) {
  const username = 'op_u_' + uniq();
  const uid = await insertUser(username, 'collector', zone.name);
  if (fullName) await db.query('UPDATE v2_users SET full_name = $1 WHERE id = $2', [fullName, uid]);
  return uid;
}
async function mkEmployee(zone, uid, { type = 'residential', shift = null } = {}) {
  return (await db.query(
    `INSERT INTO employees (name, employee_type, collector_type, commercial_shift, phone, zone_id, user_id) VALUES ($1,'collector',$2,$3,$4,$5,$6) RETURNING id`,
    ['OP emp ' + uid, type, shift, '0671' + String(uid).padStart(6, '0'), zone.id, uid])).rows[0].id;
}
async function mkTruck(zone) {
  return (await db.query(`INSERT INTO trucks (plate_number, zone_id) VALUES ($1,$2) RETURNING id, plate_number`, ['OPT-' + uniq(), zone.id])).rows[0];
}
async function mkRoute(group, { collector = null, truck = null, days = ALL_DAYS, start = true, groupZoneId = null, name } = {}) {
  const n = uniq();
  return (await db.query(
    `INSERT INTO routes (group_id, code, name, collector_user_id, truck_id, work_days, start_lat, start_lng, group_zone_id)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
    [group.id, 'OR' + n, name || 'Ops Sub ' + n, collector, truck, JSON.stringify(days), start ? 9.56 : null, start ? 44.06 : null, groupZoneId])).rows[0];
}
async function mkCust(w, zone, { group = null, route = null, located = true, type = 'residential', shift = null, status = 'active' } = {}) {
  const n = uniq();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: {
    customer_type: type, name: 'OpCust ' + n, phone: '0672' + n.slice(-6).padStart(6, '0'), zone_id: zone.id, door_number: '9' + n, fee: 5,
    ...(type === 'commercial' ? { commercial_shift: shift || 'day', business_name: 'Op Shop ' + n } : {}) } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await db.query(
    `UPDATE customers SET group_id = $1, route_id = $2, lat = $3, lng = $4, status = $5 WHERE id = $6`,
    [group ? group.id : null, route ? route.id : null, located ? 9.5 : null, located ? 44.0 : null, status, r.data.id]);
  return r.data;
}
async function gudoomiyeFor(zone) {
  const username = 'op_gud_' + uniq();
  await insertUser(username, 'gudoomiye', zone ? zone.name : null);
  return tokenFor(username);
}

// ---------- A. Districts list ----------
test('districts list: per-district counts, scoped to what the caller can see', async () => {
  const w = await setupWorld();
  const d = await mkDistrict(w);
  const g1 = await mkGroup(w, d, 'Bravo');
  await mkGroup(w, d, 'Alpha'); // empty group still counts as a group
  const gz1 = await mkGroupZone(g1);
  await mkGroupZone(g1);
  const u1 = await mkUser(d);
  const u2 = await mkUser(d);
  const r1 = await mkRoute(g1, { collector: u1, groupZoneId: gz1 });
  await mkRoute(g1, { collector: u1 });
  await mkRoute(g1, { collector: u2 });
  await mkRoute(g1, {}); // no collector: not a collector
  await mkCust(w, d, { group: g1, route: r1 });
  await mkCust(w, d, { group: g1, route: r1 });
  await mkCust(w, d);
  await mkCust(w, d, { status: 'archived' }); // not active: not counted

  const admin = await api('GET', '/zones?limit=200', { token: w.tokens.admin });
  assert.equal(admin.status, 200, JSON.stringify(admin.body));
  const row = admin.data.find((z) => z.id === d.id);
  assert.ok(row, 'district listed');
  assert.equal(row.group_count, 2);
  assert.equal(row.group_zone_count, 2);
  assert.equal(row.subzone_count, 4);
  assert.equal(row.customer_count, 3);
  assert.equal(row.collector_count, 2);
  // Legacy fields are still returned (form + DB untouched).
  assert.ok('sub_zone' in row && 'area' in row && 'collection_days' in row);
  const otherA = admin.data.find((z) => z.id === w.zoneA.id);
  assert.equal(typeof otherA.customer_count, 'number', 'admin sees every district\'s counts');

  // Gudoomiye of this district: own counts filled, others null.
  const gudD = await gudoomiyeFor(d);
  const g = await api('GET', '/zones?limit=200', { token: gudD });
  assert.equal(g.status, 200);
  assert.equal(g.data.find((z) => z.id === d.id).customer_count, 3);
  const aForGud = g.data.find((z) => z.id === w.zoneA.id);
  assert.ok(aForGud, 'list itself stays unscoped');
  for (const k of ['group_count', 'group_zone_count', 'subzone_count', 'customer_count', 'collector_count']) assert.equal(aForGud[k], null, k);

  // Gudoomiye of zone A does not see this district's size.
  const ga = await api('GET', '/zones?limit=200', { token: w.tokens.gudoomiye });
  assert.equal(ga.data.find((z) => z.id === d.id).customer_count, null);

  // Status filter still works with the counts.
  const active = await api('GET', '/zones?status=active&limit=200', { token: w.tokens.admin });
  assert.equal(active.status, 200);
  assert.equal(active.data.find((z) => z.id === d.id).subzone_count, 4);
  assert.equal((await api('GET', '/zones?status=bogus', { token: w.tokens.admin })).status, 400);
});

// ---------- B. Groups list ----------
test('groups list: zones count, distinct collectors, empty flag, sorted by district then name', async () => {
  const w = await setupWorld();
  const d = await mkDistrict(w);
  const full = await mkGroup(w, d, 'Bravo');
  const empty = await mkGroup(w, d, 'Alpha');
  const custOnly = await mkGroup(w, d, 'Charlie');
  await mkGroupZone(full);
  await mkGroupZone(full);
  await mkGroupZone(full);
  const u1 = await mkUser(d, 'Axmed Cali');
  const u2 = await mkUser(d, 'Bashiir Nuur');
  const r1 = await mkRoute(full, { collector: u1 });
  await mkRoute(full, { collector: u1 });
  await mkRoute(full, { collector: u2 });
  await mkCust(w, d, { group: full, route: r1 });
  await mkCust(w, d, { group: custOnly });

  const r = await api('GET', `/groups?zone_id=${d.id}`, { token: w.tokens.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.data.map((g) => g.id), [empty.id, full.id, custOnly.id], 'sorted by group name within a district');
  const f = r.data.find((g) => g.id === full.id);
  assert.equal(f.group_zone_count, 3);
  assert.equal(f.route_count, 3);
  assert.equal(f.customer_count, 1);
  assert.equal(f.collector_count, 2);
  assert.deepEqual(f.collectors.map((c) => c.name), ['Axmed Cali', 'Bashiir Nuur']);
  assert.equal(f.is_empty, false);
  const e = r.data.find((g) => g.id === empty.id);
  assert.equal(e.is_empty, true);
  assert.equal(e.group_zone_count, 0);
  assert.deepEqual(e.collectors, []);
  assert.equal(r.data.find((g) => g.id === custOnly.id).is_empty, false, 'a group with customers is not empty');

  // Across districts: ordered by district first, so each district's groups
  // are contiguous (exact collation order is the database's).
  const all = await api('GET', '/groups?limit=200', { token: w.tokens.admin });
  const seen = [];
  for (const gr of all.data) if (seen[seen.length - 1] !== gr.zone_id) seen.push(gr.zone_id);
  assert.equal(seen.length, new Set(seen).size, 'groups of one district are listed together');

  // Zone scoping unchanged: gudoomiye A never sees this district's groups.
  const ga = await api('GET', '/groups?limit=200', { token: w.tokens.gudoomiye });
  assert.equal(ga.status, 200);
  assert.ok(!ga.data.some((g) => g.zone_id === d.id));
});

// ---------- C. Batches list ----------
async function mkBatch(zone, { auto, day, endDay = null, route = null, collectorEmp = null, truck = null }) {
  const cyc = (await db.query(
    `INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date) VALUES ($1,'custom',$2::date - 5,$2::date + 5) RETURNING id`, [zone.id, day])).rows[0].id;
  const b = (await db.query(
    `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, start_date, end_date, status, auto_generated, route_id)
     VALUES ($1,$2,$3,1,$4::date,$5::date,'assigned',$6,$7) RETURNING id`,
    ['OPB' + uniq(), zone.id, cyc, day, endDay || day, auto, route ? route.id : null])).rows[0].id;
  if (collectorEmp || truck) {
    const t = (await db.query(`INSERT INTO tasks (batch_id, status) VALUES ($1,'pending') RETURNING id`, [b])).rows[0].id;
    if (collectorEmp) await db.query(`INSERT INTO task_resources (task_id, resource_type, resource_id) VALUES ($1,'collector',$2)`, [t, collectorEmp]);
    if (truck) await db.query(`INSERT INTO task_resources (task_id, resource_type, resource_id) VALUES ($1,'truck',$2)`, [t, truck.id]);
  }
  return b;
}

test('batches list: source, sub zone, collector, truck, date range; date + source filters', async () => {
  const w = await setupWorld();
  const d = await mkDistrict(w);
  const g = await mkGroup(w, d, 'BatchGroup');
  const uid = await mkUser(d);
  const emp = await mkEmployee(d, uid);
  const truck = await mkTruck(d);
  const route = await mkRoute(g, { collector: uid, truck: truck.id, name: 'Sub Bravo' });
  const day = '2026-03-10';
  const autoId = await mkBatch(d, { auto: true, day, route, collectorEmp: emp, truck });
  const manualId = await mkBatch(d, { auto: false, day: '2026-03-08', endDay: '2026-03-12' });
  const otherDay = await mkBatch(d, { auto: false, day: '2026-03-20' });

  const all = await api('GET', `/batches?zone_id=${d.id}`, { token: w.tokens.admin });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.data.length, 3);
  const a = all.data.find((b) => b.id === autoId);
  assert.equal(a.auto_generated, true);
  assert.equal(a.route_name, 'Sub Bravo');
  assert.equal(a.route_code, route.code);
  assert.equal(a.collector_employee_id, emp);
  assert.equal(a.collector_name, 'OP emp ' + uid);
  assert.equal(a.truck_plate, truck.plate_number);
  assert.equal(a.start_day, day);
  assert.equal(a.end_day, day);
  assert.ok(a.capacity, 'capacity still computed');
  const m = all.data.find((b) => b.id === manualId);
  assert.equal(m.auto_generated, false);
  assert.equal(m.route_name, null);
  assert.equal(m.collector_name, null);
  assert.equal(m.truck_plate, null);
  assert.equal(m.end_day, '2026-03-12');

  const auto = await api('GET', `/batches?zone_id=${d.id}&source=auto`, { token: w.tokens.admin });
  assert.deepEqual(auto.data.map((b) => b.id), [autoId]);
  const manual = await api('GET', `/batches?zone_id=${d.id}&source=manual`, { token: w.tokens.admin });
  assert.deepEqual(manual.data.map((b) => b.id).sort(), [manualId, otherDay].sort());

  // Date: a single day matches every batch whose range covers it.
  const onDay = await api('GET', `/batches?zone_id=${d.id}&date=${day}`, { token: w.tokens.admin });
  assert.deepEqual(onDay.data.map((b) => b.id).sort(), [autoId, manualId].sort());
  const onDayAuto = await api('GET', `/batches?zone_id=${d.id}&date=${day}&source=manual`, { token: w.tokens.admin });
  assert.deepEqual(onDayAuto.data.map((b) => b.id), [manualId]);
  const none = await api('GET', `/batches?zone_id=${d.id}&date=2026-01-01`, { token: w.tokens.admin });
  assert.equal(none.data.length, 0);

  // Status filter still combines.
  const st = await api('GET', `/batches?zone_id=${d.id}&status=assigned&source=auto`, { token: w.tokens.admin });
  assert.deepEqual(st.data.map((b) => b.id), [autoId]);

  assert.equal((await api('GET', '/batches?date=10-03-2026', { token: w.tokens.admin })).status, 400);
  assert.equal((await api('GET', '/batches?source=robot', { token: w.tokens.admin })).status, 400);

  // Scoping unchanged: gudoomiye A never sees this district's batches.
  const ga = await api('GET', `/batches?date=${day}`, { token: w.tokens.gudoomiye });
  assert.equal(ga.status, 200);
  assert.ok(!ga.data.some((b) => b.zone_id === d.id));
});

// ---------- F. Setup checklist ----------
const health = (token) => api('GET', '/dashboard/setup-health', { token });

test('setup-health: RBAC admin + gudoomiye only', async () => {
  const w = await setupWorld();
  for (const k of ['collector', 'cashier', 'head', 'accountant']) assert.equal((await health(w.tokens[k])).status, 403, k);
  assert.equal((await api('GET', '/dashboard/setup-health')).status, 401);
  assert.equal((await health(w.tokens.admin)).status, 200);
  assert.equal((await health(w.tokens.gudoomiye)).status, 200);
  // Gudoomiye without a district: empty, never company-wide.
  const noZone = await health(await gudoomiyeFor(null));
  assert.equal(noZone.status, 200);
  assert.equal(noZone.data.zone_id, null);
  assert.equal(noZone.data.all_set, true);
  assert.deepEqual(noZone.data.blocking, []);
  assert.deepEqual(noZone.data.recommended, []);
  assert.deepEqual(noZone.data.subzones, []);
});

test('setup-health: detects each issue, zone-scoped, and "all set" when nothing is missing', async () => {
  const w = await setupWorld();

  // A clean district: one fully set up Sub Zone with a located customer.
  const clean = await mkDistrict(w);
  const cg = await mkGroup(w, clean, 'Clean');
  const cu = await mkUser(clean);
  await mkEmployee(clean, cu);
  const ct = await mkTruck(clean);
  const cr = await mkRoute(cg, { collector: cu, truck: ct.id });
  await mkCust(w, clean, { group: cg, route: cr });
  // Cashout V2: a cashier on the Sub Zone (otherwise a recommended item).
  const cashierUid = await insertUser('op_k_' + uniq(), 'cashier', clean.name);
  await db.query('UPDATE routes SET cashier_user_id = $1 WHERE id = $2', [cashierUid, cr.id]);
  const gudClean = await gudoomiyeFor(clean);
  const okRes = await health(gudClean);
  assert.equal(okRes.status, 200, JSON.stringify(okRes.body));
  assert.equal(okRes.data.zone_id, clean.id);
  assert.equal(okRes.data.all_set, true, JSON.stringify(okRes.data));
  assert.deepEqual(okRes.data.blocking, []);
  assert.deepEqual(okRes.data.recommended, []);
  assert.deepEqual(okRes.data.subzones, []);

  // Only RECOMMENDED gaps (no truck, no start point, unlocated customer):
  // still "all set" — daily lists can run.
  const soft = await mkDistrict(w);
  const sg = await mkGroup(w, soft, 'Soft');
  const sr = await mkRoute(sg, { collector: cu, start: false });
  await mkCust(w, soft, { group: sg, route: sr, located: false });
  const softRes = await health(await gudoomiyeFor(soft));
  assert.equal(softRes.status, 200);
  assert.equal(softRes.data.all_set, true, JSON.stringify(softRes.data));
  assert.deepEqual(softRes.data.blocking, []);
  assert.deepEqual(softRes.data.recommended, [
    { key: 'no_truck', count: 1 }, { key: 'no_start_point', count: 1 }, { key: 'customers_without_location', count: 1 },
    { key: 'subzones_without_cashier', count: 1 }]);

  // A district with one of each problem.
  const d = await mkDistrict(w);
  const g = await mkGroup(w, d, 'Problems');
  const truck = await mkTruck(d);
  const good = await mkRoute(g, { collector: cu, truck: truck.id }); // cu's employee is fine (residential)
  await mkCust(w, d, { group: g, route: good });
  const noCol = await mkRoute(g, { days: [], truck: truck.id }); // no collector + no work days
  const ghostUser = await mkUser(d);
  const noEmp = await mkRoute(g, { collector: ghostUser, truck: truck.id }); // collector without employee record
  const comUser = await mkUser(d);
  await mkEmployee(d, comUser, { type: 'commercial', shift: 'day' });
  const mismatch = await mkRoute(g, { collector: comUser, truck: truck.id });
  await mkCust(w, d, { group: g, route: mismatch }); // residential customer, commercial collector
  const nightUser = await mkUser(d);
  await mkEmployee(d, nightUser, { type: 'commercial', shift: 'night' });
  const shiftOk = await mkRoute(g, { collector: nightUser, truck: truck.id });
  await mkCust(w, d, { group: g, route: shiftOk, type: 'commercial', shift: 'night' }); // matching shift: fine
  const noTruck = await mkRoute(g, { collector: cu, start: false }); // no truck + no start point
  // An inactive Sub Zone is never reported.
  const inactive = await mkRoute(g, {});
  await db.query(`UPDATE routes SET status = 'inactive' WHERE id = $1`, [inactive.id]);
  await mkCust(w, d); // no Sub Zone (and located)
  await mkCust(w, d, { group: g, route: good, located: false }); // no map location
  await mkCust(w, d, { located: false, status: 'archived' }); // archived: ignored

  const gud = await gudoomiyeFor(d);
  const r = await health(gud);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const data = r.data;
  assert.equal(data.zone_id, d.id);
  assert.equal(data.all_set, false);
  const byId = new Map(data.subzones.map((s) => [s.route_id, s]));
  assert.ok(!byId.has(good.id), 'fully set Sub Zone is not listed');
  assert.ok(!byId.has(shiftOk.id), 'matching commercial shift is not a mismatch');
  assert.ok(!byId.has(inactive.id), 'inactive Sub Zone ignored');
  assert.deepEqual(byId.get(noCol.id).issues, ['no_collector', 'no_work_days']);
  assert.deepEqual(byId.get(noEmp.id).issues, ['collector_no_employee']);
  assert.deepEqual(byId.get(mismatch.id).issues, ['collector_type_mismatch']);
  assert.deepEqual(byId.get(noTruck.id).issues, ['no_truck', 'no_start_point']);
  assert.equal(byId.get(noCol.id).group_id, g.id, 'links to the group page');
  assert.equal(data.counts.no_collector, 1);
  assert.equal(data.counts.collector_no_employee, 1);
  assert.equal(data.counts.collector_type_mismatch, 1);
  assert.equal(data.counts.no_work_days, 1);
  assert.equal(data.counts.no_truck, 1);
  assert.equal(data.counts.no_start_point, 1);
  assert.equal(data.counts.customers_without_subzone, 1);
  assert.equal(data.counts.customers_without_location, 1);
  assert.deepEqual(data.blocking, [
    { key: 'no_collector', count: 1 }, { key: 'collector_no_employee', count: 1 }, { key: 'collector_type_mismatch', count: 1 },
    { key: 'no_work_days', count: 1 }, { key: 'customers_without_subzone', count: 1 }]);
  assert.deepEqual(data.recommended, [
    { key: 'no_truck', count: 1 }, { key: 'no_start_point', count: 1 }, { key: 'customers_without_location', count: 1 },
    { key: 'subzones_without_cashier', count: 6 }]);
  assert.equal(data.counts.subzones_without_cashier, 6);

  // Scoping: the clean district's gudoomiye still sees nothing of this one,
  // gudoomiye A never sees it, admin sees it.
  assert.equal((await health(gudClean)).data.all_set, true);
  const ga = await health(w.tokens.gudoomiye);
  assert.ok(!ga.data.subzones.some((s) => byId.has(s.route_id)));
  const admin = await health(w.tokens.admin);
  assert.equal(admin.data.zone_id, null);
  for (const id of [noCol.id, noEmp.id, mismatch.id, noTruck.id]) assert.ok(admin.data.subzones.some((s) => s.route_id === id), String(id));
  assert.ok(admin.data.counts.customers_without_subzone >= 1);

  // The shared helper keeps /daily-lists/warnings unchanged.
  const warn = await api('GET', '/daily-lists/warnings', { token: gud });
  assert.equal(warn.status, 200, JSON.stringify(warn.body));
  assert.deepEqual(warn.data.subzones_without_days.map((s) => s.id), [noCol.id]);
  assert.equal(warn.data.customers_without_subzone_total, 1);
  assert.equal(warn.data.customers_without_subzone.length, 1);
});
