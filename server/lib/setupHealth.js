const { pool } = require('../db');

// Setup health — read-only checks for what keeps a Sub Zone (routes) or a
// customer off the automatic daily lists (lib/dailyLists.generate). Shared by
// GET /daily-lists/warnings and GET /dashboard/setup-health so the two never
// drift apart. Never writes; never changes generation.
//
// zoneId: null = company-wide, otherwise a district id (zones.id).

// "Group › District › Zone › Sub Zone" (same order as invoices/map).
const PATH_SQL = `concat_ws(' › ', NULLIF(COALESCE(g.name, g.code), ''), NULLIF(z.name, ''), NULLIF(COALESCE(gz.name, gz.code), ''), NULLIF(COALESCE(r.name, r.code), ''))`;

function scopeParams(zoneId, column) {
  if (zoneId === null || zoneId === undefined) return { params: [], sql: '' };
  return { params: [zoneId], sql: `AND ${column} = $1` };
}

// Active Sub Zones (in an active Group) with no work days — never on a list.
async function subzonesWithoutDays(zoneId, db = pool) {
  const s = scopeParams(zoneId, 'g.zone_id');
  return (await db.query(
    `SELECT r.id, COALESCE(r.name, r.code) AS name, r.group_id, ${PATH_SQL} AS path, COALESCE(u.full_name, u.username) AS collector_name,
            (SELECT COUNT(*)::int FROM customers c WHERE c.route_id = r.id AND c.status = 'active') AS customer_count
     FROM routes r JOIN groups g ON g.id = r.group_id JOIN zones z ON z.id = g.zone_id
     LEFT JOIN group_zones gz ON gz.id = r.group_zone_id LEFT JOIN v2_users u ON u.id = r.collector_user_id
     WHERE r.status = 'active' AND g.status = 'active' AND jsonb_array_length(COALESCE(r.work_days, '[]'::jsonb)) = 0 ${s.sql}
     ORDER BY path, r.id`, s.params)).rows;
}

// Active customers with no Sub Zone — never on a list. `limit` rows + total.
async function customersWithoutSubzone(zoneId, { limit = 500 } = {}, db = pool) {
  const s = scopeParams(zoneId, 'c.zone_id');
  const rows = limit > 0 ? (await db.query(
    `SELECT c.id, c.customer_number, c.name, c.customer_type, c.zone_id, z.name AS district_name, COALESCE(g.name, g.code) AS group_name
     FROM customers c JOIN zones z ON z.id = c.zone_id LEFT JOIN groups g ON g.id = c.group_id
     WHERE c.status = 'active' AND c.route_id IS NULL ${s.sql}
     ORDER BY c.id LIMIT ${Number(limit) | 0}`, s.params)).rows : [];
  const total = (await db.query(
    `SELECT COUNT(*)::int AS n FROM customers c WHERE c.status = 'active' AND c.route_id IS NULL ${s.sql}`, s.params)).rows[0].n;
  return { rows, total };
}

// Active customers without a map location (lat/lng).
async function customersWithoutLocation(zoneId, db = pool) {
  const s = scopeParams(zoneId, 'c.zone_id');
  return (await db.query(
    `SELECT COUNT(*)::int AS n FROM customers c WHERE c.status = 'active' AND (c.lat IS NULL OR c.lng IS NULL) ${s.sql}`, s.params)).rows[0].n;
}

// Per active Sub Zone: the setup gaps that stop or weaken its daily list.
// Mirrors lib/dailyLists.generate's own checks (collector, employee record via
// a non-archived employees.user_id, DR-7 type rules from
// lib/collectionValidation.validateDr7ForCollector) without running it.
const ISSUE_KEYS = ['no_collector', 'collector_no_employee', 'collector_type_mismatch', 'no_work_days', 'no_truck', 'no_start_point'];

async function subzoneIssues(zoneId, db = pool) {
  const s = scopeParams(zoneId, 'g.zone_id');
  const rows = (await db.query(
    `SELECT r.id AS route_id, COALESCE(r.name, r.code) AS name, r.group_id, ${PATH_SQL} AS path,
            (r.collector_user_id IS NULL) AS no_collector,
            (r.collector_user_id IS NOT NULL AND e.id IS NULL) AS collector_no_employee,
            (e.id IS NOT NULL AND EXISTS (
               SELECT 1 FROM customers c WHERE c.route_id = r.id AND c.status = 'active' AND (
                 e.employee_type IS DISTINCT FROM 'collector'
                 OR (c.customer_type = 'residential' AND e.collector_type = 'commercial')
                 OR (c.customer_type = 'commercial' AND (e.collector_type IS DISTINCT FROM 'commercial'
                     OR e.commercial_shift IS DISTINCT FROM COALESCE(c.commercial_shift, 'day')))))) AS collector_type_mismatch,
            (jsonb_array_length(COALESCE(r.work_days, '[]'::jsonb)) = 0) AS no_work_days,
            (r.truck_id IS NULL) AS no_truck,
            (r.start_lat IS NULL OR r.start_lng IS NULL) AS no_start_point
     FROM routes r JOIN groups g ON g.id = r.group_id JOIN zones z ON z.id = g.zone_id
     LEFT JOIN group_zones gz ON gz.id = r.group_zone_id
     LEFT JOIN LATERAL (SELECT id, employee_type, collector_type, commercial_shift FROM employees
                        WHERE user_id = r.collector_user_id AND status <> 'archived' ORDER BY id LIMIT 1) e ON TRUE
     WHERE r.status = 'active' AND g.status = 'active' ${s.sql}
     ORDER BY path, r.id`, s.params)).rows;
  return rows
    .map((row) => ({
      route_id: row.route_id, name: row.name, group_id: row.group_id, path: row.path,
      issues: ISSUE_KEYS.filter((k) => row[k] === true),
    }))
    .filter((row) => row.issues.length > 0);
}

async function getSetupHealth(zoneId, db = pool) {
  const [subzones, noSubzone, noLocation] = await Promise.all([
    subzoneIssues(zoneId, db),
    customersWithoutSubzone(zoneId, { limit: 0 }, db),
    customersWithoutLocation(zoneId, db),
  ]);
  const counts = Object.fromEntries(ISSUE_KEYS.map((k) => [k, subzones.filter((s) => s.issues.includes(k)).length]));
  counts.customers_without_subzone = noSubzone.total;
  counts.customers_without_location = noLocation;
  return { ...classify(counts), counts, subzones };
}

// BLOCKING gaps keep a Sub Zone / customer off the automatic daily lists;
// RECOMMENDED ones only weaken them (no truck on the list, no visit-order
// start, no map pin). "All set" depends on blocking only.
const BLOCKING_KEYS = ['no_collector', 'collector_no_employee', 'collector_type_mismatch', 'no_work_days', 'customers_without_subzone'];
const RECOMMENDED_KEYS = ['no_truck', 'no_start_point', 'customers_without_location'];

function classify(counts) {
  const pick = (keys) => keys.filter((k) => (counts[k] || 0) > 0).map((k) => ({ key: k, count: counts[k] }));
  const blocking = pick(BLOCKING_KEYS);
  return { all_set: blocking.length === 0, blocking, recommended: pick(RECOMMENDED_KEYS) };
}

function emptySetupHealth() {
  const counts = Object.fromEntries(ISSUE_KEYS.map((k) => [k, 0]));
  counts.customers_without_subzone = 0;
  counts.customers_without_location = 0;
  return { ...classify(counts), counts, subzones: [] };
}

module.exports = {
  PATH_SQL, ISSUE_KEYS, BLOCKING_KEYS, RECOMMENDED_KEYS, subzonesWithoutDays, customersWithoutSubzone, customersWithoutLocation, subzoneIssues,
  getSetupHealth, emptySetupHealth,
};
