const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld } = require('./helpers');

// Fleet upgrade: overview, fuel efficiency/currency/flags/CSV/receipts,
// maintenance workflow + due logic, expiry alerts, renew, assignment
// history, GPS trips, write-role gates.
const BASE = process.env.TEST_BASE;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let seq = 0;
const uniq = () => `${Date.now().toString().slice(-6)}${++seq}`;

async function mkTruck(zoneId, extra = {}) {
  const cols = ['plate_number', 'model', 'zone_id', ...Object.keys(extra)];
  const vals = ['FT-' + uniq(), 'Hino', zoneId, ...Object.values(extra)];
  const r = await db.query(`INSERT INTO trucks (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, vals);
  return r.rows[0];
}
async function mkEmployee(type, zoneId) {
  const r = await db.query(
    `INSERT INTO employees (name, employee_type, collector_type, phone, zone_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [`Fleet ${type} ${uniq()}`, type, type === 'collector' ? 'residential' : null, '0655' + uniq().slice(-6), zoneId]);
  return r.rows[0].id;
}
async function today() {
  const { getTimezone, localParts } = require('../lib/autoBilling');
  const tz = await getTimezone();
  return { tz, day: localParts(new Date(), tz).date };
}
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function upload(path, token, field, buf, filename, type) {
  const form = new FormData();
  form.append(field, new Blob([buf], { type }), filename);
  const res = await fetch(BASE + '/api/v2' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  let body = null; try { body = await res.json(); } catch (_) { /* none */ }
  return { status: res.status, body };
}

test('fleet: overview returns KPIs + one card per truck, zone-scoped', async () => {
  const w = await setupWorld();
  const a = await mkTruck(w.zoneA.id);
  const b = await mkTruck(w.zoneB.id);
  const r = await api('GET', '/fleet/overview', { token: w.tokens.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const k = r.data.kpis;
  for (const key of ['trucks', 'fuel_cost_month_usd', 'maintenance_cost_month_usd', 'documents_expiring_30', 'maintenance_due']) assert.ok(key in k, key);
  for (const s of ['active', 'maintenance', 'inactive']) assert.equal(typeof k.trucks[s], 'number');
  const card = r.data.trucks.find((t) => t.id === a.id);
  assert.ok(card);
  for (const key of ['plate_number', 'status', 'collector_name', 'driver_name', 'fuel_cost_month_usd', 'maintenance_cost_month_usd', 'km_month', 'km_per_liter', 'next_maintenance', 'nearest_document', 'live']) assert.ok(key in card, key);
  assert.equal(card.live.status, 'no_signal');
  assert.ok(r.data.trucks.some((t) => t.id === b.id));

  const g = await api('GET', '/fleet/overview', { token: w.tokens.gudoomiye });
  assert.equal(g.status, 200);
  assert.ok(g.data.trucks.some((t) => t.id === a.id));
  assert.ok(!g.data.trucks.some((t) => t.id === b.id), 'zone B truck hidden from zone A gudoomiye');
  assert.equal((await api('GET', '/fleet/overview', { token: w.tokens.head })).status, 403);
});

test('fleet: fuel currency, price/L, efficiency, low-efficiency + odometer flags, totals, CSV', async () => {
  const w = await setupWorld();
  const t = await mkTruck(w.zoneA.id);
  const { day } = await today();
  const log = async (odo, liters, n, extra = {}) => {
    const r = await api('POST', '/fleet/fuel', { token: w.tokens.admin, body: { truck_id: t.id, liters, cost: 40, odometer_reading: odo, record_date: addDays(day, n - 10), ...extra } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.data;
  };
  await log(1000, 40, 1);
  const second = await log(1400, 40, 2, { station: 'Hargeisa Total' });
  assert.equal(second.km_since_last, 400);
  assert.equal(second.km_per_liter, 10);
  assert.equal(second.cost_per_km_usd, 0.1);
  assert.equal(second.price_per_liter, 1);
  assert.equal(second.station, 'Hargeisa Total');
  await log(1800, 40, 3);
  await log(2200, 40, 4);
  const low = await log(2400, 40, 5); // 5 km/L vs median 10
  assert.deepEqual(low.flags, ['low_efficiency']);
  const back = await log(2300, 20, 6);
  assert.ok(back.needs_review);
  assert.ok(back.flags.includes('odometer_backwards'));

  // SLSH by price per liter (cost derived) -> USD equivalent at the current rate.
  const rate = Number((await db.query('SELECT rate FROM exchange_rates WHERE effective_from <= NOW() ORDER BY effective_from DESC LIMIT 1')).rows[0].rate);
  const sl = await api('POST', '/fleet/fuel', { token: w.tokens.admin, body: { truck_id: t.id, liters: 10, price_per_liter: 8500, currency: 'SLSH', record_date: addDays(day, -3) } });
  assert.equal(sl.status, 201, JSON.stringify(sl.body));
  assert.equal(sl.data.currency, 'SLSH');
  assert.equal(Number(sl.data.cost), 85000);
  assert.equal(sl.data.cost_usd, Math.round((85000 / rate) * 100) / 100);
  assert.equal((await api('POST', '/fleet/fuel', { token: w.tokens.admin, body: { truck_id: t.id, liters: 10, cost: 5, currency: 'EUR' } })).status, 400);

  const list = await api('GET', `/fleet/fuel?truck_id=${t.id}`, { token: w.tokens.admin });
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 7);
  const totals = list.body.meta.totals;
  assert.equal(totals.count, 7);
  assert.equal(totals.cost_by_currency.USD, 240);
  assert.equal(totals.cost_by_currency.SLSH, 85000);
  const ranged = await api('GET', `/fleet/fuel?truck_id=${t.id}&date_from=${addDays(day, -8)}&date_to=${addDays(day, -6)}`, { token: w.tokens.admin });
  assert.equal(ranged.data.length, 3);
  assert.equal((await api('GET', `/fleet/fuel?month=2026-13`, { token: w.tokens.admin })).status, 400);

  const csv = await fetch(`${BASE}/api/v2/fleet/fuel.csv?truck_id=${t.id}`, { headers: { Authorization: 'Bearer ' + w.tokens.admin } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = (await csv.text()).replace(/^﻿/, '');
  const lines = text.split('\r\n');
  assert.equal(lines.length, 8);
  assert.match(lines[0], /"Km per liter"/);
  assert.ok(text.includes('low_efficiency'));
  assert.ok(text.includes('Hargeisa Total'));
});

test('fleet: fuel receipt upload accepts image/pdf, rejects other types; download is scoped', async () => {
  const w = await setupWorld();
  const t = await mkTruck(w.zoneA.id);
  const tb = await mkTruck(w.zoneB.id);
  const f = (await api('POST', '/fleet/fuel', { token: w.tokens.admin, body: { truck_id: t.id, liters: 10, cost: 12 } })).data;
  const fb = (await api('POST', '/fleet/fuel', { token: w.tokens.admin, body: { truck_id: tb.id, liters: 10, cost: 12 } })).data;
  const ok = await upload(`/fleet/fuel/${f.id}/receipt`, w.tokens.gudoomiye, 'file', PNG, 'r.png', 'image/png');
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const txt = await upload(`/fleet/fuel/${f.id}/receipt`, w.tokens.admin, 'file', Buffer.from('hello'), 'r.txt', 'text/plain');
  assert.equal(txt.status, 400);
  const fake = await upload(`/fleet/fuel/${f.id}/receipt`, w.tokens.admin, 'file', Buffer.from('MZ not a png'), 'r.png', 'image/png');
  assert.equal(fake.status, 400);
  const pdf = await upload(`/fleet/fuel/${fb.id}/receipt`, w.tokens.admin, 'file', Buffer.from('%PDF-1.4\n%%EOF'), 'r.pdf', 'application/pdf');
  assert.equal(pdf.status, 201);
  const cross = await upload(`/fleet/fuel/${fb.id}/receipt`, w.tokens.gudoomiye, 'file', PNG, 'r.png', 'image/png');
  assert.equal(cross.status, 403);

  const get = await fetch(`${BASE}/api/v2/fleet/fuel/${f.id}/receipt`, { headers: { Authorization: 'Bearer ' + w.tokens.cashier } });
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('content-type'), 'image/png');
  const denied = await fetch(`${BASE}/api/v2/fleet/fuel/${fb.id}/receipt`, { headers: { Authorization: 'Bearer ' + w.tokens.gudoomiye } });
  assert.equal(denied.status, 403);
  const listed = await api('GET', `/fleet/fuel/${f.id}`, { token: w.tokens.admin });
  assert.equal(listed.data.has_receipt, true);
  assert.ok(!('receipt_storage_path' in listed.data));
});

test('fleet: maintenance status workflow moves the truck status', async () => {
  const w = await setupWorld();
  const t = await mkTruck(w.zoneA.id);
  // Legacy create (no status) still = completed and still needs cost > 0.
  assert.equal((await api('POST', '/fleet/maintenance', { token: w.tokens.admin, body: { truck_id: t.id, description: 'Oil' } })).status, 400);
  const legacy = await api('POST', '/fleet/maintenance', { token: w.tokens.admin, body: { truck_id: t.id, description: 'Oil', cost: 20 } });
  assert.equal(legacy.status, 201);
  assert.equal(legacy.data.status, 'completed');

  const s = await api('POST', '/fleet/maintenance', { token: w.tokens.admin, body: { truck_id: t.id, description: 'Brakes', status: 'scheduled', scheduled_date: '2030-01-05' } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.equal(Number(s.data.cost), 0);
  const s2 = await api('POST', '/fleet/maintenance', { token: w.tokens.admin, body: { truck_id: t.id, description: 'Tyres', status: 'scheduled' } });

  const start = await api('PUT', `/fleet/maintenance/${s.data.id}/status`, { token: w.tokens.gudoomiye, body: { status: 'in_progress' } });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal((await db.query('SELECT status FROM trucks WHERE id=$1', [t.id])).rows[0].status, 'maintenance');
  await api('PUT', `/fleet/maintenance/${s2.data.id}/status`, { token: w.tokens.admin, body: { status: 'in_progress' } });

  assert.equal((await api('PUT', `/fleet/maintenance/${s.data.id}/status`, { token: w.tokens.admin, body: { status: 'completed' } })).status, 400, 'cost required');
  const done = await api('PUT', `/fleet/maintenance/${s.data.id}/status`, { token: w.tokens.admin, body: { status: 'completed', parts: [{ name: 'Pads', qty: 2, unit_cost: 15 }], odometer_at_service: 5000, interval_km: 10000 } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(Number(done.data.cost), 30);
  assert.equal(done.data.next_service_km, 15000);
  assert.ok(done.data.downtime_days !== null);
  assert.equal((await db.query('SELECT status FROM trucks WHERE id=$1', [t.id])).rows[0].status, 'maintenance', 'another job still in progress');
  const done2 = await api('PUT', `/fleet/maintenance/${s2.data.id}/status`, { token: w.tokens.admin, body: { status: 'completed', cost: 80 } });
  assert.equal(done2.status, 200);
  assert.equal((await db.query('SELECT status FROM trucks WHERE id=$1', [t.id])).rows[0].status, 'active');

  const illegal = await api('PUT', `/fleet/maintenance/${s.data.id}/status`, { token: w.tokens.admin, body: { status: 'in_progress' } });
  assert.equal(illegal.status, 409);
});

test('fleet: maintenance due by date and by km; due alerts once per day', async () => {
  const w = await setupWorld();
  const { day } = await today();
  const byDate = await mkTruck(w.zoneA.id);
  const byKm = await mkTruck(w.zoneA.id);
  const notDue = await mkTruck(w.zoneA.id);
  const mk = (truck, body) => api('POST', '/fleet/maintenance', { token: w.tokens.admin, body: { truck_id: truck.id, description: 'Service <b>x</b>', cost: 10, ...body } });
  await mk(byDate, { next_service_date: addDays(day, 3) });
  await mk(byKm, { next_service_km: 10000, odometer_at_service: 1000 });
  await mk(notDue, { next_service_km: 10000, next_service_date: addDays(day, 60) });
  await api('POST', '/fleet/fuel', { token: w.tokens.admin, body: { truck_id: byKm.id, liters: 10, cost: 10, odometer_reading: 9600 } });
  await api('POST', '/fleet/fuel', { token: w.tokens.admin, body: { truck_id: notDue.id, liters: 10, cost: 10, odometer_reading: 9000 } });

  const ov = await api('GET', '/fleet/overview', { token: w.tokens.admin });
  const card = (id) => ov.data.trucks.find((t) => t.id === id).next_maintenance;
  assert.deepEqual(card(byDate.id).due_reasons, ['date']);
  assert.deepEqual(card(byKm.id).due_reasons, ['km']);
  assert.equal(card(notDue.id).due, false);
  const list = await api('GET', `/fleet/maintenance?truck_id=${byKm.id}`, { token: w.tokens.admin });
  assert.equal(list.data[0].is_due, true);

  const { sendMaintenanceDueAlerts } = require('../lib/fleetMonitor');
  await sendMaintenanceDueAlerts(day);
  await sendMaintenanceDueAlerts(day);
  const n = await db.query(`SELECT n.title, n.body, u.username FROM v2_staff_notifications n JOIN v2_users u ON u.id = n.recipient_id
                            WHERE n.event_type = 'fleet.maintenance_due' AND n.entity_id = $1`, [byKm.id]);
  const users = n.rows.map((r) => r.username);
  assert.equal(users.filter((u) => u === 't_admin').length, 1);
  assert.equal(users.filter((u) => u === 't_gudoomiye').length, 1);
  assert.ok(!n.rows.some((r) => /[<>]/.test(r.body)), 'user text sanitised');
  const none = await db.query(`SELECT 1 FROM v2_staff_notifications WHERE event_type = 'fleet.maintenance_due' AND entity_id = $1`, [notDue.id]);
  assert.equal(none.rows.length, 0);
});

test('fleet: expiry alerts once per threshold; renew updates the date + audit', async () => {
  const w = await setupWorld();
  const { day } = await today();
  const t = await mkTruck(w.zoneA.id, { insurance_expiry: addDays(day, 20) });
  const { sendExpiryAlerts } = require('../lib/fleetMonitor');
  const count = async () => (await db.query(
    `SELECT COUNT(*)::int AS n FROM v2_staff_notifications n JOIN v2_users u ON u.id = n.recipient_id
     WHERE n.event_type = 'fleet.document_expiry' AND n.entity_id = $1 AND u.username = 't_gudoomiye'`, [t.id])).rows[0].n;
  await sendExpiryAlerts(day);
  await sendExpiryAlerts(day);
  assert.equal(await count(), 1, '30-day alert once');
  await db.query('UPDATE trucks SET insurance_expiry = $1 WHERE id = $2', [addDays(day, 20), t.id]);
  await sendExpiryAlerts(addDays(day, 14)); // 6 days left -> 7-day threshold
  await sendExpiryAlerts(addDays(day, 15));
  assert.equal(await count(), 2, '7-day alert once');

  const newDate = addDays(day, 365);
  assert.equal((await api('PUT', `/trucks/${t.id}/renew`, { token: w.tokens.cashier, body: { document: 'insurance', new_expiry: newDate } })).status, 403);
  assert.equal((await api('PUT', `/trucks/${t.id}/renew`, { token: w.tokens.admin, body: { document: 'oil', new_expiry: newDate } })).status, 400);
  assert.equal((await api('PUT', `/trucks/${t.id}/renew`, { token: w.tokens.admin, body: { document: 'insurance', new_expiry: '2020-01-01' } })).status, 400);
  const r = await api('PUT', `/trucks/${t.id}/renew`, { token: w.tokens.gudoomiye, body: { document: 'insurance', new_expiry: newDate } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.data.insurance_expiry, newDate);
  const a = await db.query(`SELECT before_data, after_data FROM v2_audit_log WHERE action = 'truck.document_renew' AND entity_id = $1`, [t.id]);
  assert.equal(a.rows.length, 1);
  assert.equal(a.rows[0].after_data.expiry, newDate);
});

test('fleet: assignment history row on collector change', async () => {
  const w = await setupWorld();
  const c1 = await mkEmployee('collector', w.zoneA.id);
  const c2 = await mkEmployee('collector', w.zoneA.id);
  const created = await api('POST', '/trucks', { token: w.tokens.admin, body: { plate_number: 'AH-' + uniq(), zone_id: w.zoneA.id, collector_id: c1 } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.data.id;
  assert.equal((await api('PUT', `/trucks/${id}`, { token: w.tokens.admin, body: { model: 'Same people' } })).status, 200);
  assert.equal((await api('GET', `/trucks/${id}/assignments`, { token: w.tokens.admin })).data.length, 1, 'no row when assignment unchanged');
  assert.equal((await api('PUT', `/trucks/${id}`, { token: w.tokens.admin, body: { collector_id: c2 } })).status, 200);
  const h = await api('GET', `/trucks/${id}/assignments`, { token: w.tokens.cashier });
  assert.equal(h.status, 200);
  assert.equal(h.data.length, 2);
  assert.equal(h.data[0].collector_id, c2);
  assert.equal(h.data[0].to_at, null);
  assert.equal(h.data[1].collector_id, c1);
  assert.ok(h.data[1].to_at);
});

test('fleet: trips km from GPS points, a noise jump ignored', async () => {
  const w = await setupWorld();
  const emp = await mkEmployee('collector', w.zoneA.id);
  const t = await mkTruck(w.zoneA.id, { collector_id: emp });
  // 10 points 0.0009 deg lat (~100 m) apart every 20 s, plus one 5 km jump
  // 10 s after the 5th point (noise).
  const start = Date.now() - 5 * 60 * 1000;
  for (let i = 0; i < 10; i++) {
    await db.query(`INSERT INTO collector_location_history (employee_id, lat, lng, recorded_at) VALUES ($1,$2,$3,$4)`,
      [emp, 9.56 + i * 0.0009, 44.06, new Date(start + i * 20000)]);
    if (i === 4) {
      await db.query(`INSERT INTO collector_location_history (employee_id, lat, lng, recorded_at) VALUES ($1,$2,$3,$4)`,
        [emp, 9.605, 44.06, new Date(start + i * 20000 + 10000)]);
    }
  }
  const { materialiseDay } = require('../lib/fleetInsights');
  const { tz, day } = await today();
  await materialiseDay(addDays(day, -1), tz);
  await materialiseDay(day, tz);
  await materialiseDay(day, tz); // idempotent
  const r = await api('GET', `/trucks/${t.id}/trips?days=2`, { token: w.tokens.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.data.total_km > 0.85 && r.data.total_km < 0.95, `km ${r.data.total_km}`);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM truck_daily_distance WHERE truck_id = $1', [t.id])).rows[0].n >= 1, true);

  const unit = require('../lib/fleetInsights').distanceKm([{ lat: 0, lng: 0, t: 0 }, { lat: 0.01, lng: 0, t: 1200 }]);
  assert.equal(unit.km, 0, 'a gap over 10 minutes is not counted');
  const s = await api('GET', `/trucks/${t.id}/summary`, { token: w.tokens.admin });
  assert.equal(s.status, 200);
  assert.equal(s.data.chart.length, 6);
});

test('fleet: non-write roles get 403 on fleet writes', async () => {
  const w = await setupWorld();
  const t = await mkTruck(w.zoneA.id);
  const f = (await api('POST', '/fleet/fuel', { token: w.tokens.admin, body: { truck_id: t.id, liters: 5, cost: 5 } })).data;
  const m = (await api('POST', '/fleet/maintenance', { token: w.tokens.admin, body: { truck_id: t.id, description: 'x', status: 'scheduled' } })).data;
  for (const role of ['cashier', 'collector', 'accountant']) {
    const tok = w.tokens[role];
    assert.equal((await api('POST', '/fleet/fuel', { token: tok, body: { truck_id: t.id, liters: 5, cost: 5 } })).status, 403, role);
    assert.equal((await api('POST', '/fleet/maintenance', { token: tok, body: { truck_id: t.id, description: 'x', cost: 5 } })).status, 403, role);
    assert.equal((await api('PUT', `/fleet/maintenance/${m.id}/status`, { token: tok, body: { status: 'in_progress' } })).status, 403, role);
    assert.equal((await api('PUT', `/trucks/${t.id}/renew`, { token: tok, body: { document: 'insurance', new_expiry: '2031-01-01' } })).status, 403, role);
    assert.equal((await upload(`/fleet/fuel/${f.id}/receipt`, tok, 'file', PNG, 'r.png', 'image/png')).status, 403, role);
    assert.equal((await upload(`/fleet/maintenance/${m.id}/receipt`, tok, 'file', PNG, 'r.png', 'image/png')).status, 403, role);
    assert.equal((await upload(`/trucks/${t.id}/photo`, tok, 'photo', PNG, 'p.png', 'image/png')).status, 403, role);
  }
  const photo = await upload(`/trucks/${t.id}/photo`, w.tokens.admin, 'file', PNG, 'p.png', 'image/png');
  assert.equal(photo.status, 200, JSON.stringify(photo.body));
  const get = await fetch(`${BASE}/api/v2/trucks/${t.id}/photo`, { headers: { Authorization: 'Bearer ' + w.tokens.collector } });
  assert.equal(get.status, 200);
});
