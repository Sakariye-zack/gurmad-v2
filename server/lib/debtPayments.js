// Debts V2 — REAL payments on debts.
//
// Two kinds of debt, two collection paths, one ledger (the payments table):
//
//  - Invoice-linked AUTO debts (source 'auto_invoice'): the debt mirrors the
//    true unpaid part of its invoice. Collecting it is a normal INVOICE
//    payment through routes/payments.js recordPaymentCore (collectDebt mode),
//    so the existing auto-debt sync reduces / settles the debt. Nothing here
//    records those payments; checkAutoDebtForCollection only validates.
//
//  - STANDALONE debts (invoice_id NULL): recordDebtPaymentCore below writes a
//    payments row with debt_id set and invoice_id NULL (payments_target_check
//    makes the two targets mutually exclusive). Such a row is a real payment:
//    it carries cashier_id / method / currency / amount_usd / reference_code
//    exactly like an invoice payment, so it lands in Transactions, the
//    cashier's Cashout expected figures (by cashier_id, per currency and
//    method, manual ZAAD / eDahab needing statement confirmation) and revenue.
//    ZAAD API push is NOT offered for standalone debts (the WAAFI attempt
//    guard is per invoice); ZAAD is recorded manually with its transaction
//    code, under the same unique-reference index as invoice payments.
//
// Currency rule (one rule, the invoice one): a payment is sized in the
// DEBT's currency with lib/paymentRules.sizePayment — SLSH on a USD debt
// counts at amount_usd (amt / current rate); USD on an SLSH debt counts at
// amt x current rate with the half-cent tolerance snap. That value is frozen
// on the row (amount_debt_currency). SLSH amounts are whole numbers, USD has
// at most 2 decimals (validated by the route).
const { pool } = require('../db');
const { getCurrentExchangeRate, EPSILON } = require('./financialCalculations');
const { PaymentError, sizePayment, fmtMoney } = require('./paymentRules');

const curOf = (c) => (c === 'SLSH' ? 'SLSH' : 'USD');

// Sum of recorded payments on one standalone debt, in the debt's currency.
async function debtPaidAmount(debtId, client = pool) {
  const r = await client.query(
    `SELECT COALESCE(SUM(amount_debt_currency), 0) AS paid FROM payments WHERE debt_id = $1 AND status = 'recorded'`, [debtId]);
  return parseFloat(r.rows[0].paid);
}

// Validation for collecting an auto debt through its invoice. Returns null
// when collectable, else { status, code, message }.
function checkAutoDebtForCollection(debt, invoiceId) {
  if (!debt) return { status: 404, code: 'NOT_FOUND', message: 'Debt not found.' };
  if (debt.source !== 'auto_invoice' || debt.invoice_id === null) {
    return { status: 409, code: 'NOT_AUTO_DEBT', message: 'Only an auto-tracked invoice debt can be collected through its invoice.' };
  }
  if (invoiceId !== undefined && Number(debt.invoice_id) !== Number(invoiceId)) {
    return { status: 400, code: 'VALIDATION', message: 'debt_id does not belong to this invoice.' };
  }
  if (debt.status !== 'unpaid') {
    return { status: 409, code: debt.status === 'paid' ? 'ALREADY_PAID' : 'WRITTEN_OFF', message: debt.status === 'paid' ? 'This debt is already paid.' : 'This debt is written off.' };
  }
  return null;
}

// The current auto debt of an invoice after a collection: the unpaid one if
// any is left, else the most recent one (now paid).
async function autoDebtStateForInvoice(invoiceId, client = pool) {
  const r = await client.query(
    `SELECT id, status, amount, currency FROM debts WHERE invoice_id = $1 AND source = 'auto_invoice'
     ORDER BY (status = 'unpaid') DESC, id DESC LIMIT 1`, [invoiceId]);
  const d = r.rows[0];
  if (!d) return null;
  return { id: d.id, status: d.status, currency: curOf(d.currency), remaining: d.status === 'unpaid' ? parseFloat(d.amount) : 0 };
}

// Record one REAL payment against one standalone debt. Caller owns the
// transaction and audit logging; zoneId (or null) restricts the customer.
// Lock order: debt -> customer (FOR SHARE), mirroring invoice -> customer.
async function recordDebtPaymentCore(client, user, { debtId, amt, cur, method, referenceCode, zoneId = null }) {
  if (!['cash', 'zaad', 'edahab', 'slsh'].includes(method)) {
    throw new PaymentError(400, 'VALIDATION', 'method must be one of: cash, zaad, edahab, slsh.');
  }
  const dRes = await client.query('SELECT * FROM debts WHERE id = $1 FOR UPDATE', [debtId]);
  if (dRes.rows.length === 0) throw new PaymentError(404, 'NOT_FOUND', 'Debt not found.');
  const debt = dRes.rows[0];
  if (debt.invoice_id !== null) {
    throw new PaymentError(409, 'INVOICE_LINKED', 'This debt is linked to an invoice — collect it as a payment on that invoice.');
  }
  if (debt.status === 'written_off') throw new PaymentError(409, 'WRITTEN_OFF', 'This debt is written off — no payment can be recorded on it.');
  if (debt.status === 'paid') throw new PaymentError(409, 'ALREADY_PAID', 'This debt is already paid.');

  const custRes = await client.query('SELECT zone_id FROM customers WHERE id = $1 FOR SHARE', [debt.customer_id]);
  if (zoneId !== null && custRes.rows[0]?.zone_id !== zoneId) {
    throw new PaymentError(403, 'FORBIDDEN', 'You do not have access to this debt.');
  }

  const debtCur = curOf(debt.currency);
  const currentRate = await getCurrentExchangeRate(client);
  let exchangeRateId = null;
  let amountUsd = amt;
  if (cur === 'SLSH') {
    if (!currentRate) throw new PaymentError(409, 'NO_EXCHANGE_RATE', 'No exchange rate is configured — cannot record a SLSH payment.');
    exchangeRateId = currentRate.id;
    amountUsd = amt / parseFloat(currentRate.rate);
  }

  const paid = await debtPaidAmount(debtId, client);
  const outstanding = parseFloat(debt.amount) - paid;
  if (outstanding <= EPSILON) throw new PaymentError(409, 'ALREADY_PAID', 'This debt is already fully paid.');
  const sized = sizePayment({ invCur: debtCur, cur, amt, amountUsd, outstanding, rate: debtCur === 'SLSH' ? currentRate : null });
  if (sized.error) {
    const e = sized.error;
    throw new PaymentError(e.status, e.code, e.message ||
      `Payment amount exceeds the debt's remaining balance. Remaining: ${fmtMoney(debtCur, e.outstanding)}. Attempted: ${fmtMoney(debtCur, e.attempted)}.`);
  }

  const payment = (await client.query(
    `INSERT INTO payments (invoice_id, debt_id, amount, currency, method, amount_usd, exchange_rate_id, cashier_id, reference_code, status, amount_debt_currency, conversion_rate_id, channel)
     VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,'recorded',$9,$10,NULL) RETURNING *`,
    [debtId, amt, cur, method, amountUsd, exchangeRateId, user.id ?? null, referenceCode || null, sized.aic, sized.conversionRateId]
  )).rows[0];

  const newPaid = paid + sized.aic;
  const remaining = parseFloat(debt.amount) - newPaid;
  let updated = debt;
  if (remaining <= EPSILON) {
    updated = (await client.query(
      `UPDATE debts SET status = 'paid', settled_at = NOW(), settled_by = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [user.id ?? null, debtId])).rows[0];
  } else {
    updated = (await client.query(`UPDATE debts SET updated_at = NOW() WHERE id = $1 RETURNING *`, [debtId])).rows[0];
  }
  return { payment, debtBefore: debt, debt: updated, paid: newPaid, remaining: Math.max(remaining, 0), currency: debtCur };
}

// Reverse one standalone-debt payment (payment row already locked by the
// caller). Re-opens a paid debt when its remaining balance is back above
// EPSILON; a written-off debt stays written off (warning returned).
async function reverseDebtPayment(client, user, payment, reason) {
  const dRes = await client.query('SELECT * FROM debts WHERE id = $1 FOR UPDATE', [payment.debt_id]);
  const debt = dRes.rows[0];
  const updatedPayment = (await client.query(
    `UPDATE payments SET status = 'reversed', reversed_at = NOW(), reversed_by = $1, reversed_reason = $2 WHERE id = $3 RETURNING *`,
    [user.id, reason, payment.id])).rows[0];
  const paid = await debtPaidAmount(payment.debt_id, client);
  const remaining = Math.max(parseFloat(debt.amount) - paid, 0);
  let updated = debt;
  let reopened = false;
  let warning = null;
  if (debt.status === 'paid' && remaining > EPSILON) {
    updated = (await client.query(
      `UPDATE debts SET status = 'unpaid', settled_at = NULL, settled_by = NULL, settlement_override_reason = NULL, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [debt.id])).rows[0];
    reopened = true;
  } else if (debt.status === 'written_off') {
    warning = `Debt #${debt.id} is written off; reversing this payment does not re-open it.`;
  } else {
    updated = (await client.query(`UPDATE debts SET updated_at = NOW() WHERE id = $1 RETURNING *`, [debt.id])).rows[0];
  }
  return { payment: updatedPayment, debtBefore: debt, debt: updated, remaining, reopened, warning };
}

module.exports = { debtPaidAmount, checkAutoDebtForCollection, autoDebtStateForInvoice, recordDebtPaymentCore, reverseDebtPayment };
