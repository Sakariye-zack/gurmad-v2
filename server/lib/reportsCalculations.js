const { pool } = require('../db');
const { getCurrentExchangeRate } = require('./financialCalculations');
const { haversineMeters } = require('./geo');

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
  // Outstanding is reported in USD. SLSH invoices are computed natively
  // (net - SLSH paid, each USD payment converted at its own rate or the
  // current one) and then converted at the CURRENT rate; with no rate they
  // contribute 0. USD invoices keep the historical amount_usd arithmetic.
  const curRate = await getCurrentExchangeRate(client);
  const rateIdx = zoneId ? 4 : 3;
  const outstandingRes = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN i.currency = 'SLSH'
         THEN (CASE WHEN $${rateIdx}::numeric > 0 THEN (i.invoice_total - i.discount_amount - COALESCE(pp.paid_slsh, 0)) / $${rateIdx}::numeric ELSE 0 END)
         ELSE i.invoice_total - i.discount_amount - COALESCE(pp.paid, 0) END), 0) AS outstanding
     FROM invoices i JOIN customers c ON i.customer_id = c.id
     LEFT JOIN (SELECT p.invoice_id, SUM(p.amount_usd) AS paid,
                       SUM(COALESCE(p.amount_invoice_currency, CASE WHEN p.currency = 'SLSH' THEN p.amount ELSE p.amount_usd * COALESCE(er.rate, $${rateIdx}::numeric) END)) AS paid_slsh
                FROM payments p LEFT JOIN exchange_rates er ON er.id = p.exchange_rate_id
                WHERE p.status = 'recorded' GROUP BY p.invoice_id) pp ON pp.invoice_id = i.id
     WHERE i.status != 'voided' AND i.created_at >= $1 AND i.created_at < $2${zoneClause}`,
    [periodStart, periodEnd, ...(zoneId ? [zoneId] : []), curRate ? parseFloat(curRate.rate) : null]
  );
  // Debts may be SLSH (auto-debts on SLSH invoices): convert to USD at the
  // current rate; with no rate they contribute 0.
  const debtRes = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN d.currency = 'SLSH'
         THEN (CASE WHEN $${rateIdx}::numeric > 0 THEN d.amount / $${rateIdx}::numeric ELSE 0 END)
         ELSE d.amount END), 0) AS total FROM debts d LEFT JOIN customers c ON d.customer_id = c.id
     WHERE d.status = 'unpaid' AND d.created_at >= $1 AND d.created_at < $2${zoneClause}`,
    [periodStart, periodEnd, ...(zoneId ? [zoneId] : []), curRate ? parseFloat(curRate.rate) : null]
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

// Collector report (F5) extras: proof-of-service counts (F1 columns on
// batch_customers), average proof distance, first/last visit (company
// timezone; status_at is a naive TIMESTAMP stored in UTC, hence
// AT TIME ZONE 'UTC' AT TIME ZONE tz) and km driven from the phone's ping
// history (collector_location_history, kept 3 days only — older periods
// report what is still there, usually 0).
const KM_JUMP_M = 2000;
const KM_JUMP_WINDOW_S = 60;
const KM_MAX_SEGMENT_M = 5000;

// Sum of haversine distances between consecutive pings {lat, lng, t (epoch
// seconds)}, already ordered by time. A segment is GPS noise and ignored
// when it is > 2 km within 60 s, or > 5 km whatever the time gap.
function collectorDistanceKm(points) {
  let meters = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const d = haversineMeters(a, b);
    if (!Number.isFinite(d)) continue;
    const dt = Number(b.t) - Number(a.t);
    if (d > KM_MAX_SEGMENT_M) continue;
    if (d > KM_JUMP_M && dt <= KM_JUMP_WINDOW_S) continue;
    meters += d;
  }
  return meters / 1000;
}

const round2 = (x) => Math.round(x * 100) / 100;

async function companyTimezone() {
  // Lazy: autoBilling pulls in the invoice writer; keep this module's load light.
  return require('./autoBilling').getTimezone();
}

// employee id -> Map(local day 'YYYY-MM-DD' -> km), per company-local day.
async function getCollectorKmByDay({ employeeIds, periodStart, periodEnd, tz }, client = pool) {
  const out = new Map();
  if (!employeeIds || employeeIds.length === 0) return out;
  const r = await client.query(
    `SELECT employee_id, lat::float AS lat, lng::float AS lng, EXTRACT(EPOCH FROM recorded_at)::float AS t,
            to_char(recorded_at AT TIME ZONE $4::text, 'YYYY-MM-DD') AS day
     FROM collector_location_history
     WHERE employee_id = ANY($1::int[]) AND recorded_at >= $2 AND recorded_at < $3
     ORDER BY employee_id, recorded_at, id`,
    [employeeIds, periodStart, periodEnd, tz]
  );
  const tracks = new Map();
  for (const p of r.rows) {
    const key = `${p.employee_id}|${p.day}`;
    if (!tracks.has(key)) tracks.set(key, { employeeId: p.employee_id, day: p.day, points: [] });
    tracks.get(key).points.push(p);
  }
  for (const { employeeId, day, points } of tracks.values()) {
    if (!out.has(employeeId)) out.set(employeeId, new Map());
    out.get(employeeId).set(day, collectorDistanceKm(points));
  }
  return out;
}

// Collector attribution (operational only, no financial): a batch's
// customers count for every collector on one of its tasks; the period
// filters on the batch's creation time. DISTINCT in the CTE keeps a
// customer counted once even when a collector sits on several tasks of
// the same batch.
function collectorScope({ zoneId, employeeId, periodStart, periodEnd }) {
  const clauses = [`b.created_at >= $1`, `b.created_at < $2`, `tr.resource_type = 'collector'`];
  const params = [periodStart, periodEnd];
  if (zoneId) { params.push(zoneId); clauses.push(`b.zone_id = $${params.length}`); }
  if (employeeId) { params.push(employeeId); clauses.push(`tr.resource_id = $${params.length}`); }
  return { clauses, params };
}

const VISIT_AGGREGATES = (tzIdx, fmt) => `
       COUNT(cb.bc_id)::int AS assigned,
       COUNT(cb.bc_id) FILTER (WHERE cb.status = 'serviced')::int AS serviced,
       COUNT(cb.bc_id) FILTER (WHERE cb.status = 'missed')::int AS missed,
       COUNT(cb.bc_id) FILTER (WHERE cb.status = 'skipped')::int AS skipped,
       COUNT(cb.bc_id) FILTER (WHERE cb.status = 'rescheduled')::int AS rescheduled,
       COUNT(cb.bc_id) FILTER (WHERE cb.proof_flag = 'override')::int AS overrides,
       COUNT(cb.bc_id) FILTER (WHERE cb.proof_flag = 'no_customer_location')::int AS no_location,
       ROUND(AVG(cb.proof_distance_m) FILTER (WHERE cb.status = 'serviced' AND cb.proof_distance_m IS NOT NULL))::int AS avg_proof_distance_m,
       to_char((MIN(cb.status_at) FILTER (WHERE cb.status <> 'pending')) AT TIME ZONE 'UTC' AT TIME ZONE $${tzIdx}::text, '${fmt}') AS first_visit_at,
       to_char((MAX(cb.status_at) FILTER (WHERE cb.status <> 'pending')) AT TIME ZONE 'UTC' AT TIME ZONE $${tzIdx}::text, '${fmt}') AS last_visit_at`;

const completion = (r) => (r.assigned > 0 ? Math.round((r.serviced / r.assigned) * 1000) / 10 : null);

async function getCollectorPerformance({ zoneId = null, employeeId = null, periodStart, periodEnd }, client = pool) {
  const tz = await companyTimezone();
  const { clauses, params } = collectorScope({ zoneId, employeeId, periodStart, periodEnd });
  params.push(tz);
  const tzIdx = params.length;

  const res = await client.query(
    `WITH cb AS (
       SELECT DISTINCT tr.resource_id AS employee_id, b.zone_id, bc.id AS bc_id, bc.status, bc.status_at,
              bc.proof_flag, bc.proof_distance_m
       FROM task_resources tr
       JOIN tasks t ON tr.task_id = t.id
       JOIN batches b ON t.batch_id = b.id
       LEFT JOIN batch_customers bc ON bc.batch_id = b.id
       WHERE ${clauses.join(' AND ')}
     )
     SELECT cb.employee_id, e.name AS collector_name, z.name AS zone_name,${VISIT_AGGREGATES(tzIdx, 'YYYY-MM-DD HH24:MI')}
     FROM cb
     LEFT JOIN employees e ON e.id = cb.employee_id
     LEFT JOIN zones z ON z.id = cb.zone_id
     GROUP BY cb.employee_id, e.name, z.name
     ORDER BY serviced DESC, cb.employee_id ASC`,
    params
  );
  // km is per collector for the whole period (not split by zone): a
  // collector who worked two districts shows the same km on both rows.
  const ids = [...new Set(res.rows.map((r) => r.employee_id))];
  const km = await getCollectorKmByDay({ employeeIds: ids, periodStart, periodEnd, tz }, client);
  return res.rows.map((r) => {
    const days = km.get(r.employee_id);
    const total = days ? [...days.values()].reduce((s, x) => s + x, 0) : 0;
    return { ...r, km_driven: round2(total), completionRate: completion(r) };
  });
}

// Per-day drill-down for one collector. A marked visit counts on the
// company-local day it was marked; an unmarked one on its list's start day.
// Days with pings but no visits still appear (km only).
async function getCollectorDaily({ zoneId = null, employeeId, periodStart, periodEnd }, client = pool) {
  const tz = await companyTimezone();
  const { clauses, params } = collectorScope({ zoneId, employeeId, periodStart, periodEnd });
  params.push(tz);
  const tzIdx = params.length;

  const res = await client.query(
    `WITH cb AS (
       SELECT DISTINCT bc.id AS bc_id, bc.status, bc.status_at, bc.proof_flag, bc.proof_distance_m,
              to_char(CASE WHEN bc.status <> 'pending' AND bc.status_at IS NOT NULL
                             THEN (bc.status_at AT TIME ZONE 'UTC' AT TIME ZONE $${tzIdx}::text)::date
                           ELSE COALESCE(b.start_date, (b.created_at AT TIME ZONE 'UTC' AT TIME ZONE $${tzIdx}::text)::date) END,
                      'YYYY-MM-DD') AS day
       FROM task_resources tr
       JOIN tasks t ON tr.task_id = t.id
       JOIN batches b ON t.batch_id = b.id
       JOIN batch_customers bc ON bc.batch_id = b.id
       WHERE ${clauses.join(' AND ')}
     )
     SELECT cb.day,${VISIT_AGGREGATES(tzIdx, 'HH24:MI')}
     FROM cb GROUP BY cb.day ORDER BY cb.day`,
    params
  );
  const km = (await getCollectorKmByDay({ employeeIds: [employeeId], periodStart, periodEnd, tz }, client)).get(employeeId) || new Map();
  const byDay = new Map(res.rows.map((r) => [r.day, r]));
  for (const day of km.keys()) {
    if (!byDay.has(day)) {
      byDay.set(day, { day, assigned: 0, serviced: 0, missed: 0, skipped: 0, rescheduled: 0, overrides: 0, no_location: 0,
        avg_proof_distance_m: null, first_visit_at: null, last_visit_at: null });
    }
  }
  return [...byDay.values()]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .map((r) => ({ ...r, km_driven: round2(km.get(r.day) || 0), completionRate: completion(r) }));
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
    `SELECT i.id, i.invoice_number, i.invoice_total, i.currency, i.status, i.created_at, c.name AS customer_name, COALESCE(i.customer_number_snapshot, c.customer_number) AS customer_number
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
    `SELECT d.id, d.amount, d.currency, d.status, d.created_at, d.invoice_id, d.cashout_id, c.name AS customer_name
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
  getCollectorDaily, getCollectorKmByDay, collectorDistanceKm,
  getZonePerformance, getTruckPerformance, getCollectionHistory, getCollectionDetail, getInvoicesSummary, getPaymentsSummary,
  getDebtsSummary, getCashoutSummary, getFinancialSummary, toCsv,
};
