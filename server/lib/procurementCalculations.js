const { pool } = require('../db');

// Master Functional Completion Program — Phase 3: Procurement.
// Parameterized functions only, mirroring fleetCalculations.js/
// hrCalculations.js's exact shape — zero calculation logic in any
// route file.

function round2(n) {
  return Math.round(n * 100) / 100;
}

function calculatePOLineTotal(quantity, unitPrice) {
  return round2(Number(quantity) * Number(unitPrice));
}

function calculatePOTotal(items) {
  return round2(items.reduce((sum, item) => sum + calculatePOLineTotal(item.quantity, item.unit_price ?? item.unitPrice), 0));
}

async function calculateReceivedQuantity(poItemId, client = pool) {
  const res = await client.query(
    `SELECT COALESCE(SUM(quantity_received), 0) AS total FROM purchase_order_receipt_items WHERE purchase_order_item_id = $1`,
    [poItemId]
  );
  return Number(res.rows[0].total);
}

async function calculateRemainingQuantity(poItemId, orderedQuantity, client = pool) {
  const received = await calculateReceivedQuantity(poItemId, client);
  return orderedQuantity - received;
}

function calculateOverDeliveryFlag(receivedQuantity, orderedQuantity) {
  return receivedQuantity > orderedQuantity;
}

// Spec §14.1 step 10 — derives the PO's own new status from its items'
// cumulative received quantities. Never called with a status the
// caller invents; this is the sole source of 'partially_received' vs
// 'received'.
async function calculateReceiptStatus(purchaseOrderId, client = pool) {
  const items = await client.query(`SELECT id, quantity FROM purchase_order_items WHERE purchase_order_id = $1`, [purchaseOrderId]);
  let allMet = true;
  for (const item of items.rows) {
    const received = await calculateReceivedQuantity(item.id, client);
    if (received < item.quantity) { allMet = false; break; }
  }
  return allMet ? 'received' : 'partially_received';
}

// Informational only (request list/detail display) — never
// authoritative for anything downstream.
async function calculateRequestEstimatedTotal(requestId, client = pool) {
  const res = await client.query(
    `SELECT COALESCE(SUM(quantity * estimated_unit_price), 0) AS total FROM procurement_request_items WHERE procurement_request_id = $1`,
    [requestId]
  );
  return Number(res.rows[0].total);
}

async function calculateProcurementSummary({ zoneId = null, periodStart, periodEnd } = {}, client = pool) {
  const params = [periodStart, periodEnd];
  let zoneClause = '';
  if (zoneId) { params.push(zoneId); zoneClause = `AND pr.zone_id = $${params.length}`; }
  const requests = await client.query(
    `SELECT COUNT(*) AS request_count, COUNT(*) FILTER (WHERE pr.status = 'pending') AS pending_count
     FROM procurement_requests pr WHERE pr.created_at >= $1 AND pr.created_at <= $2 ${zoneClause}`,
    params
  );
  const poParams = [periodStart, periodEnd];
  let poZoneClause = '';
  if (zoneId) { poParams.push(zoneId); poZoneClause = `AND pr2.zone_id = $${poParams.length}`; }
  const orders = await client.query(
    `SELECT COUNT(*) AS po_count, COALESCE(SUM(po.total_amount), 0) AS total_value
     FROM purchase_orders po JOIN procurement_requests pr2 ON po.procurement_request_id = pr2.id
     WHERE po.created_at >= $1 AND po.created_at <= $2 ${poZoneClause}`,
    poParams
  );
  return { ...requests.rows[0], ...orders.rows[0] };
}

module.exports = {
  calculatePOLineTotal,
  calculatePOTotal,
  calculateReceivedQuantity,
  calculateRemainingQuantity,
  calculateReceiptStatus,
  calculateOverDeliveryFlag,
  calculateRequestEstimatedTotal,
  calculateProcurementSummary,
};
