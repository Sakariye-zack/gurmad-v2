const { pool } = require('../db');

// Module 6 â€” Financial Billing Foundation. Mirrors collectionValidation.js's
// established role as Module 5's one shared calculation module: every
// financial fact has exactly ONE authoritative place it is computed, never
// duplicated in a route handler or the frontend (non-negotiable per the
// approved Implementation Spec).

const EPSILON = 0.005; // float-safety tolerance, reused from the reference
                        // system's own established Paid/Partial/Unpaid epsilon.

// Sum of recorded payments on an invoice, expressed in the INVOICE'S OWN
// currency.
//  - USD invoice: SUM(amount_usd) — byte-for-byte the historical behaviour.
//  - SLSH invoice: SLSH payments count at their own face amount; USD
//    payments (and any other non-SLSH row) are converted amount_usd x rate,
//    where rate is the payment's own exchange_rate_id rate if it stored one,
//    else the CURRENT rate (rate argument, fetched if omitted). With no rate
//    at all, those payments contribute 0 (never throws).
// excludeDebt drops method='debt' rows (used for the true-outstanding sync).
async function paidInInvoiceCurrency(invoiceId, currency, client = pool, { excludeDebt = false, rate } = {}) {
  const debtClause = excludeDebt ? " AND p.method != 'debt'" : '';
  if (currency !== 'SLSH') {
    const r = await client.query(
      `SELECT COALESCE(SUM(p.amount_usd), 0) AS paid FROM payments p WHERE p.invoice_id = $1 AND p.status = 'recorded'${debtClause}`,
      [invoiceId]
    );
    return parseFloat(r.rows[0].paid);
  }
  if (rate === undefined) rate = await getCurrentExchangeRate(client);
  const curRate = rate ? parseFloat(rate.rate) : null;
  const r = await client.query(
    `SELECT COALESCE(SUM(CASE WHEN p.currency = 'SLSH' THEN p.amount
                              ELSE p.amount_usd * COALESCE(er.rate, $2::numeric) END), 0) AS paid
     FROM payments p LEFT JOIN exchange_rates er ON er.id = p.exchange_rate_id
     WHERE p.invoice_id = $1 AND p.status = 'recorded'${debtClause}`,
    [invoiceId, curRate]
  );
  return parseFloat(r.rows[0].paid);
}

// Dual-currency view of a balance. Convention: every figure is computed in the
// invoice's own currency first; the OTHER currency is that figure converted at
// the CURRENT rate (USD = slsh / rate, SLSH = usd x rate) — one consistent
// rule, so usd.paid for an SLSH invoice is paidSLSH / current rate (not the
// sum of stored amount_usd). No rate => the other-currency block is null.
function dualBlocks(currency, paid, outstanding, netTotal, rate) {
  const r = rate ? parseFloat(rate.rate) : null;
  const own = { paid, outstanding, netTotal };
  let other = null;
  if (r && r > 0) {
    const f = currency === 'SLSH' ? (x) => x / r : (x) => x * r;
    other = { paid: f(paid), outstanding: f(outstanding), netTotal: f(netTotal) };
  }
  return {
    usd: currency === 'SLSH' ? other : own,
    slsh: currency === 'SLSH' ? own : other,
    rate: rate ? { id: rate.id, rate: r, effective_from: rate.effective_from } : null,
  };
}

// The ONLY function permitted to write invoices.status anywhere in this
// codebase. Called from exactly 2 places: end of payment-creation, end of
// payment-reversal. Never called from an invoice route directly, and never
// called on an already-voided invoice (void is its own explicit action,
// checked/short-circuited by callers before this runs).
async function recalculateInvoiceStatus(invoiceId, client) {
  const invRes = await client.query(
    'SELECT invoice_total, discount_amount, status, currency FROM invoices WHERE id = $1 FOR UPDATE',
    [invoiceId]
  );
  if (invRes.rows.length === 0) return null;
  const inv = invRes.rows[0];
  if (inv.status === 'voided') return { status: 'voided', paid: null, outstanding: null };

  const currency = inv.currency === 'SLSH' ? 'SLSH' : 'USD';
  const netTotal = parseFloat(inv.invoice_total) - parseFloat(inv.discount_amount);
  const paid = await paidInInvoiceCurrency(invoiceId, currency, client);
  const status = paid >= netTotal - EPSILON ? 'paid' : (paid > EPSILON ? 'partial' : 'unpaid');
  const outstanding = Math.max(netTotal - paid, 0);

  await client.query('UPDATE invoices SET status = $1, updated_at = NOW() WHERE id = $2', [status, invoiceId]);
  return { status, paid, outstanding, netTotal, currency };
}

// Read-only outstanding-balance computation, used by callers that need the
// figure WITHOUT taking a write lock (e.g. a debt-settlement check reading
// the linked invoice's current state). For any caller about to WRITE
// (record/reverse a payment), use recalculateInvoiceStatus instead, which
// takes the FOR UPDATE lock itself.
// Returns { status, currency, paid, outstanding, netTotal } in the invoice's
// own currency, plus usd / slsh blocks and the rate used (see dualBlocks).
async function getInvoiceBalance(invoiceId, client = pool) {
  const invRes = await client.query('SELECT invoice_total, discount_amount, status, currency FROM invoices WHERE id = $1', [invoiceId]);
  if (invRes.rows.length === 0) return null;
  const inv = invRes.rows[0];
  const currency = inv.currency === 'SLSH' ? 'SLSH' : 'USD';
  const rate = await getCurrentExchangeRate(client);
  const netTotal = parseFloat(inv.invoice_total) - parseFloat(inv.discount_amount);
  const paid = await paidInInvoiceCurrency(invoiceId, currency, client, { rate });
  const outstanding = Math.max(netTotal - paid, 0);
  return { status: inv.status, currency, paid, outstanding, netTotal, ...dualBlocks(currency, paid, outstanding, netTotal, rate) };
}

// The single currently-effective exchange rate (OD-3): the row with the
// latest effective_from <= now. Never re-reads for a historical payment â€”
// only ever called when recording a NEW payment.
async function getCurrentExchangeRate(client = pool) {
  const r = await client.query(
    `SELECT id, rate, effective_from FROM exchange_rates WHERE effective_from <= NOW() ORDER BY effective_from DESC LIMIT 1`
  );
  return r.rows[0] || null;
}

module.exports = { recalculateInvoiceStatus, getInvoiceBalance, getCurrentExchangeRate, paidInInvoiceCurrency, dualBlocks, EPSILON };
