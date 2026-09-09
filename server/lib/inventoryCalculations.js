const { pool } = require('../db');

// Master Functional Completion Program — Phase 4: Inventory & Assets.
// Parameterized functions only, mirroring procurementCalculations.js/
// fleetCalculations.js's exact shape — zero calculation logic in any
// route file. No mutable balance column exists anywhere; every figure
// here is derived from inventory_movements at call time.

async function calculateStockBalance(itemId, storeId, client = pool) {
  const res = await client.query(
    `SELECT COALESCE(SUM(quantity), 0) AS balance FROM inventory_movements WHERE item_id = $1 AND store_id = $2`,
    [itemId, storeId]
  );
  return Number(res.rows[0].balance);
}

// No reserved-quantity concept (Decisions §10) — available == balance.
async function calculateAvailableQuantity(itemId, storeId, client = pool) {
  return calculateStockBalance(itemId, storeId, client);
}

async function calculateLowStock({ zoneId = null } = {}, client = pool) {
  const params = [];
  let zoneClause = '';
  if (zoneId) { params.push(zoneId); zoneClause = `AND s.zone_id = $${params.length}`; }
  const res = await client.query(
    `SELECT i.id AS item_id, i.name, i.reorder_level, s.id AS store_id, s.name AS store_name,
       COALESCE(SUM(m.quantity), 0) AS balance
     FROM inventory_items i
     JOIN inventory_movements m ON m.item_id = i.id
     JOIN inventory_stores s ON m.store_id = s.id
     WHERE i.reorder_level IS NOT NULL ${zoneClause}
     GROUP BY i.id, i.name, i.reorder_level, s.id, s.name
     HAVING COALESCE(SUM(m.quantity), 0) < i.reorder_level`,
    params
  );
  return res.rows;
}

async function calculateMovementTotals({ itemId = null, storeId = null, movementType = null, periodStart, periodEnd } = {}, client = pool) {
  const params = [periodStart, periodEnd];
  const filters = [];
  if (itemId) { params.push(itemId); filters.push(`item_id = $${params.length}`); }
  if (storeId) { params.push(storeId); filters.push(`store_id = $${params.length}`); }
  if (movementType) { params.push(movementType); filters.push(`movement_type = $${params.length}`); }
  const extra = filters.length ? `AND ${filters.join(' AND ')}` : '';
  const res = await client.query(
    `SELECT movement_type, COUNT(*) AS count, SUM(quantity) AS total_quantity
     FROM inventory_movements WHERE created_at >= $1 AND created_at <= $2 ${extra}
     GROUP BY movement_type`,
    params
  );
  return res.rows;
}

async function calculateStoreStock(storeId, client = pool) {
  const res = await client.query(
    `SELECT i.id AS item_id, i.name, i.unit_of_measure, COALESCE(SUM(m.quantity), 0) AS balance
     FROM inventory_movements m JOIN inventory_items i ON m.item_id = i.id
     WHERE m.store_id = $1 GROUP BY i.id, i.name, i.unit_of_measure ORDER BY i.name`,
    [storeId]
  );
  return res.rows;
}

async function calculateItemStock(itemId, client = pool) {
  const perStore = await client.query(
    `SELECT s.id AS store_id, s.name AS store_name, COALESCE(SUM(m.quantity), 0) AS balance
     FROM inventory_movements m JOIN inventory_stores s ON m.store_id = s.id
     WHERE m.item_id = $1 GROUP BY s.id, s.name ORDER BY s.name`,
    [itemId]
  );
  const total = perStore.rows.reduce((sum, r) => sum + Number(r.balance), 0);
  return { per_store: perStore.rows, total_balance: total };
}

async function calculateAssetSummary({ zoneId = null } = {}, client = pool) {
  const params = [];
  let zoneClause = '';
  if (zoneId) { params.push(zoneId); zoneClause = `WHERE zone_id = $${params.length}`; }
  const res = await client.query(`SELECT status, COUNT(*) AS count FROM asset_register ${zoneClause} GROUP BY status`, params);
  return res.rows;
}

async function calculateInventorySummary({ zoneId = null } = {}, client = pool) {
  const itemCount = await client.query('SELECT COUNT(*) AS count FROM inventory_items');
  const lowStock = await calculateLowStock({ zoneId }, client);
  const params = [];
  let zoneClause = '';
  if (zoneId) { params.push(zoneId); zoneClause = `AND s.zone_id = $${params.length}`; }
  const movementCount = await client.query(
    `SELECT COUNT(*) AS count FROM inventory_movements m JOIN inventory_stores s ON m.store_id = s.id
     WHERE m.created_at >= CURRENT_DATE - INTERVAL '30 days' ${zoneClause}`,
    params
  );
  return { item_count: Number(itemCount.rows[0].count), low_stock_count: lowStock.length, movement_count_30d: Number(movementCount.rows[0].count) };
}

module.exports = {
  calculateStockBalance,
  calculateAvailableQuantity,
  calculateLowStock,
  calculateMovementTotals,
  calculateStoreStock,
  calculateItemStock,
  calculateAssetSummary,
  calculateInventorySummary,
};
