// Cashout V2 — the cashier's assignment panel (INFORMATION ONLY: nothing
// here feeds expected / actual / shortage). A cashier is linked to one or
// more Sub Zones (routes.cashier_user_id); "sent to the cashier" = the open
// invoices of the customers in those Sub Zones.
//
// Per invoice currency (USD, SLSH), for a period [start, end):
//   opening_due   open balance, as of `start`, of invoices issued before it
//   new_invoices  net total of invoices issued in the period
//   total_sent    opening_due + new_invoices
//   collected     this cashier's recorded, non-debt payments in the period
//                 on those invoices
//   other_channels the same by anyone else (customer portal ZAAD, other staff)
//   remaining_due current open balance of those invoices (now)
// plus `outside_area`: this cashier's payments in the period on invoices of
// customers OUTSIDE his Sub Zones.
//
// Amounts use the invoice currency with the same per-payment rule as
// financialCalculations.getInvoiceBalancesBulk (frozen amount_invoice_currency,
// else SLSH amount, else amount_usd x historical/current rate). "As of" a
// moment: an invoice counts unless voided before it; a payment counts if
// created before it and not reversed before it. Opening/remaining balances
// follow the app's balance logic (debt-marked payments close an invoice);
// collected / other channels count money only (debt-marked excluded).
const { pool } = require('../db');
const { getInvoiceBalancesBulk, getCurrentExchangeRate } = require('./financialCalculations');

const PATH_SQL = `concat_ws(' › ', NULLIF(COALESCE(g.name, g.code), ''), NULLIF(z.name, ''), NULLIF(COALESCE(gz.name, gz.code), ''), NULLIF(COALESCE(r.name, r.code), ''))`;
// Payment value in its invoice's currency ($rate = current SLSH-per-USD fallback).
const PAY_IN_INV_CUR = (rateParam) => `CASE WHEN i.currency = 'SLSH' THEN COALESCE(p.amount_invoice_currency,
      CASE WHEN p.currency = 'SLSH' THEN p.amount ELSE p.amount_usd * COALESCE(er.rate, ${rateParam}::numeric) END)
    ELSE p.amount_usd END`;

const r2 = (n) => Number(Number(n || 0).toFixed(2));
const blank = () => ({ opening_due: 0, new_invoices: 0, total_sent: 0, collected: 0, other_channels: 0, remaining_due: 0 });

async function computeAssignment(cashierId, periodStart, periodEnd, client = pool) {
  const subzones = (await client.query(
    `SELECT r.id, COALESCE(r.name, r.code) AS name, r.code, r.group_id, ${PATH_SQL} AS path,
            (SELECT COUNT(*)::int FROM customers c WHERE c.route_id = r.id AND c.status = 'active') AS customer_count
     FROM routes r JOIN groups g ON g.id = r.group_id LEFT JOIN zones z ON z.id = g.zone_id
     LEFT JOIN group_zones gz ON gz.id = r.group_zone_id
     WHERE r.cashier_user_id = $1 ORDER BY path, r.id`, [cashierId])).rows;
  const rate = await getCurrentExchangeRate(client);
  const curRate = rate ? Number(rate.rate) : null;
  const totals = { USD: blank(), SLSH: blank() };
  const routeIds = subzones.map((s) => s.id);
  const params = [routeIds, periodStart, periodEnd, curRate, cashierId];

  if (routeIds.length) {
    // Invoices "sent": issued before the end of the period, not voided before
    // the moment they are judged at.
    const inv = (await client.query(
      `SELECT i.id, CASE WHEN i.currency = 'SLSH' THEN 'SLSH' ELSE 'USD' END AS cur,
              (i.invoice_total - i.discount_amount) AS net, (i.created_at < $2) AS before_start,
              (i.status = 'voided' AND i.voided_at IS NOT NULL AND i.voided_at < $2) AS void_at_start,
              (i.status = 'voided' AND (i.voided_at IS NULL OR i.voided_at < $3)) AS void_at_end,
              COALESCE((SELECT SUM(${PAY_IN_INV_CUR('$4')}) FROM payments p LEFT JOIN exchange_rates er ON er.id = p.exchange_rate_id
                        WHERE p.invoice_id = i.id AND p.created_at < $2
                          AND (p.status = 'recorded' OR (p.reversed_at IS NOT NULL AND p.reversed_at >= $2))), 0) AS paid_before_start,
              COALESCE((SELECT SUM(${PAY_IN_INV_CUR('$4')}) FROM payments p LEFT JOIN exchange_rates er ON er.id = p.exchange_rate_id
                        WHERE p.invoice_id = i.id AND p.status = 'recorded' AND p.method <> 'debt'
                          AND p.created_at >= $2 AND p.created_at < $3 AND p.cashier_id = $5), 0) AS collected,
              COALESCE((SELECT SUM(${PAY_IN_INV_CUR('$4')}) FROM payments p LEFT JOIN exchange_rates er ON er.id = p.exchange_rate_id
                        WHERE p.invoice_id = i.id AND p.status = 'recorded' AND p.method <> 'debt'
                          AND p.created_at >= $2 AND p.created_at < $3 AND p.cashier_id IS DISTINCT FROM $5), 0) AS other_channels
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE c.route_id = ANY($1::int[]) AND i.created_at < $3`, params)).rows;
    const sentIds = [];
    for (const row of inv) {
      const t = totals[row.cur];
      const net = Number(row.net);
      if (row.before_start) {
        if (row.void_at_start) continue;
        t.opening_due += Math.max(net - Number(row.paid_before_start), 0);
      } else {
        if (row.void_at_end) continue;
        t.new_invoices += net;
      }
      t.collected += Number(row.collected);
      t.other_channels += Number(row.other_channels);
      sentIds.push(row.id);
    }
    const balances = await getInvoiceBalancesBulk(sentIds, client);
    for (const [id, b] of balances) {
      if (b.status === 'voided') continue;
      const row = inv.find((x) => x.id === id);
      totals[row.cur].remaining_due += b.outstanding;
    }
  }
  // This cashier's payments on customers outside his Sub Zones.
  const out = (await client.query(
    `SELECT CASE WHEN i.currency = 'SLSH' THEN 'SLSH' ELSE 'USD' END AS cur,
            COALESCE(SUM(${PAY_IN_INV_CUR('$4')}), 0) AS amount, COALESCE(SUM(p.amount_usd), 0) AS usd, COUNT(*)::int AS n
     FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = i.customer_id
     LEFT JOIN exchange_rates er ON er.id = p.exchange_rate_id
     WHERE p.cashier_id = $5 AND p.status = 'recorded' AND p.method <> 'debt'
       AND p.created_at >= $2 AND p.created_at < $3
       AND (c.route_id IS NULL OR NOT (c.route_id = ANY($1::int[])))
     GROUP BY 1`, params)).rows;
  const outside = { USD: 0, SLSH: 0, usd_equiv: 0, payment_count: 0 };
  for (const row of out) { outside[row.cur] = r2(row.amount); outside.usd_equiv += Number(row.usd); outside.payment_count += row.n; }
  outside.usd_equiv = r2(outside.usd_equiv);
  // Debts V2: this cashier's payments on STANDALONE debts in the period
  // (no invoice, so they belong to none of the invoice figures above), per
  // payment currency. Information only, like the rest of this panel.
  const dc = (await client.query(
    `SELECT p.currency, COALESCE(SUM(p.amount), 0) AS amount, COALESCE(SUM(p.amount_usd), 0) AS usd, COUNT(*)::int AS n
     FROM payments p
     WHERE p.cashier_id = $1 AND p.debt_id IS NOT NULL AND p.status = 'recorded' AND p.created_at >= $2 AND p.created_at < $3
     GROUP BY p.currency`, [cashierId, periodStart, periodEnd])).rows;
  const debtCollections = { USD: 0, SLSH: 0, usd_equiv: 0, payment_count: 0 };
  for (const row of dc) { const c = row.currency === 'SLSH' ? 'SLSH' : 'USD'; debtCollections[c] = r2(Number(debtCollections[c]) + Number(row.amount)); debtCollections.usd_equiv += Number(row.usd); debtCollections.payment_count += row.n; }
  debtCollections.usd_equiv = r2(debtCollections.usd_equiv);

  for (const cur of ['USD', 'SLSH']) {
    const t = totals[cur];
    for (const k of Object.keys(t)) t[k] = r2(t[k]);
    t.total_sent = r2(t.opening_due + t.new_invoices);
  }
  return {
    cashier_id: cashierId, period_start: periodStart, period_end: periodEnd, computed_at: new Date(),
    no_subzone: subzones.length === 0,
    subzones: subzones.map((s) => ({ id: s.id, name: s.name, code: s.code, group_id: s.group_id, path: s.path, customer_count: s.customer_count })),
    customer_count: subzones.reduce((a, s) => a + s.customer_count, 0),
    totals, outside_area: outside, debt_collections: debtCollections,
  };
}

module.exports = { computeAssignment };
