const { pool } = require('../db');

// Module 6 — Financial Billing Foundation. Mirrors collectionValidation.js's
// established role as Module 5's one shared calculation module: every
// financial fact has exactly ONE authoritative place it is computed, never
// duplicated in a route handler or the frontend (non-negotiable per the
// approved Implementation Spec).

const EPSILON = 0.005; // float-safety tolerance, reused from the reference
                        // system's own established Paid/Partial/Unpaid epsilon.

// The ONLY function permitted to write invoices.status anywhere in this
// codebase. Called from exactly 2 places: end of payment-creation, end of
// payment-reversal. Never called from an invoice route directly, and never
// called on an already-voided invoice (void is its own explicit action,
// checked/short-circuited by callers before this runs).
async function recalculateInvoiceStatus(invoiceId, client) {
  const invRes = await client.query(
    'SELECT invoice_total, discount_amount, status FROM invoices WHERE id = $1 FOR UPDATE',
    [invoiceId]
  );
  if (invRes.rows.length === 0) return null;
  const inv = invRes.rows[0];
  if (inv.status === 'voided') return { status: 'voided', paid: null, outstanding: null };

  const paidRes = await client.query(
    `SELECT COALESCE(SUM(amount_usd), 0) AS paid FROM payments WHERE invoice_id = $1 AND status = 'recorded'`,
    [invoiceId]
  );
  const netTotal = parseFloat(inv.invoice_total) - parseFloat(inv.discount_amount);
  const paid = parseFloat(paidRes.rows[0].paid);
  const status = paid >= netTotal - EPSILON ? 'paid' : (paid > EPSILON ? 'partial' : 'unpaid');
  const outstanding = Math.max(netTotal - paid, 0);

  await client.query('UPDATE invoices SET status = $1, updated_at = NOW() WHERE id = $2', [status, invoiceId]);
  return { status, paid, outstanding, netTotal };
}

// Read-only outstanding-balance computation, used by callers that need the
// figure WITHOUT taking a write lock (e.g. a debt-settlement check reading
// the linked invoice's current state). For any caller about to WRITE
// (record/reverse a payment), use recalculateInvoiceStatus instead, which
// takes the FOR UPDATE lock itself.
async function getInvoiceBalance(invoiceId, client = pool) {
  const invRes = await client.query('SELECT invoice_total, discount_amount, status FROM invoices WHERE id = $1', [invoiceId]);
  if (invRes.rows.length === 0) return null;
  const inv = invRes.rows[0];
  const paidRes = await client.query(
    `SELECT COALESCE(SUM(amount_usd), 0) AS paid FROM payments WHERE invoice_id = $1 AND status = 'recorded'`,
    [invoiceId]
  );
  const netTotal = parseFloat(inv.invoice_total) - parseFloat(inv.discount_amount);
  const paid = parseFloat(paidRes.rows[0].paid);
  return { status: inv.status, paid, outstanding: Math.max(netTotal - paid, 0), netTotal };
}

// The single currently-effective exchange rate (OD-3): the row with the
// latest effective_from <= now. Never re-reads for a historical payment —
// only ever called when recording a NEW payment.
async function getCurrentExchangeRate(client = pool) {
  const r = await client.query(
    `SELECT id, rate FROM exchange_rates WHERE effective_from <= NOW() ORDER BY effective_from DESC LIMIT 1`
  );
  return r.rows[0] || null;
}

module.exports = { recalculateInvoiceStatus, getInvoiceBalance, getCurrentExchangeRate, EPSILON };
