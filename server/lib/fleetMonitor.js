const { pool } = require('../db');
const logger = require('./logger');
const { getTimezone, localParts, shiftDate } = require('./autoBilling');
const { createStaffNotification, logNotificationFailure } = require('./staffNotifications');
const { materialiseDay, getNextMaintenance } = require('./fleetInsights');

// Hourly fleet monitor:
//  1. materialise GPS km per truck for yesterday + today (idempotent upsert),
//  2. document-expiry alerts 30 and 7 days ahead, once per threshold per
//     document date (fleet_alerts_sent),
//  3. maintenance-due alerts, once per record per day.
// Recipients: active admins + active gudoomiye of the truck's district.
// Disabled with FLEET_MONITOR=off (the test suite drives checkOnce itself).

const DOC_LABELS = {
  insurance: { en: 'insurance', so: 'caymiska' },
  registration: { en: 'registration', so: 'diiwaangelinta' },
  road_tax: { en: 'road tax', so: 'canshuurta waddada' },
};

// Notification text is plain text built from user-entered values (plate,
// description) — strip markup/control characters and cap the length.
function cleanText(value, max = 80) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

async function recipientsForZone(zoneId, client = pool) {
  const r = await client.query(
    `SELECT u.id FROM v2_users u
     WHERE u.is_active = TRUE AND (u.role = 'admin'
       OR (u.role = 'gudoomiye' AND $1::int IS NOT NULL AND u.zone = (SELECT name FROM zones WHERE id = $1::int)))`,
    [zoneId]
  );
  return r.rows.map((x) => x.id);
}

// Claims an alert slot; true only for the caller that inserted it.
async function claimAlert({ truckId, kind, refId = 0, threshold = 0, forDate }, client = pool) {
  const r = await client.query(
    `INSERT INTO fleet_alerts_sent (truck_id, kind, ref_id, threshold, for_date) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (truck_id, kind, ref_id, threshold, for_date) DO NOTHING RETURNING id`,
    [truckId, kind, refId, threshold, forDate]
  );
  return r.rows.length > 0;
}

async function releaseAlert({ truckId, kind, refId = 0, threshold = 0, forDate }, client = pool) {
  await client.query(
    `DELETE FROM fleet_alerts_sent WHERE truck_id = $1 AND kind = $2 AND ref_id = $3 AND threshold = $4 AND for_date = $5`,
    [truckId, kind, refId, threshold, forDate]);
}

// Returns how many notifications were delivered.
async function notifyAll(recipients, payload) {
  let ok = 0;
  for (const id of recipients) {
    try { await createStaffNotification({ recipientId: id, ...payload }); ok += 1; } catch (e) { logNotificationFailure(payload.eventType, e); }
  }
  return ok;
}

// Claim the slot, send, and release the claim if nothing was delivered so
// the next hourly run retries.
async function sendClaimed(slot, recipients, payload, client = pool) {
  if (!(await claimAlert(slot, client))) return false;
  let delivered = 0;
  try { delivered = await notifyAll(recipients, payload); } catch (e) { delivered = 0; }
  if (recipients.length > 0 && delivered === 0) { await releaseAlert(slot, client); return false; }
  return true;
}

async function sendExpiryAlerts(today, client = pool) {
  const r = await client.query(
    `SELECT t.id AS truck_id, t.plate_number, t.zone_id, doc.document_type, doc.expiry_date,
            (doc.expiry_date - $1::date) AS days_left
     FROM trucks t
     CROSS JOIN LATERAL (VALUES
       ('insurance', t.insurance_expiry), ('registration', t.registration_expiry), ('road_tax', t.road_tax_expiry)
     ) AS doc(document_type, expiry_date)
     WHERE t.status <> 'retired' AND doc.expiry_date IS NOT NULL
       AND doc.expiry_date >= $1::date AND doc.expiry_date <= $1::date + 30`,
    [today]
  );
  let sent = 0;
  for (const row of r.rows) {
    const days = Number(row.days_left);
    const threshold = days <= 7 ? 7 : 30;
    const plate = cleanText(row.plate_number, 50);
    const label = DOC_LABELS[row.document_type] || { en: row.document_type, so: row.document_type };
    const ok = await sendClaimed(
      { truckId: row.truck_id, kind: `expiry_${row.document_type}`, threshold, forDate: row.expiry_date },
      await recipientsForZone(row.zone_id, client),
      {
        eventType: 'fleet.document_expiry',
        title: cleanText(`${plate}: ${label.so} wuxuu dhacayaa ${days} maalmood gudahood / ${label.en} expires in ${days} days`, 255),
        body: `Truck ${plate} — ${label.en} expires on ${row.expiry_date}. Renew it from Fleet > Document Expiry.`,
        entityType: 'truck',
        entityId: row.truck_id,
      }, client);
    if (ok) sent += 1;
  }
  return sent;
}

// Once per due item per 3 days; skipped while a job is already scheduled or
// in progress for that truck (somebody is on it).
const DUE_REPEAT_DAYS = 3;
async function sendMaintenanceDueAlerts(today, client = pool) {
  const next = await getNextMaintenance({ today }, client);
  let sent = 0;
  for (const m of next.values()) {
    if (!m.due) continue;
    const open = await client.query(
      `SELECT 1 FROM truck_maintenance_records WHERE truck_id = $1 AND status IN ('scheduled', 'in_progress') LIMIT 1`, [m.truck_id]);
    if (open.rows.length) continue;
    const recent = await client.query(
      `SELECT 1 FROM fleet_alerts_sent WHERE truck_id = $1 AND kind = 'maintenance_due' AND ref_id = $2
         AND for_date > $3::date - $4::int AND for_date <= $3::date LIMIT 1`,
      [m.truck_id, m.record_id, today, DUE_REPEAT_DAYS]);
    if (recent.rows.length) continue;
    const plate = cleanText(m.plate_number, 50);
    const what = cleanText(m.description, 120);
    const parts = [];
    if (m.next_service_date) parts.push(`date ${m.next_service_date}`);
    if (m.next_service_km !== null && m.next_service_km !== undefined) parts.push(`${m.next_service_km} km (now ${m.current_odometer ?? '?'} km)`);
    const ok = await sendClaimed(
      { truckId: m.truck_id, kind: 'maintenance_due', refId: m.record_id, forDate: today },
      await recipientsForZone(m.zone_id, client),
      {
        eventType: 'fleet.maintenance_due',
        title: cleanText(`${plate}: dayactir ayaa la gaaray / maintenance due`, 255),
        body: `Truck ${plate} — next service due (${parts.join(', ')}). Last service: ${what}.`,
        entityType: 'truck',
        entityId: m.truck_id,
      }, client);
    if (ok) sent += 1;
  }
  return sent;
}

async function checkOnce(now = new Date()) {
  const tz = await getTimezone();
  const today = localParts(now, tz).date;
  const result = { trips: 0, expiry: 0, due: 0 };
  const step = async (key, fn) => {
    try { result[key] = await fn(); } catch (e) { logger.error('fleet_monitor_step_failed', { step: key, message: e && e.message }); }
  };
  await step('trips', async () => (await materialiseDay(shiftDate(today, -1), tz)) + (await materialiseDay(today, tz)));
  await step('expiry', () => sendExpiryAlerts(today));
  await step('due', () => sendMaintenanceDueAlerts(today));
  return result;
}

function startMonitor() {
  if (process.env.FLEET_MONITOR === 'off') return null;
  const safe = () => checkOnce().catch((e) => logger.error('fleet_monitor_failed', { message: e && e.message }));
  const first = setTimeout(safe, 90 * 1000);
  const timer = setInterval(safe, 60 * 60 * 1000);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return { first, timer };
}

module.exports = { checkOnce, startMonitor, sendExpiryAlerts, sendMaintenanceDueAlerts, cleanText, recipientsForZone };
