const { pool } = require('../db');

// Master Functional Completion Program — Phase 2: Fleet Management.
// Parameterized functions only, mirroring hrCalculations.js's (Phase 1)
// and reportsCalculations.js's (CLOSED, read-only reference) exact
// shape — zero calculation logic in any route file.

async function getMaintenanceCostSummary({ truckId = null, zoneId = null, periodStart, periodEnd } = {}, client = pool) {
  const params = [periodStart, periodEnd];
  const filters = [];
  if (truckId) { params.push(truckId); filters.push(`truck_id = $${params.length}`); }
  if (zoneId) { params.push(zoneId); filters.push(`zone_snapshot_id = $${params.length}`); }
  const extra = filters.length ? `AND ${filters.join(' AND ')}` : '';
  const res = await client.query(
    `SELECT COUNT(*) AS record_count, COALESCE(SUM(cost), 0) AS total_cost
     FROM truck_maintenance_records WHERE created_at >= $1 AND created_at <= $2 ${extra}`,
    params
  );
  return res.rows[0];
}

async function getFuelCostSummary({ truckId = null, zoneId = null, periodStart, periodEnd } = {}, client = pool) {
  const params = [periodStart, periodEnd];
  const filters = [];
  if (truckId) { params.push(truckId); filters.push(`truck_id = $${params.length}`); }
  if (zoneId) { params.push(zoneId); filters.push(`zone_snapshot_id = $${params.length}`); }
  const extra = filters.length ? `AND ${filters.join(' AND ')}` : '';
  const res = await client.query(
    `SELECT COUNT(*) AS record_count, COALESCE(SUM(cost), 0) AS total_cost, COALESCE(SUM(liters), 0) AS total_liters
     FROM truck_fuel_records WHERE record_date >= $1 AND record_date <= $2 ${extra}`,
    params
  );
  return res.rows[0];
}

// Spec §6. Reads only trucks' own existing expiry columns — no new
// table, no stored status. zoneId narrows to the caller's own
// already-enforced current-zone scope.
async function getExpiringDocuments({ zoneId = null, withinDays = 30 } = {}, client = pool) {
  const params = [withinDays];
  let zoneClause = '';
  if (zoneId) { params.push(zoneId); zoneClause = `AND t.zone_id = $${params.length}`; }
  const res = await client.query(
    `SELECT t.id AS truck_id, t.plate_number, t.zone_id, z.name AS zone_name, doc.document_type, doc.expiry_date,
       CASE WHEN doc.expiry_date < CURRENT_DATE THEN 'expired' ELSE 'expiring_soon' END AS status
     FROM trucks t
     LEFT JOIN zones z ON t.zone_id = z.id
     CROSS JOIN LATERAL (VALUES
       ('insurance', t.insurance_expiry),
       ('registration', t.registration_expiry),
       ('road_tax', t.road_tax_expiry)
     ) AS doc(document_type, expiry_date)
     WHERE doc.expiry_date IS NOT NULL AND doc.expiry_date <= CURRENT_DATE + ($1 || ' days')::INTERVAL ${zoneClause}
     ORDER BY doc.expiry_date ASC`,
    params
  );
  return res.rows;
}

module.exports = { getMaintenanceCostSummary, getFuelCostSummary, getExpiringDocuments };
