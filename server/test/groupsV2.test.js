// Groups V2: richer Group / Zone / Sub Zone master data — new group fields
// (leader, description, map center, defaults, notes), Sub Zone work-day
// inheritance, Zone/Sub Zone description+notes, detail counts, summary,
// RBAC/zone scoping and audit entries.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, insertUser } = require('./helpers');

let seq = 0;
const uniq = (p) => `${p}${Date.now().toString(36).slice(-4)}${++seq}`;
const userId = async (username) => (await db.query('SELECT id FROM v2_users WHERE username = $1', [username])).rows[0].id;
async function mkGroup(w, body = {}, token) {
  const r = await api('POST', '/groups', { token: token || w.tokens.admin, body: { zone_id: w.zoneA.id, code: uniq('GV'), ...body } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}
async function lastAudit(entityType, entityId) {
  const r = await db.query('SELECT * FROM v2_audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY id DESC LIMIT 1', [entityType, entityId]);
  return r.rows[0];
}

test('groups v2: create with every new field, stored and audited', async () => {
  const w = await setupWorld();
  const headId = await userId('t_head');
  const g = await mkGroup(w, {
    name: 'Baarsiigo', leader_user_id: headId, description: '  Near the market  ', center_lat: 9.52, center_lng: 45.53,
    default_work_days: ['wed', 'sat'], default_billing_type: 'monthly', default_fee_currency: 'SLSH', default_fee: 30000, notes: 'Gate closes at 6',
  });
  assert.equal(g.leader_user_id, headId);
  assert.equal(g.description, 'Near the market');
  assert.equal(Number(g.center_lat), 9.52);
  assert.equal(Number(g.center_lng), 45.53);
  assert.deepEqual(g.default_work_days, ['sat', 'wed']); // normalised to week order
  assert.equal(g.default_billing_type, 'monthly');
  assert.equal(g.default_fee_currency, 'SLSH');
  assert.equal(Number(g.default_fee), 30000);
  assert.equal(g.notes, 'Gate closes at 6');
  const a = await lastAudit('group', g.id);
  assert.equal(a.action, 'group.create');
  assert.equal(a.after_data.leader_user_id, headId);

  const detail = await api('GET', '/groups/' + g.id, { token: w.tokens.admin });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.leader_name, 't_head');
  assert.equal(detail.data.leader_active, true);
});

test('groups v2: existing minimal create still works (all new fields optional)', async () => {
  const w = await setupWorld();
  const g = await mkGroup(w);
  for (const f of ['leader_user_id', 'description', 'center_lat', 'center_lng', 'default_work_days', 'default_billing_type', 'default_fee_currency', 'default_fee', 'notes']) {
    assert.equal(g[f], null, f);
  }
});

test('groups v2: field validation', async () => {
  const w = await setupWorld();
  const bad = [
    { default_billing_type: 'weekly' },
    { default_fee_currency: 'EUR' },
    { default_fee: -1 },
    { default_fee: '5' },
    { default_work_days: ['monday'] },
    { default_work_days: 'sat' },
    { center_lat: 9.5 },
    { center_lat: 9.5, center_lng: null },
    { center_lat: 91, center_lng: 45 },
    { center_lat: '9.5', center_lng: '45.5' },
    { description: 'x'.repeat(1001) },
    { notes: 'x'.repeat(1001) },
    { notes: 12 },
    { leader_user_id: 'abc' },
  ];
  for (const body of bad) {
    const r = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: w.zoneA.id, code: uniq('GB'), ...body } });
    assert.equal(r.status, 400, `create ${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'VALIDATION');
  }
  const g = await mkGroup(w);
  for (const body of bad) {
    const r = await api('PUT', '/groups/' + g.id, { token: w.tokens.admin, body });
    assert.equal(r.status, 400, `update ${JSON.stringify(body)} -> ${r.status}`);
  }
  // Boundary values are accepted; blanks clear.
  const ok = await api('PUT', '/groups/' + g.id, { token: w.tokens.admin, body: { description: 'x'.repeat(1000), default_fee: 0, center_lat: -90, center_lng: 180, default_work_days: [] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(Number(ok.data.default_fee), 0);
  assert.equal(ok.data.default_work_days, null);
  const clear = await api('PUT', '/groups/' + g.id, { token: w.tokens.admin, body: { center_lat: null, center_lng: null, default_fee: null, description: '' } });
  assert.equal(clear.status, 200);
  assert.equal(clear.data.center_lat, null);
  assert.equal(clear.data.default_fee, null);
  assert.equal(clear.data.description, null);
});

test('groups v2: leader must be an eligible active staff user of the district', async () => {
  const w = await setupWorld();
  const g = await mkGroup(w);
  const collectorId = await userId('t_collector');
  const cashierB = await userId('t_cashier_b');
  const offId = await insertUser(uniq('t_lead_off'), 'zone_accountant', w.zoneA.name);
  await db.query('UPDATE v2_users SET is_active = FALSE WHERE id = $1', [offId]);
  for (const [label, id] of [['collector', collectorId], ['other district', cashierB], ['inactive', offId], ['missing', 99999999]]) {
    const r = await api('PUT', '/groups/' + g.id, { token: w.tokens.admin, body: { leader_user_id: id } });
    assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.body)}`);
  }
  const create = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: w.zoneA.id, code: uniq('GL'), leader_user_id: collectorId } });
  assert.equal(create.status, 400);
  // Eligible: district staff and a company-wide admin.
  for (const u of ['t_gudoomiye', 't_accountant', 't_head', 't_cashier', 't_admin']) {
    const r = await api('PUT', '/groups/' + g.id, { token: w.tokens.admin, body: { leader_user_id: await userId(u) } });
    assert.equal(r.status, 200, `${u}: ${JSON.stringify(r.body)}`);
  }
  // A leader deactivated later does not block unrelated edits.
  const leadId = await insertUser(uniq('t_lead'), 'gudoomiye', w.zoneA.name);
  assert.equal((await api('PUT', '/groups/' + g.id, { token: w.tokens.admin, body: { leader_user_id: leadId } })).status, 200);
  await db.query('UPDATE v2_users SET is_active = FALSE WHERE id = $1', [leadId]);
  const same = await api('PUT', '/groups/' + g.id, { token: w.tokens.admin, body: { leader_user_id: leadId, notes: 'still fine' } });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  const cleared = await api('PUT', '/groups/' + g.id, { token: w.tokens.admin, body: { leader_user_id: null } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.leader_user_id, null);
});

test('groups v2: update is audited with before/after', async () => {
  const w = await setupWorld();
  const g = await mkGroup(w);
  const r = await api('PUT', '/groups/' + g.id, { token: w.tokens.admin, body: { default_billing_type: 'daily', default_fee: 2.5, default_fee_currency: 'USD' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = await lastAudit('group', g.id);
  assert.equal(a.action, 'group.update');
  assert.equal(a.before_data.default_billing_type, null);
  assert.equal(a.after_data.default_billing_type, 'daily');
  assert.equal(Number(a.after_data.default_fee), 2.5);
  const s = await api('PUT', '/groups/' + g.id, { token: w.tokens.admin, body: { status: 'inactive' } });
  assert.equal(s.status, 200);
  assert.equal((await lastAudit('group', g.id)).action, 'group.status_change');
});

test('groups v2: new Sub Zone inherits default work days only when work_days is omitted', async () => {
  const w = await setupWorld();
  const g = await mkGroup(w, { default_work_days: ['mon', 'wed'] });
  const inherit = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.id, code: uniq('R') } });
  assert.equal(inherit.status, 201, JSON.stringify(inherit.body));
  assert.deepEqual(inherit.data.work_days, ['mon', 'wed']);
  const explicit = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.id, code: uniq('R'), work_days: ['fri'] } });
  assert.equal(explicit.status, 201);
  assert.deepEqual(explicit.data.work_days, ['fri']);
  const empty = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.id, code: uniq('R'), work_days: [] } });
  assert.equal(empty.status, 201);
  assert.equal(empty.data.work_days, null);
  // A collector with no work_days in the request is fine when the group supplies them.
  const collectorId = await insertUser(uniq('t_coll_inh'), 'collector', w.zoneA.name);
  const withCollector = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.id, code: uniq('R'), collector_user_id: collectorId } });
  assert.equal(withCollector.status, 201, JSON.stringify(withCollector.body));
  assert.deepEqual(withCollector.data.work_days, ['mon', 'wed']);
  // Without group defaults the existing rule still applies.
  const plain = await mkGroup(w);
  const noDays = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: plain.id, code: uniq('R'), collector_user_id: collectorId } });
  assert.equal(noDays.status, 400, JSON.stringify(noDays.body));
  const none = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: plain.id, code: uniq('R') } });
  assert.equal(none.status, 201);
  assert.equal(none.data.work_days, null);
  // Updating an existing Sub Zone never inherits.
  const upd = await api('PUT', '/routes/' + none.data.id, { token: w.tokens.admin, body: { name: 'renamed' } });
  assert.equal(upd.status, 200);
  assert.equal(upd.data.work_days, null);
});

test('groups v2: Zone and Sub Zone description + notes', async () => {
  const w = await setupWorld();
  const g = await mkGroup(w);
  const z = await api('POST', '/group-zones', { token: w.tokens.admin, body: { group_id: g.id, code: uniq('Z'), description: 'North side', notes: 'Narrow lanes' } });
  assert.equal(z.status, 201, JSON.stringify(z.body));
  assert.equal(z.data.description, 'North side');
  assert.equal(z.data.notes, 'Narrow lanes');
  const zu = await api('PUT', '/group-zones/' + z.data.id, { token: w.tokens.admin, body: { notes: null, description: ' Updated ' } });
  assert.equal(zu.status, 200);
  assert.equal(zu.data.notes, null);
  assert.equal(zu.data.description, 'Updated');
  assert.equal((await lastAudit('group_zone', z.data.id)).action, 'group_zone.update');
  assert.equal((await api('PUT', '/group-zones/' + z.data.id, { token: w.tokens.admin, body: { description: 'x'.repeat(1001) } })).status, 400);
  assert.equal((await api('POST', '/group-zones', { token: w.tokens.admin, body: { group_id: g.id, code: uniq('Z'), notes: 'x'.repeat(1001) } })).status, 400);

  const r = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.id, code: uniq('R'), description: 'Behind the mosque', notes: 'Dogs' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.data.description, 'Behind the mosque');
  assert.equal(r.data.notes, 'Dogs');
  const ru = await api('PUT', '/routes/' + r.data.id, { token: w.tokens.admin, body: { notes: 'No dogs now' } });
  assert.equal(ru.status, 200);
  assert.equal(ru.data.notes, 'No dogs now');
  assert.equal(ru.data.description, 'Behind the mosque');
  assert.equal((await lastAudit('route', r.data.id)).action, 'route.update');
  assert.equal((await api('PUT', '/routes/' + r.data.id, { token: w.tokens.admin, body: { notes: 'x'.repeat(1001) } })).status, 400);
  const detail = await api('GET', '/groups/' + g.id, { token: w.tokens.admin });
  assert.equal(detail.data.routes.find((x) => x.id === r.data.id).notes, 'No dogs now');
  assert.equal(detail.data.zones.find((x) => x.id === z.data.id).description, 'Updated');
});

test('groups v2: detail endpoint counts', async () => {
  const w = await setupWorld();
  const g = await mkGroup(w);
  const z = await api('POST', '/group-zones', { token: w.tokens.admin, body: { group_id: g.id, code: uniq('Z') } });
  const collectorId = await insertUser(uniq('t_coll_cnt'), 'collector', w.zoneA.name);
  const cashierId = await userId('t_cashier');
  const r1 = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.id, code: uniq('R'), group_zone_id: z.data.id, collector_user_id: collectorId, cashier_user_id: cashierId, work_days: ['sat'] } });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  const r2 = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.id, code: uniq('R') } });
  const r3 = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.id, code: uniq('R'), status: 'inactive' } });
  assert.equal(r3.status, 201);
  const mkCust = async (routeId, n) => {
    const door = String(700000 + Math.floor(Math.random() * 299999));
    const c = await api('POST', '/customers', { token: w.tokens.admin, body: { customer_type: 'residential', name: uniq('GVC') + n, phone: '063' + door, zone_id: w.zoneA.id, group_id: g.id, route_id: routeId, door_number: door } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    return c.data;
  };
  await mkCust(r1.data.id, 1);
  await mkCust(r1.data.id, 2);
  await mkCust(r2.data.id, 3);
  await mkCust(r3.data.id, 4);
  await mkCust(null, 5);
  const d = await api('GET', '/groups/' + g.id, { token: w.tokens.admin });
  assert.equal(d.status, 200);
  assert.deepEqual(d.data.counts, {
    customers: 5, zones: 1, sub_zones: 3, active_sub_zones: 2, collectors: 1, cashiers: 1,
    customers_without_subzone: 1, customers_in_active_subzones: 3,
  });
  assert.equal(d.data.zones[0].customer_count, 2);
  // Legacy fields unchanged.
  assert.equal(d.data.customer_count, 5);
  assert.equal(d.data.route_count, 3);
});

test('groups v2: list leader filter/name and summary counts', async () => {
  const w = await setupWorld();
  const leadId = await insertUser(uniq('t_lead_f'), 'zone_accountant', w.zoneA.name);
  const g1 = await mkGroup(w, { leader_user_id: leadId });
  const g2 = await mkGroup(w);
  await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g1.id, code: uniq('R') } });
  const byLeader = await api('GET', '/groups?leader_user_id=' + leadId, { token: w.tokens.admin });
  assert.equal(byLeader.status, 200);
  assert.deepEqual(byLeader.data.map((x) => x.id), [g1.id]);
  assert.ok(byLeader.data[0].leader_name);
  const none = await api('GET', '/groups?leader_user_id=none&limit=200', { token: w.tokens.admin });
  assert.ok(none.data.some((x) => x.id === g2.id));
  assert.ok(!none.data.some((x) => x.id === g1.id));
  assert.equal((await api('GET', '/groups?leader_user_id=x', { token: w.tokens.admin })).status, 400);

  const s = await api('GET', '/groups/summary?leader_user_id=' + leadId, { token: w.tokens.admin });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.data.groups, 1);
  assert.equal(s.data.sub_zones, 1);
  assert.equal(s.data.sub_zones_no_collector, 1);
  assert.equal(s.data.sub_zones_no_cashier, 1);
  assert.equal(s.data.sub_zones_no_work_days, 1);
  assert.equal(s.data.groups_without_leader, 0);
  assert.equal(s.data.customers, 0);
});

test('groups v2: RBAC and district scoping unchanged', async () => {
  const w = await setupWorld();
  // Gudoomiye (zone A) can set the new fields on own-district groups only.
  const own = await mkGroup(w, { description: 'by gudoomiye' }, w.tokens.gudoomiye);
  assert.equal(own.description, 'by gudoomiye');
  const other = await api('POST', '/groups', { token: w.tokens.gudoomiye, body: { zone_id: w.zoneB.id, code: uniq('GX'), description: 'nope' } });
  assert.equal(other.status, 403);
  const gB = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: w.zoneB.id, code: uniq('GB') } });
  assert.equal(gB.status, 201);
  assert.equal((await api('PUT', '/groups/' + gB.data.id, { token: w.tokens.gudoomiye, body: { notes: 'x' } })).status, 403);
  assert.equal((await api('GET', '/groups/' + gB.data.id, { token: w.tokens.gudoomiye })).status, 403);
  // Read-only roles cannot write the new fields.
  assert.equal((await api('PUT', '/groups/' + own.id, { token: w.tokens.accountant, body: { notes: 'x' } })).status, 403);
  assert.equal((await api('PUT', '/groups/' + own.id, { token: w.tokens.collector, body: { notes: 'x' } })).status, 403);
  assert.equal((await api('PUT', '/groups/' + own.id, { token: w.tokens.cashier, body: { notes: 'x' } })).status, 403);
  assert.equal((await api('GET', '/groups/' + own.id, { token: w.tokens.collector })).status, 200);
  // Summary is district-scoped for zone-scoped roles and forbidden for others' districts.
  const sum = await api('GET', '/groups/summary', { token: w.tokens.gudoomiye });
  assert.equal(sum.status, 200);
  const countA = (await db.query('SELECT COUNT(*)::int AS n FROM groups WHERE zone_id = $1', [w.zoneA.id])).rows[0].n;
  assert.equal(sum.data.groups, countA);
  assert.equal((await api('GET', '/groups/summary?zone_id=' + w.zoneB.id, { token: w.tokens.gudoomiye })).status, 403);
  assert.equal((await api('GET', '/groups/summary', { token: w.tokens.cashier })).status, 403);
  // Zone / Sub Zone notes follow the same write rules.
  const z = await api('POST', '/group-zones', { token: w.tokens.accountant, body: { group_id: own.id, code: uniq('Z'), notes: 'x' } });
  assert.equal(z.status, 403);
  const rB = await api('POST', '/routes', { token: w.tokens.gudoomiye, body: { group_id: gB.data.id, code: uniq('R'), notes: 'x' } });
  assert.equal(rB.status, 403);
});

test('groups v2: routes list carries group name (Customers Sub Zone filter)', async () => {
  const w = await setupWorld();
  const g = await mkGroup(w, { name: 'Baarsiigo' });
  const r = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: g.id, code: uniq('R') } });
  const list = await api('GET', '/routes', { token: w.tokens.admin });
  assert.equal(list.status, 200);
  const row = list.data.find((x) => x.id === r.data.id);
  assert.equal(row.group_name, 'Baarsiigo');
  assert.equal(row.group_code, g.code);
  // Gudoomiye's unscoped list never shows another district's Sub Zones.
  const gB = await api('POST', '/groups', { token: w.tokens.admin, body: { zone_id: w.zoneB.id, code: uniq('GB') } });
  const rB = await api('POST', '/routes', { token: w.tokens.admin, body: { group_id: gB.data.id, code: uniq('R') } });
  const scoped = await api('GET', '/routes', { token: w.tokens.gudoomiye });
  assert.ok(!scoped.data.some((x) => x.id === rB.data.id));
  assert.ok(scoped.data.some((x) => x.id === r.data.id));
});
