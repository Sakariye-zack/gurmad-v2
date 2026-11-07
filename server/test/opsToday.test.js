const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, insertUser } = require('./helpers');

// F7 dashboard operations panel: GET /dashboard/operations-today — RBAC,
// response shape, zone scoping of today's lists and active collectors.
let seq = 0;
const uniq = () => `${Date.now().toString().slice(-6)}${++seq}`;
const ops = (token) => api('GET', '/dashboard/operations-today', { token });

async function mkCollector(zone) {
  const username = 'ot_col_' + uniq();
  const uid = await insertUser(username, 'collector', zone.name);
  return (await db.query(
    `INSERT INTO employees (name, employee_type, collector_type, phone, zone_id, user_id) VALUES ($1,'collector','residential',$2,$3,$4) RETURNING id`,
    ['OT ' + username, '0655' + String(uid).padStart(6, '0'), zone.id, uid])).rows[0].id;
}

// An auto-generated list for `day` in `zone`, assigned to `emp`, with the
// given visit statuses.
async function mkAutoList(w, zone, emp, day, statuses) {
  const cyc = (await db.query(
    `INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date) VALUES ($1,'custom',$2::date - 5,$2::date + 5) RETURNING id`,
    [zone.id, day])).rows[0].id;
  const batch = (await db.query(
    `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, start_date, end_date, status, auto_generated)
     VALUES ($1,$2,$3,1,$4::date,$4::date,'assigned',TRUE) RETURNING id`,
    ['OTB' + uniq(), zone.id, cyc, day])).rows[0].id;
  const task = (await db.query(`INSERT INTO tasks (batch_id, status) VALUES ($1,'pending') RETURNING id`, [batch])).rows[0].id;
  await db.query(`INSERT INTO task_resources (task_id, resource_type, resource_id) VALUES ($1,'collector',$2)`, [task, emp]);
  for (const s of statuses) {
    const n = uniq();
    const c = await api('POST', '/customers', { token: w.tokens.admin, body: {
      customer_type: 'residential', name: 'OTCust ' + n, phone: '0656' + n.slice(-6).padStart(6, '0'), zone_id: zone.id, door_number: '7' + n, fee: 5 } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    await db.query(
      `INSERT INTO batch_customers (batch_id, customer_id, status, status_at) VALUES ($1,$2,$3,${s === 'pending' ? 'NULL' : "NOW() AT TIME ZONE 'UTC'"})`,
      [batch, c.data.id, s]);
  }
  return batch;
}

test('operations-today: RBAC', async () => {
  const w = await setupWorld();
  for (const k of ['collector', 'cashier', 'head', 'accountant']) {
    assert.equal((await ops(w.tokens[k])).status, 403, k);
  }
  assert.equal((await api('GET', '/dashboard/operations-today')).status, 401);
});

test('operations-today: shape for admin and gudoomiye', async () => {
  const w = await setupWorld();
  const a = await ops(w.tokens.admin);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const d = a.data;
  assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
  for (const k of ['lists', 'total', 'serviced', 'missed', 'pending']) assert.equal(typeof d.lists[k], 'number', k);
  assert.equal(typeof d.collectors_active, 'number');
  assert.equal(typeof d.trucks_live, 'number');
  // The debt-suspension module is not on this branch: null, never a guess.
  assert.ok(d.debt_candidates === null || typeof d.debt_candidates === 'number');
  assert.equal(typeof d.backup, 'object');
  assert.ok(d.backup !== null, 'admin gets backup status');
  for (const k of ['ok', 'overdue', 'failed']) assert.equal(typeof d.backup[k], 'boolean', k);
  for (const k of ['documents', 'maintenance_due', 'total']) assert.equal(typeof d.fleet_alerts[k], 'number', k);

  const g = await ops(w.tokens.gudoomiye);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.data.backup, null, 'backups are admin-only');
  assert.equal(g.data.zone_id, w.zoneA.id);
});

test('operations-today: today\'s lists and active collectors are zone-scoped', async () => {
  const w = await setupWorld();
  const day = (await ops(w.tokens.admin)).data.date;
  const before = { admin: (await ops(w.tokens.admin)).data, gud: (await ops(w.tokens.gudoomiye)).data };

  const empA = await mkCollector(w.zoneA);
  const empB = await mkCollector(w.zoneB);
  await mkAutoList(w, w.zoneA, empA, day, ['serviced', 'missed', 'pending']);
  await mkAutoList(w, w.zoneB, empB, day, ['serviced', 'pending']);
  // A cancelled list and yesterday's list never count.
  const cancelled = await mkAutoList(w, w.zoneA, empA, day, ['pending']);
  await db.query(`UPDATE batches SET status = 'cancelled' WHERE id = $1`, [cancelled]);
  const yesterday = new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  await mkAutoList(w, w.zoneA, empA, yesterday, ['pending']);
  // Fresh position for both collectors (collector_locations is a naive local timestamp).
  for (const e of [empA, empB]) {
    await db.query(
      `INSERT INTO collector_locations (employee_id, lat, lng, recorded_at) VALUES ($1, 9.56, 44.06, LOCALTIMESTAMP)
       ON CONFLICT (employee_id) DO UPDATE SET recorded_at = LOCALTIMESTAMP`, [e]);
  }

  const admin = (await ops(w.tokens.admin)).data;
  assert.equal(admin.lists.lists - before.admin.lists.lists, 2);
  assert.equal(admin.lists.total - before.admin.lists.total, 5);
  assert.equal(admin.lists.serviced - before.admin.lists.serviced, 2);
  assert.equal(admin.lists.missed - before.admin.lists.missed, 1);
  assert.equal(admin.lists.pending - before.admin.lists.pending, 2);
  assert.ok(admin.collectors_active - before.admin.collectors_active >= 2);

  const gud = (await ops(w.tokens.gudoomiye)).data;
  assert.equal(gud.lists.lists - before.gud.lists.lists, 1);
  assert.equal(gud.lists.total - before.gud.lists.total, 3);
  assert.equal(gud.lists.serviced - before.gud.lists.serviced, 1);
  assert.equal(gud.lists.missed - before.gud.lists.missed, 1);
  assert.equal(gud.collectors_active - before.gud.collectors_active, 1, 'zone B collector not counted for gudoomiye A');
});
