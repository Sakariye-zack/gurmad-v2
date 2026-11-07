const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getTimezone, localParts } = require('../lib/autoBilling');
const { getLiveTrucks, collectorInZoneSql } = require('../lib/liveTrucks');

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

// GET /api/v2/map/trucks — live trucks. The query itself lives in
// lib/liveTrucks.js (shared with the dashboard "Today" panel); see there
// for freshness/status/speed/progress rules. Zone-forcing is the same as
// GET /customers: scoped roles only see collectors of their own district.
const TRAIL_POINT_CAP = 2000;
// Today's route is more sensitive than "where is the truck now": admin and
// gudoomiye only (ruling).
const TRAIL_ROLES = ['admin', 'gudoomiye'];

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

router.get('/trucks', async (req, res) => {
  try {
    const scope = await truckZoneScope(req);
    if (scope.error) return res.status(scope.error.status).json(scope.error.body);
    if (scope.empty) return res.json({ data: [] });
    res.json({ data: await getLiveTrucks({ zoneId: scope.zoneId }) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load truck locations.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/map/trucks/:employeeId/trail?since=today — the collector's
// own pings for the company-local day, oldest first (capped). Admin and
// gudoomiye only (403 for the other map roles). Same district scoping as
// the trucks list: a gudoomiye asking for a collector outside its district
// gets 404 (no existence leak).
router.get('/trucks/:employeeId/trail', requireRole(...TRAIL_ROLES), async (req, res) => {
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
    const tz = await getTimezone();
    const today = localParts(new Date(), tz).date;
    const empParams = [employeeId, today];
    let empWhere = 'e.id = $1 AND $2::date IS NOT NULL';
    if (scope.zoneId !== null) {
      empParams.push(scope.zoneId);
      empWhere += ` AND ${collectorInZoneSql('$3::int')}`;
    }
    const emp = await pool.query(`SELECT e.id FROM employees e WHERE ${empWhere}`, empParams);
    if (!emp.rows[0]) return notFound();
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
