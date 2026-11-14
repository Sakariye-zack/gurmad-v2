// Shared payment-sizing rules — moved verbatim out of routes/payments.js so
// the invoice payment path (recordPaymentCore) and the standalone-debt
// payment path (lib/debtPayments.js) apply ONE rule set, never two copies.
const { EPSILON } = require('./financialCalculations');

// Structured, expected rejection (404/409/403/...) — distinct from an
// unexpected 500, so callers can map it straight back to the right HTTP
// status.
class PaymentError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Amount precision (finance redesign fix round): SLSH has no subunit, USD
// has cents. Returns an error message or null.
function amountPrecisionError(amt, cur) {
  if (cur === 'SLSH') return Number.isInteger(amt) ? null : 'SLSH amounts must be whole numbers.';
  return Math.abs(amt * 100 - Math.round(amt * 100)) < 1e-6 ? null : 'USD amounts can have at most 2 decimals.';
}

const SLSH_TOLERANCE_USD = 0.005; // half a cent, expressed in SLSH via the rate

const fmtMoney = (cur, n) => cur === 'SLSH' ? `${Math.round(n).toLocaleString('en-US')} SLSH` : `$${n.toFixed(2)}`;

// Size one payment in the TARGET's own currency (an invoice's, or a
// standalone debt's) and check it against the outstanding balance. A USD
// payment on an SLSH target is converted at the current rate and tolerates
// half a cent (rate x 0.005 SLSH): within that band of the outstanding it is
// accepted and SNAPPED to exactly the outstanding, so a whole-cent USD amount
// can always close an SLSH target. An SLSH payment on a USD target is sized
// by its amount_usd (amt / rate), exactly like a USD invoice.
// Returns { error } (status/code/outstanding/attempted/invCur) or
// { attempted, aic, conversionRateId }.
function sizePayment({ invCur, cur, amt, amountUsd, outstanding, rate }) {
  if (invCur !== 'SLSH') {
    if (amountUsd > outstanding + EPSILON) return { error: { status: 409, code: 'OVERPAYMENT', outstanding, attempted: amountUsd, invCur } };
    return { attempted: amountUsd, aic: amountUsd, conversionRateId: null };
  }
  if (cur === 'SLSH') {
    if (amt > outstanding + EPSILON) return { error: { status: 409, code: 'OVERPAYMENT', outstanding, attempted: amt, invCur } };
    return { attempted: amt, aic: amt, conversionRateId: null };
  }
  if (!rate) return { error: { status: 409, code: 'NO_EXCHANGE_RATE', message: 'No exchange rate is configured — cannot apply a USD payment to a SLSH invoice.' } };
  const r = parseFloat(rate.rate);
  const attempted = amt * r;
  const tol = r * SLSH_TOLERANCE_USD;
  if (attempted > outstanding + tol) return { error: { status: 409, code: 'OVERPAYMENT', outstanding, attempted, invCur } };
  const aic = attempted >= outstanding - tol ? outstanding : attempted;
  return { attempted, aic, conversionRateId: rate.id };
}

module.exports = { PaymentError, amountPrecisionError, sizePayment, fmtMoney, SLSH_TOLERANCE_USD };
