const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getTimezone, localParts } = require('../lib/autoBilling');

const router = express.Router();

// Route & GIS / Map — Implementation Spec §12. New, additive, isolated
// module. Read-only projection of the CLOSED Customers/Group & Route
// tables — zero mutation, zero touch to routes/customers.js,
// routes/groups.js, or routesEntity.js. Mapbox is a rendering client
// only; this endpoint is the sole source of truth for the data it
// plots. GET /customers reads batch_customers.status/status_at ONLY
// (today's service status); collection-event GPS (status_lat/status_lng)
// is a hard privacy boundary and is never selected (Spec §8/§29).
const ALLOWED_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'];
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'head_of_cashiers'];

router.use(authenticateToken, requireRole(...ALLOWED_ROLES));

function parseStrictId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^\d+$/.test(String(raw))) return null;
  return parseInt(raw, 10);
}

// Trivial, duplicated, non-decisional identity lookup — same justified
// precedent already used across Offline/Sync, Staff Notifications, and
// Operational Calendar for reusing a one-line query without
// modifying/exporting from a CLOSED route file it also appears in.
async function resolveUserZoneId(user) {
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

// Resolve + validate the shared filter set (zone / group / group_zone / route)
// and apply the zone-forcing rule for scoped roles. Returns either
// { error: {status, body} }, { empty: true }, or { params, where }.
async function buildScope(req) {
  const parsed = {};
  const specs = [['zone_id', 'zone'], ['group_id', 'group'], ['group_zone_id', 'zone (group)'], ['route_id', 'route']];
  for (const [key, label] of specs) {
    parsed[key] = null;
    if (req.query[key] !== undefined) {
      parsed[key] = parseStrictId(req.query[key]);
      if (parsed[key] === null) {
        return { error: { status: 400, body: { error: { message: `Invalid ${label} id.`, code: 'VALIDATION' } } } };
      }
    }
  }

  // Zone security (Spec §14): non-Admin roles are FORCED to their own
  // zone server-side — a forged/different zone_id is silently
  // overridden, never trusted.
  let effectiveZoneId = parsed.zone_id;
  const role = (req.user.role || '').toLowerCase();
  if (ZONE_SCOPED_ROLES.includes(role)) {
    effectiveZoneId = await resolveUserZoneId(req.user);
    if (effectiveZoneId === null) return { empty: true };
  }

  const params = [];
  const where = [];
  if (effectiveZoneId !== null) { params.push(effectiveZoneId); where.push(`c.zone_id = $${params.length}`); }
  if (parsed.group_id !== null) { params.push(parsed.group_id); where.push(`c.group_id = $${params.length}`); }
  if (parsed.route_id !== null) { params.push(parsed.route_id); where.push(`c.route_id = $${params.length}`); }
  if (parsed.group_zone_id !== null) { params.push(parsed.group_zone_id); where.push(`r.group_zone_id = $${params.length}`); }
  // A route_id whose own group_id doesn't match a supplied group_id
  // yields an empty result, not an error — no scope-existence leak.
  if (parsed.group_id !== null && parsed.route_id !== null) {
    params.push(parsed.group_id); where.push(`r.group_id = $${params.length}`);
  }
  return { params, where };
}

// Hierarchy columns shared by the map list and the missing-location list.
// COALESCE(name, code): groups/routes/group_zones have a required code and
// an OPTIONAL name, so a code-only record must still show a label.
const PATH_COLUMNS = `c.id, c.customer_number, c.door_number, c.name, c.customer_type, c.status,
              c.billing_type, c.fee, c.fee_currency,
              c.lat, c.lng, c.zone_id, z.name AS zone_name,
              c.group_id, COALESCE(g.name, g.code) AS group_name,
              r.group_zone_id, COALESCE(gz.name, gz.code) AS group_zone_name,
              c.route_id, COALESCE(r.name, r.code) AS route_name,
              COALESCE(u.full_name, u.username) AS collector_name`;
const PATH_JOINS = `JOIN zones z ON z.id = c.zone_id
       LEFT JOIN groups g ON g.id = c.group_id
       LEFT JOIN routes r ON r.id = c.route_id
       LEFT JOIN group_zones gz ON gz.id = r.group_zone_id
       LEFT JOIN v2_users u ON u.id = r.collector_user_id`;
// Spec §9: only BOTH lat and lng populated, excluding the (0,0) placeholder.
const HAS_LOCATION = 'c.lat IS NOT NULL AND c.lng IS NOT NULL AND NOT (c.lat = 0 AND c.lng = 0)';

// GET /api/v2/map/customers
router.get('/customers', async (req, res) => {
  try {
    const scope = await buildScope(req);
    if (scope.error) return res.status(scope.error.status).json(scope.error.body);
    if (scope.empty) return res.json({ data: [] });

    const params = [...scope.params];
    // Today's service status is only computed on request (?today=1).
    const wantToday = req.query.today === '1';
    let todayJoin = '';
    if (wantToday) {
      const tz = await getTimezone();
      params.push(tz); const tzIdx = params.length;
      params.push(localParts(new Date(), tz).date); const todayIdx = params.length;
      todayJoin = `LEFT JOIN LATERAL (
         SELECT CASE bc.status WHEN 'serviced' THEN 'serviced' WHEN 'missed' THEN 'missed'
                               WHEN 'pending' THEN 'pending' ELSE 'skipped' END AS s
         FROM batch_customers bc JOIN batches b ON b.id = bc.batch_id
         WHERE bc.customer_id = c.id
           AND ( (bc.status <> 'pending' AND (bc.status_at AT TIME ZONE 'UTC' AT TIME ZONE $${tzIdx}::text)::date = $${todayIdx}::date)
              OR (bc.status = 'pending' AND b.status IN ('assigned','in_progress','partially_completed')
                  AND b.start_date <= $${todayIdx}::date AND (b.end_date IS NULL OR b.end_date >= $${todayIdx}::date)) )
         ORDER BY CASE bc.status WHEN 'serviced' THEN 0 WHEN 'missed' THEN 1 WHEN 'pending' THEN 3 ELSE 2 END
         LIMIT 1
       ) td ON TRUE`;
    }
    const where = ["c.status = 'active'", HAS_LOCATION, ...scope.where].join(' AND ');

    // One query, no N+1. Payment status: per non-voided invoice, outstanding =
    // net total - recorded payments in the INVOICE'S OWN currency (same rule as
    // lib/financialCalculations.paidInInvoiceCurrency). Today's status reads
    // ONLY batch_customers.status/status_at — never the collection GPS columns.
    const result = await pool.query(
      `SELECT ${PATH_COLUMNS},
              CASE WHEN inv.inv_count = 0 THEN 'none'
                   WHEN inv.open_count = 0 THEN 'clear'
                   WHEN inv.pay_count > 0 THEN 'partial'
                   ELSE 'unpaid' END AS payment_status,
              inv.outstanding_usd, inv.outstanding_slsh,
              ${wantToday ? "COALESCE(td.s, 'not_scheduled')" : 'NULL::text'} AS today_status
       FROM customers c
       ${PATH_JOINS}
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS inv_count,
                COUNT(*) FILTER (WHERE x.outstanding > 0.005)::int AS open_count,
                COALESCE(SUM(x.pay_count), 0)::int AS pay_count,
                COALESCE(SUM(x.outstanding) FILTER (WHERE x.currency <> 'SLSH' AND x.outstanding > 0.005), 0)::float AS outstanding_usd,
                COALESCE(SUM(x.outstanding) FILTER (WHERE x.currency = 'SLSH' AND x.outstanding > 0.005), 0)::float AS outstanding_slsh
         FROM (
           SELECT i.currency, p.paid, p.pay_count,
                  GREATEST(i.invoice_total - i.discount_amount - p.paid, 0) AS outstanding
           FROM invoices i
           CROSS JOIN LATERAL (
             SELECT COUNT(*)::int AS pay_count, COALESCE(SUM(CASE WHEN i.currency <> 'SLSH' THEN pp.amount_usd
                      ELSE COALESCE(pp.amount_invoice_currency,
                             CASE WHEN pp.currency = 'SLSH' THEN pp.amount
                                  ELSE pp.amount_usd * COALESCE(er.rate, (SELECT rate FROM exchange_rates WHERE effective_from <= NOW() ORDER BY effective_from DESC LIMIT 1), 0) END)
                      END), 0) AS paid
             FROM payments pp LEFT JOIN exchange_rates er ON er.id = pp.exchange_rate_id
             WHERE pp.invoice_id = i.id AND pp.status = 'recorded'
           ) p
           WHERE i.customer_id = c.id AND i.status <> 'voided'
         ) x
       ) inv ON TRUE
       ${todayJoin}
       WHERE ${where}
       ORDER BY c.id ASC`,
      params
    );

    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load map data.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/map/customers/missing-location — active in-scope customers that
// cannot be plotted (NULL lat/lng or the (0,0) placeholder), same filters.
router.get('/customers/missing-location', async (req, res) => {
  try {
    const scope = await buildScope(req);
    if (scope.error) return res.status(scope.error.status).json(scope.error.body);
    if (scope.empty) return res.json({ data: [] });
    const where = ["c.status = 'active'", `NOT (${HAS_LOCATION})`, ...scope.where].join(' AND ');
    const result = await pool.query(
      `SELECT ${PATH_COLUMNS}
       FROM customers c
       ${PATH_JOINS}
       WHERE ${where}
       ORDER BY c.id ASC`,
      scope.params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load customers without location.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/map/trucks — live trucks. Reads collector_locations (last
// known position, written by POST /v2/collection-sync/location — see that
// route for the write-side eligibility gate: only while the collector owns
// an assigned/in_progress batch). Only positions from the last 10 minutes
// are returned, so a parked/offline phone's stale position ages off the map.
// status: 'live' (< 2 min since the last ping) / 'idle' (2–10 min).
// speed_kmh is estimated from the last two collector_location_history
// points. progress counts today's work across the collector's active
// batches (serviced/missed by company-local status date, pending = still
// open). Zone-forcing is the same as GET /customers: scoped roles only see
// collectors of their own district.
const TRUCK_LOCATION_FRESHNESS_MINUTES = 10;
const TRUCK_LIVE_SECONDS = 120;
const TRAIL_POINT_CAP = 2000;
// Batches a collector is "working" — identical to the ping eligibility gate.
const ACTIVE_BATCH_STATUSES = "('assigned', 'in_progress')";

async function truckZoneScope(req) {
  let requestedZoneId = null;
  if (req.query.zone_id !== undefined) {
    requestedZoneId = parseStrictId(req.query.zone_id);
    if (requestedZoneId === null) return { error: { status: 400, body: { error: { message: 'Invalid zone id.', code: 'VALIDATION' } } } };
  }
  const role = (req.user.role || '').toLowerCase();
  if (ZONE_SCOPED_ROLES.includes(role)) {
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId === null) return { empty: true };
    return { zoneId: myZoneId };
  }
  return { zoneId: requestedZoneId };
}

function haversineMeters(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
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

router.get('/trucks', async (req, res) => {
  try {
    const scope = await truckZoneScope(req);
    if (scope.error) return res.status(scope.error.status).json(scope.error.body);
    if (scope.empty) return res.json({ data: [] });

    const tz = await getTimezone();
    const params = [tz, localParts(new Date(), tz).date];
    let where = `cl.recorded_at >= LOCALTIMESTAMP - INTERVAL '${TRUCK_LOCATION_FRESHNESS_MINUTES} minutes'`;
    if (scope.zoneId !== null) {
      params.push(scope.zoneId);
      where += ` AND e.zone_id = $${params.length}`;
    }

    // Truck: the truck assigned on the collector's active task wins (that is
    // what they are driving today); otherwise their standing assignment in
    // trucks.collector_id / driver_id.
    const result = await pool.query(
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
         FROM task_resources trc
         JOIN tasks tk ON tk.id = trc.task_id
         JOIN batches b ON b.id = tk.batch_id
         JOIN task_resources trt ON trt.task_id = trc.task_id AND trt.resource_type = 'truck'
         JOIN trucks t ON t.id = trt.resource_id
         WHERE trc.resource_type = 'collector' AND trc.resource_id = e.id AND b.status IN ${ACTIVE_BATCH_STATUSES}
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
           SELECT tk.batch_id FROM task_resources trc
           JOIN tasks tk ON tk.id = trc.task_id
           JOIN batches b ON b.id = tk.batch_id
           WHERE trc.resource_type = 'collector' AND trc.resource_id = e.id AND b.status IN ${ACTIVE_BATCH_STATUSES})
       ) wk ON TRUE
       LEFT JOIN LATERAL (
         SELECT array_agg(DISTINCT b.batch_code) AS batch_codes,
                array_remove(array_agg(DISTINCT COALESCE(r.name, r.code)), NULL) AS sub_zone_names
         FROM task_resources trc
         JOIN tasks tk ON tk.id = trc.task_id
         JOIN batches b ON b.id = tk.batch_id
         LEFT JOIN routes r ON r.id = b.route_id
         WHERE trc.resource_type = 'collector' AND trc.resource_id = e.id AND b.status IN ${ACTIVE_BATCH_STATUSES}
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

    const data = result.rows.map((r) => {
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
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load truck locations.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/map/trucks/:employeeId/trail?since=today — the collector's
// own pings for the company-local day, oldest first (capped). Same scoping:
// a scoped role asking for a collector outside its district gets 404 (no
// existence leak).
router.get('/trucks/:employeeId/trail', async (req, res) => {
  const employeeId = parseStrictId(req.params.employeeId);
  if (employeeId === null) return res.status(400).json({ error: { message: 'Invalid employee id.', code: 'VALIDATION' } });
  if (req.query.since !== undefined && req.query.since !== 'today') {
    return res.status(400).json({ error: { message: 'since must be "today".', code: 'VALIDATION' } });
  }
  try {
    const scope = await truckZoneScope(req);
    if (scope.error) return res.status(scope.error.status).json(scope.error.body);
    const notFound = () => res.status(404).json({ error: { message: 'Collector not found.', code: 'NOT_FOUND' } });
    if (scope.empty) return notFound();
    const emp = await pool.query('SELECT id, zone_id FROM employees WHERE id = $1', [employeeId]);
    if (!emp.rows[0]) return notFound();
    if (scope.zoneId !== null && emp.rows[0].zone_id !== scope.zoneId) return notFound();

    const tz = await getTimezone();
    const today = localParts(new Date(), tz).date;
    const r = await pool.query(
      `SELECT lat, lng, recorded_at FROM (
         SELECT lat::float AS lat, lng::float AS lng, recorded_at
         FROM collector_location_history
         WHERE employee_id = $1
           AND recorded_at >= ($2::date::timestamp AT TIME ZONE $3::text)
           AND recorded_at < (($2::date + 1)::timestamp AT TIME ZONE $3::text)
         ORDER BY recorded_at DESC
         LIMIT ${TRAIL_POINT_CAP}
       ) x ORDER BY recorded_at ASC`,
      [employeeId, today, tz]
    );
    res.json({ data: { employee_id: employeeId, date: today, points: r.rows } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load the route.', code: 'INTERNAL' } });
  }
});

module.exports = router;
