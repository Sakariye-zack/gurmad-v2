const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, insertUser } = require('./helpers');

let seq = 0;
async function mkRoute(w) {
  const n = ++seq;
  const g = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: w.zoneA.id, code: 'SZG' + n } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const r = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.data.id, code: 'SZR' + n, work_days: ['sat'] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { group: g.data, route: r.data };
}

test('sub zone: assign collector', async () => {
  const w = await setupWorld();
  const { route } = await mkRoute(w);
  const cid = (await db.query(`SELECT id FROM v2_users WHERE username='t_collector'`)).rows[0].id;
  const put = await api('PUT', '/routes/' + route.id, { token: w.tokens.admin, body: { collector_user_id: cid } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const get = await api('GET', '/routes/' + route.id, { token: w.tokens.admin });
  assert.equal(get.data.collector_user_id, cid);
  assert.equal(get.data.collector_name, 't_collector');
  assert.equal(get.data.collector_active, true);
});

test('sub zone: non-collector user rejected', async () => {
  const w = await setupWorld();
  const { route } = await mkRoute(w);
  const adminId = (await db.query(`SELECT id FROM v2_users WHERE username='t_admin'`)).rows[0].id;
  const put = await api('PUT', '/routes/' + route.id, { token: w.tokens.admin, body: { collector_user_id: adminId } });
  assert.equal(put.status, 400, JSON.stringify(put.body));
  const post = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: route.group_id, code: 'SZX' + (++seq), collector_user_id: adminId } });
  assert.equal(post.status, 400, JSON.stringify(post.body));
});

test('sub zone: deactivated collector still listed', async () => {
  const w = await setupWorld();
  const { group, route } = await mkRoute(w);
  const cid = await insertUser('t_collector_off', 'collector', w.zoneA.name);
  const put = await api('PUT', '/routes/' + route.id, { token: w.tokens.admin, body: { collector_user_id: cid } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  await db.query('UPDATE v2_users SET is_active = FALSE WHERE id = $1', [cid]);
  const list = await api('GET', '/routes?group_id=' + group.id, { token: w.tokens.admin });
  assert.equal(list.status, 200);
  const row = list.data.find((r) => r.id === route.id);
  assert.equal(row.collector_user_id, cid);
  assert.equal(row.collector_active, false);
});

test('sub zone: group detail returns collector name', async () => {
  const w = await setupWorld();
  const { group, route } = await mkRoute(w);
  const cid = (await db.query(`SELECT id FROM v2_users WHERE username='t_collector'`)).rows[0].id;
  const put = await api('PUT', '/routes/' + route.id, { token: w.tokens.admin, body: { collector_user_id: cid } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const get = await api('GET', '/groups/' + group.id, { token: w.tokens.admin });
  assert.equal(get.status, 200, JSON.stringify(get.body));
  const row = get.data.routes.find((r) => r.id === route.id);
  assert.equal(row.collector_user_id, cid);
  assert.ok(row.collector_name);
  assert.equal(row.collector_active, true);
});

test('sub zone: collector from another zone rejected', async () => {
  const w = await setupWorld();
  const { route } = await mkRoute(w);
  const cid = await insertUser('t_collector_b', 'collector', w.zoneB.name);
  const put = await api('PUT', '/routes/' + route.id, { token: w.tokens.admin, body: { collector_user_id: cid } });
  assert.equal(put.status, 400, JSON.stringify(put.body));
  const post = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: route.group_id, code: 'SZY' + (++seq), collector_user_id: cid, work_days: ['sat'] } });
  assert.equal(post.status, 400, JSON.stringify(post.body));
});

test('group zone: create under group, code unique per group', async () => {
  const w = await setupWorld();
  const a = await mkRoute(w);
  const b = await mkRoute(w);
  const code = 'ZN' + (++seq);
  const c1 = await api('POST', '/group-zones', { token: w.tokens.admin, body: { group_id: a.group.id, code, name: 'Zone A' } });
  assert.equal(c1.status, 201, JSON.stringify(c1.body));
  const dup = await api('POST', '/group-zones', { token: w.tokens.admin, body: { group_id: a.group.id, code } });
  assert.equal(dup.status, 409, JSON.stringify(dup.body));
  const other = await api('POST', '/group-zones', { token: w.tokens.admin, body: { group_id: b.group.id, code } });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const list = await api('GET', '/group-zones?group_id=' + a.group.id, { token: w.tokens.admin });
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);
});

test('sub zone: group_zone_id from another group rejected', async () => {
  const w = await setupWorld();
  const a = await mkRoute(w);
  const b = await mkRoute(w);
  const zb = await api('POST', '/group-zones', { token: w.tokens.admin, body: { group_id: b.group.id, code: 'ZB' + (++seq) } });
  assert.equal(zb.status, 201, JSON.stringify(zb.body));
  const put = await api('PUT', '/routes/' + a.route.id, { token: w.tokens.admin, body: { group_zone_id: zb.data.id } });
  assert.equal(put.status, 400, JSON.stringify(put.body));
  const post = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: a.group.id, code: 'ZR' + (++seq), group_zone_id: zb.data.id } });
  assert.equal(post.status, 400, JSON.stringify(post.body));
  const za = await api('POST', '/group-zones', { token: w.tokens.admin, body: { group_id: a.group.id, code: 'ZA' + (++seq) } });
  const ok = await api('PUT', '/routes/' + a.route.id, { token: w.tokens.admin, body: { group_zone_id: za.data.id } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const detail = await api('GET', '/group-zones/' + za.data.id, { token: w.tokens.admin });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.routes.length, 1);
});

test('collector: 11th sub zone rejected', async () => {
  const w = await setupWorld();
  const cid = await insertUser('t_collector_cap', 'collector', w.zoneA.name);
  const g = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: w.zoneA.id, code: 'CAPG' + (++seq) } });
  assert.equal(g.status, 201);
  for (let i = 1; i <= 10; i++) {
    const r = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.data.id, code: 'CAP' + i, collector_user_id: cid, work_days: ['sat'] } });
    assert.equal(r.status, 201, 'route ' + i + ' ' + JSON.stringify(r.body));
  }
  const eleventh = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.data.id, code: 'CAP11', collector_user_id: cid, work_days: ['sat'] } });
  assert.equal(eleventh.status, 400, JSON.stringify(eleventh.body));
  assert.match(eleventh.body.error.message, /at most 10/);
  const free = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.data.id, code: 'CAPFREE', work_days: ['sat'] } });
  const put = await api('PUT', '/routes/' + free.data.id, { token: w.tokens.admin, body: { collector_user_id: cid } });
  assert.equal(put.status, 400, JSON.stringify(put.body));
  const first = (await db.query(`SELECT id FROM routes WHERE group_id=$1 AND code='CAP1'`, [g.data.id])).rows[0].id;
  const edit = await api('PUT', '/routes/' + first, { token: w.tokens.admin, body: { collector_user_id: cid, name: 'x' } });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
});

test('customer detail returns group_zone_name', async () => {
  const w = await setupWorld();
  const { group, route } = await mkRoute(w);
  const z = await api('POST', '/group-zones', { token: w.tokens.admin, body: { group_id: group.id, code: 'ZC' + (++seq), name: 'Zone Named' } });
  await api('PUT', '/routes/' + route.id, { token: w.tokens.admin, body: { group_zone_id: z.data.id } });
  const c = await api('POST', '/customers', { token: w.tokens.admin, body: { customer_type: 'residential', name: 'GZ Cust ' + seq, phone: '0640' + String(seq).padStart(6, '0'), zone_id: w.zoneA.id, door_number: String(80000 + seq), group_id: group.id, route_id: route.id } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const get = await api('GET', '/customers/' + c.data.id, { token: w.tokens.admin });
  assert.equal(get.data.group_zone_name, 'Zone Named');
});

test('collector at cap: editing other fields with same collector still OK', async () => {
  const w = await setupWorld();
  const cid = await insertUser('t_collector_cap2', 'collector', w.zoneA.name);
  const g = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: w.zoneA.id, code: 'CAPH' + (++seq) } });
  const ids = [];
  for (let i = 1; i <= 10; i++) {
    const r = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.data.id, code: 'CH' + i, collector_user_id: cid, work_days: ['sat'] } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids.push(r.data.id);
  }
  const put = await api('PUT', '/routes/' + ids[0], { token: w.tokens.admin, body: { name: 'Renamed', collector_user_id: cid } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
});

test('sub zone: inactive zone cannot be assigned', async () => {
  const w = await setupWorld();
  const { group, route } = await mkRoute(w);
  const z = await api('POST', '/group-zones', { token: w.tokens.admin, body: { group_id: group.id, code: 'ZI' + (++seq), status: 'inactive' } });
  assert.equal(z.status, 201, JSON.stringify(z.body));
  const put = await api('PUT', '/routes/' + route.id, { token: w.tokens.admin, body: { group_zone_id: z.data.id } });
  assert.equal(put.status, 400, JSON.stringify(put.body));
  const post = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: group.id, code: 'ZIR' + (++seq), group_zone_id: z.data.id } });
  assert.equal(post.status, 400, JSON.stringify(post.body));
});
