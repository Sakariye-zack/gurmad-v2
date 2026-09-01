const { pool } = require('../db');

// Module 7 — Cashout & Cash Reconciliation. Mirrors financialCalculations.js's
// role: every reconciliation figure has exactly one authoritative computation,
// never duplicated in a route handler or the frontend. Reads Module 6's
// `payments`/`invoices` tables READ-ONLY — no write, no schema change beyond
// the one approved debts.cashout_id column (see db.js's Module 7 comment).

const EPSILON = 0.005;

// The server-authoritative "what was actually collected" figure for a
// cashier over a period — computed from real recorded payments, never
// trusted from client input. This is what "Cashout must reconcile against
// actual existing payment/collection data" means concretely.
// `asOf` (optional): when set, only payments recorded BEFORE this instant
// are considered, in addition to falling inside [periodStart, periodEnd).
// This is what makes a cashout's own reconciliation figures a true,
// unchanging historical snapshot — without it, a payment recorded AFTER
// the cashout was created but whose own timestamp happens to fall inside
// an already-closed period would silently leak into every later view of
// that cashout's document, drifting from the actual_amount that was
// physically reconciled at the time. Callers computing a NEW cashout pass
// no asOf (asOf = now, implicitly, via the live query); callers re-
// displaying an EXISTING cashout pass its own created_at.
async function computeExpectedForPeriod(cashierId, periodStart, periodEnd, client = pool, asOf = null) {
  const asOfClause = asOf ? ' AND created_at < $4' : '';
  const params = asOf ? [cashierId, periodStart, periodEnd, asOf] : [cashierId, periodStart, periodEnd];

  const totalRes = await client.query(
    `SELECT COALESCE(SUM(amount_usd), 0) AS total, COUNT(*)::int AS transaction_count
     FROM payments
     WHERE cashier_id = $1 AND status = 'recorded' AND created_at >= $2 AND created_at < $3${asOfClause}`,
    params
  );
  const customersRes = await client.query(
    `SELECT COUNT(DISTINCT i.customer_id)::int AS customer_count
     FROM payments p JOIN invoices i ON p.invoice_id = i.id
     WHERE p.cashier_id = $1 AND p.status = 'recorded' AND p.created_at >= $2 AND p.created_at < $3${asOfClause.replace(/created_at/g, 'p.created_at')}`,
    params
  );
  const methodRes = await client.query(
    `SELECT method, COALESCE(SUM(amount_usd), 0) AS total
     FROM payments
     WHERE cashier_id = $1 AND status = 'recorded' AND created_at >= $2 AND created_at < $3${asOfClause}
     GROUP BY method`,
    params
  );
  // Collection-source breakdown (residential/commercial) — only where a real
  // ID link exists (invoices.batch_customer_id -> batch_customers -> batches
  // .customer_type, Module 5's own real classification, read-only). No
  // category invented beyond what Module 5 already defines; unlinked
  // invoices (walk-ins, no collection event) bucket as 'unlinked', not a
  // silently-dropped or made-up category.
  const sourceRes = await client.query(
    `SELECT COALESCE(b.customer_type, 'unlinked') AS source, COALESCE(SUM(p.amount_usd), 0) AS total
     FROM payments p
     JOIN invoices i ON p.invoice_id = i.id
     LEFT JOIN batch_customers bc ON i.batch_customer_id = bc.id
     LEFT JOIN batches b ON bc.batch_id = b.id
     WHERE p.cashier_id = $1 AND p.status = 'recorded' AND p.created_at >= $2 AND p.created_at < $3${asOfClause.replace(/created_at/g, 'p.created_at')}
     GROUP BY COALESCE(b.customer_type, 'unlinked')`,
    params
  );
  return {
    expectedAmount: parseFloat(totalRes.rows[0].total),
    transactionCount: totalRes.rows[0].transaction_count,
    customerCount: customersRes.rows[0].customer_count,
    methodBreakdown: methodRes.rows.map((r) => ({ method: r.method, total: parseFloat(r.total) })),
    sourceBreakdown: sourceRes.rows.map((r) => ({ source: r.source, total: parseFloat(r.total) })),
  };
}

// Double-counting guard: no two non-voided cashouts for the same cashier
// may cover overlapping time. Enforced here (application-level, read+check
// inside the caller's own locked transaction), not by a payments-table
// column, per the explicit "only debts.cashout_id" scope boundary.
async function hasOverlappingCashout(cashierId, periodStart, periodEnd, client, excludeCashoutId = null) {
  const params = [cashierId, periodStart, periodEnd];
  let sql = `SELECT id FROM cashouts WHERE cashier_id = $1 AND status != 'voided' AND period_start < $3 AND period_end > $2`;
  if (excludeCashoutId) { params.push(excludeCashoutId); sql += ` AND id != $${params.length}`; }
  const r = await client.query(sql, params);
  return r.rows.length > 0;
}

module.exports = { computeExpectedForPeriod, hasOverlappingCashout, EPSILON };
