const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, insertUser, tokenFor } = require('./helpers');

// Calendar event enrichment (Sub Zone / collector / truck / progress / auto
// flag / day strings + Source filter) and Collection Cycles cleanup
// (bulk close of ended manual cycles + span validation on create). Every
// test builds its own fresh district so results are exact.
let seq = 0;
const uniq = () => `${Date.now().toString().slice(-6)}${++seq}`;

async function mkDistrict(w) {
  const n = uniq();
  const r = await api('POST', '/zones', { token: w.tokens.admin, body: { name: 'Cal District ' + n, zone_code: 'CAL' + n } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}
async function gudoomiyeFor(zone) {
  const username = 'cal_gud_' + uniq();
  await insertUser(username, 'gudoomiye', zone ? zone.name : null);
  return tokenFor(username);
}
async function companyToday() {
  let tz = 'Africa/Mogadishu';
  try {
    const r = await db.query(`SELECT timezone FROM company_settings WHERE timezone IS NOT NULL AND timezone <> '' ORDER BY id LIMIT 1`);
    if (r.rows[0]) tz = r.rows[0].timezone;
  } catch (_) { /* default */ }
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function shift(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- D. Calendar ----------
async function mkCust(w, zone) {
  const n = uniq();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: {
    customer_type: 'residential', name: 'CalCust ' + n, phone: '0673' + n.slice(-6).padStart(6, '0'), zone_id: zone.id, door_number: '7' + n, fee: 5 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}

test('calendar events: sub zone, collector, truck, progress, auto flag, day strings + source filter', async () => {
  const w = await setupWorld();
  const d = await mkDistrict(w);
  const grp = (await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: d.id, code: 'CG' + uniq(), name: 'Cal Group' } })).data;
  const route = (await db.query(`INSERT INTO routes (group_id, code, name) VALUES ($1,$2,'Sub Calendar') RETURNING *`, [grp.id, 'CR' + uniq()])).rows[0];
  const emp = (await db.query(
    `INSERT INTO employees (name, employee_type, collector_type, phone, zone_id) VALUES ('Cal Collector','collector','residential',$1,$2) RETURNING id`,
    ['0674' + uniq().slice(-6).padStart(6, '0'), d.id])).rows[0].id;
  const truck = (await db.query(`INSERT INTO trucks (plate_number, zone_id) VALUES ($1,$2) RETURNING id, plate_number`, ['CAL-' + uniq(), d.id])).rows[0];
  const cyc = (await db.query(`INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date) VALUES ($1,'custom','2026-04-01','2026-04-30') RETURNING id`, [d.id])).rows[0].id;
  const autoId = (await db.query(
    `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, start_date, end_date, status, auto_generated, route_id)
     VALUES ($1,$2,$3,1,'2026-04-14','2026-04-14','in_progress',TRUE,$4) RETURNING id`, ['CAB' + uniq(), d.id, cyc, route.id])).rows[0].id;
  const manualId = (await db.query(
    `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, start_date, end_date, status)
     VALUES ($1,$2,$3,2,'2026-04-12','2026-04-18','assigned') RETURNING id`, ['CMB' + uniq(), d.id, cyc])).rows[0].id;
  const task = (await db.query(`INSERT INTO tasks (batch_id, status) VALUES ($1,'pending') RETURNING id`, [autoId])).rows[0].id;
  await db.query(`INSERT INTO task_resources (task_id, resource_type, resource_id) VALUES ($1,'collector',$2), ($1,'truck',$3)`, [task, emp, truck.id]);
  const c1 = await mkCust(w, d);
  const c2 = await mkCust(w, d);
  const c3 = await mkCust(w, d);
  await db.query(`INSERT INTO batch_customers (batch_id, customer_id, status) VALUES ($1,$2,'serviced'), ($1,$3,'pending'), ($1,$4,'missed')`, [autoId, c1.id, c2.id, c3.id]);

  const r = await api('GET', `/calendar/batches?from=2026-04-13&to=2026-04-19&zone_id=${d.id}`, { token: w.tokens.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.data.length, 2);
  const a = r.data.find((e) => e.id === autoId);
  assert.equal(a.auto_generated, true);
  assert.equal(a.route_id, route.id);
  assert.equal(a.route_name, 'Sub Calendar');
  assert.equal(a.route_code, route.code);
  assert.equal(a.collector_name, 'Cal Collector');
  assert.equal(a.truck_plate, truck.plate_number);
  assert.equal(a.serviced_count, 1);
  assert.equal(a.customer_count, 3);
  assert.equal(a.start_day, '2026-04-14');
  assert.equal(a.end_day, '2026-04-14');
  // Existing fields kept.
  for (const k of ['batch_code', 'start_date', 'end_date', 'status', 'zone_id', 'zone_name', 'customer_type', 'commercial_shift', 'total_customers']) assert.ok(k in a, k);
  const m = r.data.find((e) => e.id === manualId);
  assert.equal(m.auto_generated, false);
  assert.equal(m.route_name, null);
  assert.equal(m.collector_name, null);
  assert.equal(m.truck_plate, null);
  assert.equal(m.serviced_count, 0);
  assert.equal(m.customer_count, 0);
  assert.equal(m.start_day, '2026-04-12');
  assert.equal(m.end_day, '2026-04-18');

  const onlyAuto = await api('GET', `/calendar/batches?from=2026-04-13&to=2026-04-19&zone_id=${d.id}&source=auto`, { token: w.tokens.admin });
  assert.deepEqual(onlyAuto.data.map((e) => e.id), [autoId]);
  const onlyManual = await api('GET', `/calendar/batches?from=2026-04-13&to=2026-04-19&zone_id=${d.id}&source=manual`, { token: w.tokens.admin });
  assert.deepEqual(onlyManual.data.map((e) => e.id), [manualId]);
  const all = await api('GET', `/calendar/batches?from=2026-04-13&to=2026-04-19&zone_id=${d.id}&source=all`, { token: w.tokens.admin });
  assert.equal(all.data.length, 2);
  const bad = await api('GET', `/calendar/batches?from=2026-04-13&to=2026-04-19&source=robot`, { token: w.tokens.admin });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION');

  // Zone scoping unchanged: another district's gudoomiye never sees these, even when asking.
  const gA = await api('GET', `/calendar/batches?from=2026-04-13&to=2026-04-19&zone_id=${d.id}`, { token: w.tokens.gudoomiye });
  assert.equal(gA.status, 200);
  assert.ok(!gA.data.some((e) => e.zone_id === d.id));
  const gD = await api('GET', `/calendar/batches?from=2026-04-13&to=2026-04-19&source=auto`, { token: await gudoomiyeFor(d) });
  assert.deepEqual(gD.data.map((e) => e.id), [autoId]);
  // Role gate unchanged.
  const col = await api('GET', `/calendar/batches?from=2026-04-13&to=2026-04-19`, { token: w.tokens.collector });
  assert.equal(col.status, 403);
});

// ---------- E1. Close ended cycles ----------
async function mkCycle(zone, { start, end, auto = false, active = true, type = 'custom' }) {
  return (await db.query(
    `INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date, auto, is_active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [zone.id, type, start, end, auto, active])).rows[0].id;
}
async function isActive(id) {
  return (await db.query('SELECT is_active FROM collection_cycles WHERE id = $1', [id])).rows[0].is_active;
}

test('close-ended: closes only ended, active, manual cycles; zone-scoped; audited like a single close', async () => {
  const w = await setupWorld();
  const today = await companyToday();
  const d = await mkDistrict(w);
  const d2 = await mkDistrict(w);
  const ended = await mkCycle(d, { start: '2020-01-01', end: '2020-01-31', type: 'monthly' });
  const endedYesterday = await mkCycle(d, { start: shift(today, -5), end: shift(today, -1) });
  const endsToday = await mkCycle(d, { start: shift(today, -3), end: today });
  const future = await mkCycle(d, { start: today, end: shift(today, 10) });
  const autoEnded = await mkCycle(d, { start: '2020-02-01', end: '2020-02-29', auto: true, type: 'monthly' });
  const autoCurrent = await mkCycle(d, { start: today.slice(0, 8) + '01', end: shift(today, 20), auto: true, type: 'monthly' });
  const alreadyClosed = await mkCycle(d, { start: '2020-03-01', end: '2020-03-31', active: false });
  const otherZone = await mkCycle(d2, { start: '2020-01-01', end: '2020-01-07', type: 'weekly' });

  // RBAC: only admin + gudoomiye (WRITE_ROLES).
  for (const k of ['accountant', 'collector', 'cashier', 'head']) {
    const r = await api('PUT', '/cycles/close-ended', { token: w.tokens[k] });
    assert.equal(r.status, 403, k);
  }
  assert.equal((await api('PUT', '/cycles/close-ended', {})).status, 401);

  // Gudoomiye of D: only D's ended manual active cycles.
  const gD = await gudoomiyeFor(d);
  const r = await api('PUT', '/cycles/close-ended', { token: gD });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.data.closed, 2);
  assert.deepEqual(r.data.ids.sort((x, y) => x - y), [ended, endedYesterday].sort((x, y) => x - y));
  assert.deepEqual(r.data.skipped, []);
  assert.equal(r.data.today, today);
  assert.equal(await isActive(ended), false);
  assert.equal(await isActive(endedYesterday), false);
  assert.equal(await isActive(endsToday), true, 'ends today -> untouched');
  assert.equal(await isActive(future), true);
  assert.equal(await isActive(autoEnded), true, 'auto cycles are never closed');
  assert.equal(await isActive(autoCurrent), true);
  assert.equal(await isActive(otherZone), true, 'other zone untouched by a scoped gudoomiye');

  // Audit: exactly one cycle.close per closed cycle, same shape as the single close.
  const aud = await db.query(`SELECT actor_username, entity_type, before_data, after_data FROM v2_audit_log WHERE action = 'cycle.close' AND entity_id = $1`, [ended]);
  assert.equal(aud.rows.length, 1);
  assert.equal(aud.rows[0].entity_type, 'collection_cycle');
  assert.match(aud.rows[0].actor_username, /^cal_gud_/);
  assert.equal(aud.rows[0].before_data.is_active, true);
  assert.equal(aud.rows[0].after_data.is_active, false);
  const noAud = await db.query(`SELECT COUNT(*)::int AS n FROM v2_audit_log WHERE action = 'cycle.close' AND entity_id = ANY($1::int[])`, [[endsToday, future, autoEnded, autoCurrent, alreadyClosed, otherZone]]);
  assert.equal(noAud.rows[0].n, 0);

  // Idempotent: a second run closes nothing more in D.
  const again = await api('POST', '/cycles/close-ended', { token: gD });
  assert.equal(again.status, 200);
  assert.equal(again.data.closed, 0);

  // A gudoomiye with no resolvable zone closes nothing.
  const gNone = await gudoomiyeFor(null);
  const none = await api('PUT', '/cycles/close-ended', { token: gNone });
  assert.equal(none.status, 200);
  assert.equal(none.data.closed, 0);
  assert.equal(await isActive(otherZone), true);

  // Admin: all zones (POST alias), still never auto/current.
  const adm = await api('POST', '/cycles/close-ended', { token: w.tokens.admin });
  assert.equal(adm.status, 200);
  assert.ok(adm.data.ids.includes(otherZone));
  assert.equal(await isActive(otherZone), false);
  assert.equal(await isActive(autoEnded), true);
  assert.equal(await isActive(endsToday), true);
  const audAdmin = await db.query(`SELECT actor_username FROM v2_audit_log WHERE action = 'cycle.close' AND entity_id = $1`, [otherZone]);
  assert.deepEqual(audAdmin.rows.map((x) => x.actor_username), ['t_admin']);
});

// ---------- E2. Create validation ----------
test('create cycle: span rules for weekly/monthly, end >= start, custom unchanged', async () => {
  const w = await setupWorld();
  const d = await mkDistrict(w);
  const post = (body, token = w.tokens.admin) => api('POST', '/cycles', { token, body: { zone_id: d.id, ...body } });

  const ok = [
    { cycle_type: 'weekly', start_date: '2027-01-04', end_date: '2027-01-10' },
    { cycle_type: 'monthly', start_date: '2027-02-01', end_date: '2027-02-28' },
    { cycle_type: 'monthly', start_date: '2027-03-01', end_date: '2027-03-31' },
    { cycle_type: 'monthly', start_date: '2027-04-15', end_date: '2027-05-14' },
    { cycle_type: 'custom', start_date: '2027-06-01', end_date: '2027-06-01' },
    { cycle_type: 'custom', start_date: '2027-06-01', end_date: '2027-09-30' },
  ];
  for (const b of ok) {
    const r = await post(b);
    assert.equal(r.status, 201, `${JSON.stringify(b)} -> ${JSON.stringify(r.body)}`);
  }

  const bad = [
    [{ cycle_type: 'weekly', start_date: '2027-01-04', end_date: '2027-01-11' }, /exactly 7 days/],
    [{ cycle_type: 'weekly', start_date: '2027-01-04', end_date: '2027-01-04' }, /exactly 7 days/],
    [{ cycle_type: 'monthly', start_date: '2027-10-19', end_date: '2027-10-19' }, /28 to 31 days/],
    [{ cycle_type: 'monthly', start_date: '2027-01-01', end_date: '2027-02-01' }, /28 to 31 days/],
    [{ cycle_type: 'monthly', start_date: '2027-02-01', end_date: '2027-02-27' }, /28 to 31 days/],
    [{ cycle_type: 'custom', start_date: '2027-06-02', end_date: '2027-06-01' }, /on or after/],
    [{ cycle_type: 'weekly', start_date: '2027-02-30', end_date: '2027-03-05' }, /real calendar dates/],
  ];
  for (const [b, re] of bad) {
    const r = await post(b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(r.body.error.code, 'VALIDATION');
    assert.match(r.body.error.message, re);
  }
  const n = await db.query('SELECT COUNT(*)::int AS n FROM collection_cycles WHERE zone_id = $1', [d.id]);
  assert.equal(n.rows[0].n, ok.length, 'invalid cycles were not inserted');

  // Scoped gudoomiye goes through the same rule.
  const g = await post({ cycle_type: 'weekly', start_date: '2027-01-04', end_date: '2027-01-12' }, await gudoomiyeFor(d));
  assert.equal(g.status, 400);
});
