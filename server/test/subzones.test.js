const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, insertUser } = require('./helpers');

let seq = 0;
async function mkRoute(w) {
  const n = ++seq;
  const g = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: w.zoneA.id, code: 'SZG' + n } });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const r = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.data.id, code: 'SZR' + n } });
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
