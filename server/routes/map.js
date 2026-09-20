const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Route & GIS / Map — Implementation Spec §12. New, additive, isolated
// module. Read-only projection of the CLOSED Customers/Group & Route
// tables — zero mutation, zero touch to routes/customers.js,
// routes/groups.js, or routesEntity.js. Mapbox is a rendering client
// only; this endpoint is the sole source of truth for the data it
// plots. Structurally never joins batch_customers — collection-event
// GPS (status_lat/status_lng) is a hard, out-of-band privacy boundary,
// not merely an omitted field (Spec §8/§29).
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

// GET /api/v2/map/customers
router.get('/customers', async (req, res) => {
  const { zone_id, group_id, route_id } = req.query;

  let requestedZoneId = null;
  if (zone_id !== undefined) {
    requestedZoneId = parseStrictId(zone_id);
    if (requestedZoneId === null) {
      return res.status(400).json({ error: { message: 'Invalid zone id.', code: 'VALIDATION' } });
    }
  }

  let groupId = null;
  if (group_id !== undefined) {
    groupId = parseStrictId(group_id);
    if (groupId === null) {
      return res.status(400).json({ error: { message: 'Invalid group id.', code: 'VALIDATION' } });
    }
  }

  let routeId = null;
  if (route_id !== undefined) {
    routeId = parseStrictId(route_id);
    if (routeId === null) {
      return res.status(400).json({ error: { message: 'Invalid route id.', code: 'VALIDATION' } });
    }
  }

  try {
    // Zone security (Spec §14): non-Admin roles are FORCED to their own
    // zone server-side — a forged/different zone_id is silently
    // overridden, never trusted, identical to Operational Calendar's
    // own proven pattern.
    let effectiveZoneId = requestedZoneId;
    const role = (req.user.role || '').toLowerCase();
    if (ZONE_SCOPED_ROLES.includes(role)) {
      const myZoneId = await resolveUserZoneId(req.user);
      effectiveZoneId = myZoneId; // overrides any client-supplied value, including null
      if (effectiveZoneId === null) {
        return res.json({ data: [] }); // no resolvable zone -> nothing to show, not an error
      }
    }

    const params = [];
    // Spec §9: only customers with BOTH lat and lng populated, excluding
    // the (0,0) placeholder value (never a genuine GURMAD location).
    let where = "c.status = 'active' AND c.lat IS NOT NULL AND c.lng IS NOT NULL AND NOT (c.lat = 0 AND c.lng = 0)";

    if (effectiveZoneId !== null) {
      params.push(effectiveZoneId);
      where += ` AND c.zone_id = $${params.length}`;
    }
    if (groupId !== null) {
      params.push(groupId);
      where += ` AND c.group_id = $${params.length}`;
    }
    if (routeId !== null) {
      params.push(routeId);
      where += ` AND c.route_id = $${params.length}`;
    }
    // Spec §12: a route_id whose own group_id doesn't match a supplied
    // group_id yields an empty result, not an error — no scope-existence
    // leak either way.
    if (groupId !== null && routeId !== null) {
      params.push(groupId);
      where += ` AND r.group_id = $${params.length}`;
    }

    const result = await pool.query(
      // COALESCE(name, code) — group_id (Group)/route_id (Route)'s own
      // schema has a required `code` and an OPTIONAL `name` (db.js) — the
      // Create Group/Route forms label it "Name (optional)", so a group
      // created with only a code (the common case here, confirmed live —
      // user-reported) previously showed a bare "—" in this popup despite
      // genuinely having a group/route, since the query only ever read
      // the (often-null) name column. zones.name has no such gap (NOT
      // NULL in its own schema), so it's untouched.
      `SELECT c.id, c.customer_number, c.name, c.customer_type, c.status,
              c.lat, c.lng, c.zone_id, z.name AS zone_name,
              c.group_id, COALESCE(g.name, g.code) AS group_name,
              c.route_id, COALESCE(r.name, r.code) AS route_name
       FROM customers c
       JOIN zones z ON z.id = c.zone_id
       LEFT JOIN groups g ON g.id = c.group_id
       LEFT JOIN routes r ON r.id = c.route_id
       WHERE ${where}
       ORDER BY c.id ASC`,
      params
    );

    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load map data.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/map/trucks — Phase 10, user-requested ('ilaa gawaadhidii ay
// ka soo muuqato'). Reads collector_locations (last-known-position only,
// written by POST /v2/collection-sync/location — see that route's own
// comment for the full write-side eligibility gate). Only rows recorded
// within the last 10 minutes are returned — an idle/offline collector's
// stale last position silently disappears from the map rather than
// showing a truck as "live" when it may have been parked for hours.
// Same zone-forcing pattern as GET /customers above (non-Admin roles
// cannot widen their own scope via zone_id).
const TRUCK_LOCATION_FRESHNESS_MINUTES = 10;
router.get('/trucks', async (req, res) => {
  const { zone_id } = req.query;
  let requestedZoneId = null;
  if (zone_id !== undefined) {
    requestedZoneId = parseStrictId(zone_id);
    if (requestedZoneId === null) return res.status(400).json({ error: { message: 'Invalid zone id.', code: 'VALIDATION' } });
  }
  try {
    let effectiveZoneId = requestedZoneId;
    const role = (req.user.role || '').toLowerCase();
    if (ZONE_SCOPED_ROLES.includes(role)) {
      const myZoneId = await resolveUserZoneId(req.user);
      effectiveZoneId = myZoneId;
      if (effectiveZoneId === null) return res.json({ data: [] });
    }

    const params = [];
    let where = `cl.recorded_at >= NOW() - INTERVAL '${TRUCK_LOCATION_FRESHNESS_MINUTES} minutes'`;
    if (effectiveZoneId !== null) {
      params.push(effectiveZoneId);
      where += ` AND e.zone_id = $${params.length}`;
    }

    const result = await pool.query(
      `SELECT cl.employee_id, cl.lat, cl.lng, cl.recorded_at,
              e.name AS collector_name, e.zone_id, z.name AS zone_name,
              t.id AS truck_id, t.plate_number
       FROM collector_locations cl
       JOIN employees e ON e.id = cl.employee_id
       LEFT JOIN zones z ON z.id = e.zone_id
       LEFT JOIN trucks t ON (t.driver_id = e.id OR t.collector_id = e.id) AND t.status = 'active'
       WHERE ${where}
       ORDER BY cl.employee_id ASC`,
      params
    );

    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load truck locations.', code: 'INTERNAL' } });
  }
});

module.exports = router;
