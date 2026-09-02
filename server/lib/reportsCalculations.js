const { pool } = require('../db');

// Module 8 — Reports. The ONE shared aggregation/calculation module for
// every reporting figure in V2 — Reports today, a future Dashboard later
// (per OD-2). Every function here is a pure read: no INSERT/UPDATE/DELETE
// anywhere in this file. Extensibility for future modules (OD-1): a new
// module adds its own getXPerformance() function here (or a sibling file
// it requires) and its own route — no plugin registry needed.

// ---------- Reporting periods (OD-5) ----------

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function startOfWeek(d) { const x = startOfDay(d); const day = x.getDay(); x.setDate(x.getDate() - day); return x; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function startOfQuarter(d) { const q = Math.floor(d.getMonth() / 3); return new Date(d.getFullYear(), q * 3, 1); }

// UI label is always "Quarterly", never "3 months" (exact instruction).
const PERIOD_PRESETS = ['today', 'this_week', 'this_month', 'quarterly', 'custom'];

function resolvePeriod(period, customStart, customEnd) {
  const now = new Date();
  switch (period) {
    case 'today': return { start: startOfDay(now), end: startOfDay(addDays(now, 1)) };
    case 'this_week': return { start: startOfWeek(now), end: startOfDay(addDays(now, 1)) };
    case 'this_month': return { start: startOfMonth(now), end: startOfDay(addDays(now, 1)) };
    case 'quarterly': return { start: startOfQuarter(now), end: startOfDay(addDays(now, 1)) };
    case 'custom': {
      const start = new Date(customStart);
      const end = new Date(customEnd);
      if (isNaN(start) || isNaN(end) || start >= end) return null;
      return { start, end };
    }
    default: return null;
  }
}

// ---------- Revenue (OD-2/OD-4, the ONE authoritative revenue calc) ----------

// Financial attribution only (payments.cashier_id) — never merged with
// operational (collector) attribution. See getCollectorPerformance() for
// the operational side, kept in a completely separate function/query.
async function getRevenueForPeriod({ zoneId = null, cashierId = null, periodStart, periodEnd }, client = pool) {
  const zoneClause = zoneId ? ' AND c.zone_id = $3' : '';
  const cashierIdx = zoneId ? 4 : 3;
  const cashierClause = cashierId ? ` AND p.cashier_id = $${cashierIdx}` : '';
  const params = [periodStart, periodEnd, ...(zoneId ? [zoneId] : []), ...(cashierId ? [cashierId] : [])];

  // Collected revenue: SUM of every RECORDED payment's own stored
  // amount_usd — Module 6's own historical-rate-safe mechanism, never
  // recalculated using today's exchange rate. This already correctly
  // excludes the uncollected portion of a Partial invoice (that portion
  // was never a payment row), preserving the frozen "amount - debt"
  // principle via a MORE precise mechanism, not a regression to it.
  const revenueRes = await client.query(
    `SELECT COALESCE(SUM(p.amount_usd), 0) AS collected, COUNT(*)::int AS payment_count
     FROM payments p JOIN invoices i ON p.invoice_id = i.id JOIN customers c ON i.customer_id = c.id
     WHERE p.status = 'recorded' AND p.created_at >= $1 AND p.created_at < $2${zoneClause}${cashierClause}`,
    params
  );
  const outstandingRes = await client.query(
    `SELECT COALESCE(SUM(i.invoice_total - i.discount_amount - COALESCE(pp.paid, 0)), 0) AS outstanding
     FROM invoices i JOIN customers c ON i.customer_id = c.id
     LEFT JOIN (SELECT invoice_id, SUM(amount_usd) AS paid FROM payments WHERE status = 'recorded' GROUP BY invoice_id) pp ON pp.invoice_id = i.id
     WHERE i.status != 'voided' AND i.created_at >= $1 AND i.created_at < $2${zoneClause}`,
    [periodStart, periodEnd, ...(zoneId ? [zoneId] : [])]
  );
  const debtRes = await client.query(
    `SELECT COALESCE(SUM(d.amount), 0) AS total FROM debts d LEFT JOIN customers c ON d.customer_id = c.id
     WHERE d.status = 'unpaid' AND d.created_at >= $1 AND d.created_at < $2${zoneClause}`,
    [periodStart, periodEnd, ...(zoneId ? [zoneId] : [])]
  );
  return {
    collected: parseFloat(revenueRes.rows[0].collected),
    paymentCount: revenueRes.rows[0].payment_count,
    outstanding: parseFloat(outstandingRes.rows[0].outstanding),
    debt: parseFloat(debtRes.rows[0].total),
  };
}

// ---------- A. Executive Summary ----------

async function getExecutiveSummary({ zoneId = null, periodStart, periodEnd, includeFinancial }, client = pool) {
  const zoneClause = zoneId ? ' AND zone_id = $3' : '';
  const params = [periodStart, periodEnd, ...(zoneId ? [zoneId] : [])];

  const customersRes = await client.query(
    `SELECT COUNT(*)::int AS total FROM customers WHERE status = 'active'${zoneId ? ' AND zone_id = $1' : ''}`,
    zoneId ? [zoneId] : []
  );
  const cyclesRes = await client.query(
    `SELECT COUNT(*)::int AS total FROM collection_cycles WHERE is_active = true${zoneId ? ' AND zone_id = $1' : ''}`,
    zoneId ? [zoneId] : []
  );
  // This query has no date filter (active batches are a point-in-time
  // count, not period-scoped) — so it must NOT be bound with the
  // 2-element periodStart/periodEnd params array (Postgres errors on
  // extra unused bound parameters, caught live during this pass's own
  // smoke test). Uses its own zone-only param set instead.
  const batchesRes = await client.query(
    `SELECT COUNT(*)::int AS total FROM batches WHERE status IN ('draft','assigned','in_progress')${zoneId ? ' AND zone_id = $1' : ''}`,
    zoneId ? [zoneId] : []
  );
  const progressRes = await client.query(
    `SELECT COALESCE(SUM(bp.total),0)::int AS total, COALESCE(SUM(bp.serviced),0)::int AS serviced,
       COALESCE(SUM(bp.missed),0)::int AS missed, COALESCE(SUM(bp.skipped),0)::int AS skipped,
       COALESCE(SUM(bp.rescheduled),0)::int AS rescheduled, COALESCE(SUM(bp.pending),0)::int AS pending
     FROM batch_progress bp JOIN batches b ON bp.batch_id = b.id
     WHERE b.created_at >= $1 AND b.created_at < $2${zoneClause}`,
    params
  );
  const p = progressRes.rows[0];
  const completionRate = p.total > 0 ? Math.round((p.serviced / p.total) * 1000) / 10 : null;

  const summary = {
    totalCustomers: customersRes.rows[0].total,
    activeCollectionCycles: cyclesRes.rows[0].total,
    activeBatches: batchesRes.rows[0].total,
    completionRate,
    serviced: p.serviced, missed: p.missed, skipped: p.skipped, rescheduled: p.rescheduled, pending: p.pending, totalCollectionEvents: p.total,
  };
  if (includeFinancial) {
    const revenue = await getRevenueForPeriod({ zoneId, periodStart, periodEnd }, client);
    summary.revenue = revenue;
  }
  return summary;
}

// ---------- B. Collector Performance (operational only, no financial) ----------

async function getCollectorPerformance({ zoneId = null, employeeId = null, periodStart, periodEnd }, client = pool) {
  const clauses = [`b.created_at >= $1`, `b.created_at < $2`, `tr.resource_type = 'collector'`];
  const params = [periodStart, periodEnd];
  if (zoneId) { params.push(zoneId); clauses.push(`b.zone_id = $${params.length}`); }
  if (employeeId) { params.push(employeeId); clauses.push(`tr.resource_id = $${params.length}`); }

  const res = await client.query(
    `SELECT tr.resource_id AS employee_id, e.name AS collector_name, z.name AS zone_name,
       COUNT(DISTINCT bc.id)::int AS assigned,
       COUNT(DISTINCT bc.id) FILTER (WHERE bc.status = 'serviced')::int AS serviced,
       COUNT(DISTINCT bc.id) FILTER (WHERE bc.status = 'missed')::int AS missed,
       COUNT(DISTINCT bc.id) FILTER (WHERE bc.status = 'skipped')::int AS skipped,
       COUNT(DISTINCT bc.id) FILTER (WHERE bc.status = 'rescheduled')::int AS rescheduled
     FROM task_resources tr
     JOIN tasks t ON tr.task_id = t.id
     JOIN batches b ON t.batch_id = b.id
     LEFT JOIN batch_customers bc ON bc.batch_id = b.id
     LEFT JOIN employees e ON e.id = tr.resource_id
     LEFT JOIN zones z ON z.id = b.zone_id
     WHERE ${clauses.join(' AND ')}
     GROUP BY tr.resource_id, e.name, z.name
     ORDER BY serviced DESC`,
    params
  );
  return res.rows.map((r) => ({
    ...r,
    completionRate: r.assigned > 0 ? Math.round((r.serviced / r.assigned) * 1000) / 10 : null,
  }));
}

// ---------- C. Zone Performance ----------

async function getZonePerformance({ periodStart, periodEnd, includeFinancial }, client = pool) {
  const res = await client.query(
    `SELECT z.id AS zone_id, z.name AS zone_name,
       COUNT(DISTINCT b.id)::int AS batches,
       COALESCE(SUM(bp.total),0)::int AS assigned_customers,
       COALESCE(SUM(bp.serviced),0)::int AS serviced,
       COALESCE(SUM(bp.missed),0)::int AS missed,
       COALESCE(SUM(bp.skipped),0)::int AS skipped,
       COALESCE(SUM(bp.rescheduled),0)::int AS rescheduled
     FROM zones z
     LEFT JOIN batches b ON b.zone_id = z.id AND b.created_at >= $1 AND b.created_at < $2
     LEFT JOIN batch_progress bp ON bp.batch_id = b.id
     GROUP BY z.id, z.name ORDER BY z.name`,
    [periodStart, periodEnd]
  );
  const rows = res.rows.map((r) => ({ ...r, completionRate: r.assigned_customers > 0 ? Math.round((r.serviced / r.assigned_customers) * 1000) / 10 : null }));
  if (includeFinancial) {
    for (const row of rows) {
      row.revenue = await getRevenueForPeriod({ zoneId: row.zone_id, periodStart, periodEnd }, client);
    }
  }
  return rows;
}

// ---------- D. Truck Performance ----------
// Utilization ONLY computed when trucks.capacity is actually set — never
// an invented default. Reuses the exact "load = count of customers in a
// batch this truck is on" concept Module 5's own Truck Capacity feature
// already established (computeBatchCapacity), not a new metric.

async function getTruckPerformance({ zoneId = null, truckId = null, periodStart, periodEnd }, client = pool) {
  const clauses = [`b.created_at >= $1`, `b.created_at < $2`, `tr.resource_type = 'truck'`];
  const params = [periodStart, periodEnd];
  if (zoneId) { params.push(zoneId); clauses.push(`b.zone_id = $${params.length}`); }
  if (truckId) { params.push(truckId); clauses.push(`tr.resource_id = $${params.length}`); }

  const res = await client.query(
    `SELECT tr.resource_id AS truck_id, tk.plate_number, tk.capacity, z.name AS zone_name,
       COUNT(DISTINCT bc.id)::int AS assigned_workload,
       COUNT(DISTINCT bc.id) FILTER (WHERE bc.status = 'serviced')::int AS serviced_workload
     FROM task_resources tr
     JOIN tasks t ON tr.task_id = t.id
     JOIN batches b ON t.batch_id = b.id
     LEFT JOIN batch_customers bc ON bc.batch_id = b.id AND bc.status != 'rescheduled'
     LEFT JOIN trucks tk ON tk.id = tr.resource_id
     LEFT JOIN zones z ON z.id = b.zone_id
     WHERE ${clauses.join(' AND ')}
     GROUP BY tr.resource_id, tk.plate_number, tk.capacity, z.name
     ORDER BY assigned_workload DESC`,
    params
  );
  return res.rows.map((r) => ({
    ...r,
    utilizationPercent: r.capacity != null && r.capacity > 0 ? Math.round((r.assigned_workload / r.capacity) * 1000) / 10 : null,
  }));
}

// ---------- E. Collection History ----------

async function getCollectionHistory({ zoneId = null, customerId = null, batchId = null, status = null, periodStart, periodEnd, limit = 100, offset = 0 }, client = pool) {
  const clauses = [`bc.status_at >= $1`, `bc.status_at < $2`];
  const params = [periodStart, periodEnd];
  if (zoneId) { params.push(zoneId); clauses.push(`b.zone_id = $${params.length}`); }
  if (customerId) { params.push(customerId); clauses.push(`bc.customer_id = $${params.length}`); }
  if (batchId) { params.push(batchId); clauses.push(`bc.batch_id = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`bc.status = $${params.length}`); }
  params.push(limit, offset);

  const res = await client.query(
    `SELECT bc.id, c.customer_number, c.name AS customer_name, bc.status, bc.status_at, bc.status_reason,
       b.batch_code, z.name AS zone_name
     FROM batch_customers bc
     JOIN batches b ON bc.batch_id = b.id
     JOIN customers c ON bc.customer_id = c.id
     LEFT JOIN zones z ON z.id = b.zone_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY bc.status_at DESC NULLS LAST
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.rows;
}

// Customer Portal Rebuild — Implementation Spec §10 (OD-5/Collection
// Detail). A single ownership-checked row read, reusing the exact same
// tables getCollectionHistory() already reads — no new calculation, no
// new collection-tracking mechanism. Ownership is enforced INSIDE this
// query (bc.customer_id = $2), not just by the caller, so a mismatched
// customerId returns null (the route maps that to 404) rather than ever
// assembling another customer's row. Per approved OD-A: raw
// status_lat/status_lng are deliberately NOT selected — see the route's
// own comment for the reasoning; this function structurally cannot leak
// them since it never reads them.
async function getCollectionDetail({ batchCustomerId, customerId }, client = pool) {
  const res = await client.query(
    `SELECT bc.id, bc.status, bc.status_at, bc.status_reason, bc.status_note,
            b.batch_code, b.start_date, b.end_date, z.name AS zone_name,
            (SELECT e.name FROM task_resources tr
               JOIN tasks t ON t.id = tr.task_id
               JOIN employees e ON e.id = tr.resource_id
             WHERE t.batch_id = bc.batch_id AND tr.resource_type = 'collector' LIMIT 1) AS collector_name
     FROM batch_customers bc
     JOIN batches b ON b.id = bc.batch_id
     LEFT JOIN zones z ON z.id = b.zone_id
     WHERE bc.id = $1 AND bc.customer_id = $2`,
    [batchCustomerId, customerId]
  );
  return res.rows[0] || null;
}

// ---------- F/H. Invoices / Payments / Debts summaries ----------

async function getInvoicesSummary({ zoneId = null, status = null, periodStart, periodEnd, limit = 100, offset = 0 }, client = pool) {
  const clauses = [`i.created_at >= $1`, `i.created_at < $2`];
  const params = [periodStart, periodEnd];
  if (zoneId) { params.push(zoneId); clauses.push(`c.zone_id = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`i.status = $${params.length}`); }
  params.push(limit, offset);
  const res = await client.query(
    `SELECT i.id, i.invoice_number, i.invoice_total, i.status, i.created_at, c.name AS customer_name, c.customer_number
     FROM invoices i JOIN customers c ON i.customer_id = c.id
     WHERE ${clauses.join(' AND ')} ORDER BY i.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.rows;
}

async function getPaymentsSummary({ zoneId = null, cashierId = null, periodStart, periodEnd, limit = 100, offset = 0 }, client = pool) {
  const clauses = [`p.created_at >= $1`, `p.created_at < $2`];
  const params = [periodStart, periodEnd];
  if (zoneId) { params.push(zoneId); clauses.push(`c.zone_id = $${params.length}`); }
  if (cashierId) { params.push(cashierId); clauses.push(`p.cashier_id = $${params.length}`); }
  params.push(limit, offset);
  const res = await client.query(
    `SELECT p.id, p.amount, p.currency, p.amount_usd, p.method, p.status, p.created_at, i.invoice_number, c.name AS customer_name
     FROM payments p JOIN invoices i ON p.invoice_id = i.id JOIN customers c ON i.customer_id = c.id
     WHERE ${clauses.join(' AND ')} ORDER BY p.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.rows;
}

async function getDebtsSummary({ zoneId = null, status = null, periodStart, periodEnd, limit = 100, offset = 0 }, client = pool) {
  const clauses = [`d.created_at >= $1`, `d.created_at < $2`];
  const params = [periodStart, periodEnd];
  if (zoneId) { params.push(zoneId); clauses.push(`c.zone_id = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`d.status = $${params.length}`); }
  params.push(limit, offset);
  const res = await client.query(
    `SELECT d.id, d.amount, d.status, d.created_at, d.invoice_id, d.cashout_id, c.name AS customer_name
     FROM debts d LEFT JOIN customers c ON d.customer_id = c.id
     WHERE ${clauses.join(' AND ')} ORDER BY d.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.rows;
}

// ---------- G. Cashout / Reconciliation summary ----------

async function getCashoutSummary({ zoneId = null, cashierId = null, periodStart, periodEnd }, client = pool) {
  const clauses = [`co.created_at >= $1`, `co.created_at < $2`];
  const params = [periodStart, periodEnd];
  if (zoneId) { params.push(zoneId); clauses.push(`co.zone_id = $${params.length}`); }
  if (cashierId) { params.push(cashierId); clauses.push(`co.cashier_id = $${params.length}`); }
  const res = await client.query(
    `SELECT co.id, co.cashout_number, co.status, co.expected_amount, co.actual_amount, co.shortage, co.surplus, z.name AS zone_name,
       cs.id AS shortage_record_id, cs.status AS shortage_status
     FROM cashouts co LEFT JOIN zones z ON z.id = co.zone_id LEFT JOIN cashout_shortages cs ON cs.cashout_id = co.id
     WHERE ${clauses.join(' AND ')} ORDER BY co.created_at DESC`,
    params
  );
  const totals = res.rows.reduce((acc, r) => {
    acc.expected += parseFloat(r.expected_amount); acc.actual += parseFloat(r.actual_amount);
    acc.shortage += parseFloat(r.shortage); acc.surplus += parseFloat(r.surplus);
    return acc;
  }, { expected: 0, actual: 0, shortage: 0, surplus: 0 });
  return { rows: res.rows, totals };
}

// ---------- H. Financial Summary (composes the above) ----------

async function getFinancialSummary({ zoneId = null, periodStart, periodEnd }, client = pool) {
  const revenue = await getRevenueForPeriod({ zoneId, periodStart, periodEnd }, client);
  const cashout = await getCashoutSummary({ zoneId, periodStart, periodEnd }, client);
  return { revenue, cashoutTotals: cashout.totals };
}

// ---------- CSV export helper ----------

function toCsv(rows, columns) {
  const header = columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => {
      const v = row[c.key];
      const s = v == null ? '' : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    }).join(',')
  );
  return [header, ...lines].join('\r\n');
}

module.exports = {
  PERIOD_PRESETS, resolvePeriod, getRevenueForPeriod, getExecutiveSummary, getCollectorPerformance,
  getZonePerformance, getTruckPerformance, getCollectionHistory, getCollectionDetail, getInvoicesSummary, getPaymentsSummary,
  getDebtsSummary, getCashoutSummary, getFinancialSummary, toCsv,
};
