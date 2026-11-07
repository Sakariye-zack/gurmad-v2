const { pool } = require('../db');
const { getTimezone, localParts } = require('./autoBilling');
const { activeWorkWhere, ACTIVE_WORK_FROM } = require('./locationHistory');
const { haversineMeters } = require('./geo');

// Live trucks — the one query behind GET /v2/map/trucks and the dashboard
// "Today" panel (collectors active / trucks live). Reads collector_locations
// (last known position, written by POST /v2/collection-sync/location — see
// that route for the write-side eligibility gate: only while the collector
// owns an assigned/in_progress batch). Only positions from the last 10
// minutes are returned, so a parked/offline phone's stale position ages off.
// status: 'live' (< 2 min since the last ping) / 'idle' (2–10 min).
// speed_kmh is estimated from the last two collector_location_history
// points. progress counts today's work across the collector's active
// batches (serviced/missed by company-local status date, pending = still
// open).
const TRUCK_LOCATION_FRESHNESS_MINUTES = 10;
const TRUCK_LIVE_SECONDS = 120;
// "Working today" for the collector e.id (same rule as the ping gate).
const WORK_TODAY = activeWorkWhere('e.id', '$2::date');

// In-scope collector: home district, or the district of a batch worked
// today. zoneExpr is a SQL parameter reference; today is always $2.
function collectorInZoneSql(zoneExpr) {
  return `(e.zone_id = ${zoneExpr} OR EXISTS (
            SELECT 1 FROM ${ACTIVE_WORK_FROM}
            WHERE ${WORK_TODAY} AND b.zone_id = ${zoneExpr}))`;
}

// Last two pings -> km/h. Null when there is nothing sensible to say
// (single point, pings too far apart in time, or GPS jitter giving an
// impossible speed).
function estimateSpeedKmh(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const [p1, p0] = points; // newest first
  const dt = Number(p1.t) - Number(p0.t);
  if (!(dt >= 5 && dt <= 600)) return null;
  const kmh = (haversineMeters(p0, p1) / dt) * 3.6;
  if (!Number.isFinite(kmh) || kmh > 150) return null;
  return Math.round(kmh * 10) / 10;
}

// zoneId null = every district. Returns one row per collector seen in the
// last 10 minutes.
async function getLiveTrucks({ zoneId = null } = {}, client = pool) {
  const tz = await getTimezone();
  const params = [tz, localParts(new Date(), tz).date];
  let where = `cl.recorded_at >= LOCALTIMESTAMP - INTERVAL '${TRUCK_LOCATION_FRESHNESS_MINUTES} minutes'`;
  if (zoneId !== null) {
    params.push(zoneId);
    where += ` AND ${collectorInZoneSql(`$${params.length}::int`)}`;
  }

  // Truck: the truck assigned on the collector's active task wins (that is
  // what they are driving today); otherwise their standing assignment in
  // trucks.collector_id / driver_id.
  const result = await client.query(
    `SELECT cl.employee_id, cl.lat::float AS lat, cl.lng::float AS lng, cl.recorded_at,
            GREATEST(0, EXTRACT(EPOCH FROM (LOCALTIMESTAMP - cl.recorded_at)))::int AS seconds_ago,
            e.name AS collector_name, e.zone_id, z.name AS zone_name,
            COALESCE(ttk.id, atk.id) AS truck_id,
            COALESCE(ttk.plate_number, atk.plate_number) AS plate_number,
            CASE WHEN ttk.id IS NOT NULL THEN ttk.model ELSE atk.model END AS truck_name,
            COALESCE(wk.serviced, 0) AS serviced, COALESCE(wk.missed, 0) AS missed, COALESCE(wk.pending, 0) AS pending,
            COALESCE(bl.batch_codes, '{}') AS batch_codes, COALESCE(bl.sub_zone_names, '{}') AS sub_zone_names,
            hp.points AS last_points
     FROM collector_locations cl
     JOIN employees e ON e.id = cl.employee_id
     LEFT JOIN zones z ON z.id = e.zone_id
     LEFT JOIN LATERAL (
       SELECT t.id, t.plate_number, t.model
       FROM ${ACTIVE_WORK_FROM}
       JOIN task_resources trt ON trt.task_id = trc.task_id AND trt.resource_type = 'truck'
       JOIN trucks t ON t.id = trt.resource_id AND t.status = 'active'
       WHERE ${WORK_TODAY}
       ORDER BY (tk.status = 'in_progress') DESC, tk.id DESC
       LIMIT 1
     ) ttk ON TRUE
     LEFT JOIN LATERAL (
       SELECT t.id, t.plate_number, t.model
       FROM trucks t
       WHERE (t.collector_id = e.id OR t.driver_id = e.id) AND t.status = 'active'
       ORDER BY (t.collector_id = e.id) DESC, t.id ASC
       LIMIT 1
     ) atk ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE bc.status = 'serviced'
                AND (bc.status_at AT TIME ZONE 'UTC' AT TIME ZONE $1::text)::date = $2::date)::int AS serviced,
              COUNT(*) FILTER (WHERE bc.status = 'missed'
                AND (bc.status_at AT TIME ZONE 'UTC' AT TIME ZONE $1::text)::date = $2::date)::int AS missed,
              COUNT(*) FILTER (WHERE bc.status = 'pending')::int AS pending
       FROM batch_customers bc
       WHERE bc.batch_id IN (
         SELECT tk.batch_id FROM ${ACTIVE_WORK_FROM}
         WHERE ${WORK_TODAY})
     ) wk ON TRUE
     LEFT JOIN LATERAL (
       SELECT array_agg(DISTINCT b.batch_code) AS batch_codes,
              array_remove(array_agg(DISTINCT COALESCE(r.name, r.code)), NULL) AS sub_zone_names
       FROM ${ACTIVE_WORK_FROM}
       LEFT JOIN routes r ON r.id = b.route_id
       WHERE ${WORK_TODAY}
     ) bl ON TRUE
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object('lat', h.lat::float, 'lng', h.lng::float, 't', EXTRACT(EPOCH FROM h.recorded_at)) ORDER BY h.recorded_at DESC) AS points
       FROM (SELECT lat, lng, recorded_at FROM collector_location_history
             WHERE employee_id = e.id ORDER BY recorded_at DESC LIMIT 2) h
     ) hp ON TRUE
     WHERE ${where}
     ORDER BY cl.employee_id ASC`,
    params
  );

  return result.rows.map((r) => {
    const status = r.seconds_ago < TRUCK_LIVE_SECONDS ? 'live' : 'idle';
    const total = r.serviced + r.missed + r.pending;
    const { last_points: lastPoints, serviced, missed, pending, ...rest } = r;
    return {
      ...rest,
      status,
      // An idle phone has stopped reporting: its last speed is not "now".
      speed_kmh: status === 'live' ? estimateSpeedKmh(lastPoints) : null,
      progress: { serviced, missed, pending, total },
    };
  });
}

module.exports = {
  getLiveTrucks, collectorInZoneSql, estimateSpeedKmh, TRUCK_LOCATION_FRESHNESS_MINUTES, TRUCK_LIVE_SECONDS,
};
