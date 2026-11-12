const { pool, logAudit } = require('../db');
const { GATEWAY_TIMEOUT_MS } = require('./zaadService');
const { createStaffNotification, logNotificationFailure } = require('./staffNotifications');

// Shared ZAAD attempt bookkeeping for BOTH push flows — the customer portal
// (POST /customer-portal/invoices/:id/pay-zaad) and staff
// (POST /payments/zaad-request). One table (portal_zaad_attempts, with a
// `source` column 'portal' | 'staff'), one partial unique index (one
// 'pending' attempt per invoice, whichever flow started it) and one
// in-process lock set, so a portal attempt and a staff attempt on the same
// invoice exclude each other.

const ZAAD_INFLIGHT = new Set(); // invoice ids with a request in flight in this process
// >= 2x the gateway timeout: a pending row older than this cannot still be in flight.
const ZAAD_STALE_MIN = Math.max(5, Math.ceil((2 * GATEWAY_TIMEOUT_MS) / 60000));
const ZAAD_UNKNOWN_BLOCK_MIN = 15;
const PORTAL_ZAAD_CHANNEL = 'portal_zaad';

const fmtAmt = (n, cur) => (cur === 'SLSH' ? `${Math.round(n).toLocaleString('en-US')} SLSH` : `$${Number(n).toFixed(2)}`);

async function finishZaadAttempt(id, status, fields = {}) {
  await pool.query(
    `UPDATE portal_zaad_attempts SET status = $2, transaction_id = $3, payment_id = $4, error_code = $5, finished_at = NOW() WHERE id = $1`,
    [id, status, fields.transactionId || null, fields.paymentId || null, fields.errorCode || null]
  ).catch(() => {});
}

async function notifyAdmins({ title, body, invoiceId }) {
  try {
    const admins = await pool.query(`SELECT id FROM v2_users WHERE role = 'admin' AND is_active = TRUE`);
    for (const a of admins.rows) {
      await createStaffNotification({ recipientId: a.id, eventType: 'payment.zaad_reconciliation', title, body, entityType: 'invoice', entityId: invoiceId });
    }
  } catch (e) {
    logNotificationFailure('portal_zaad_reconciliation', e);
  }
}

// Unknown outcome: audit + admin alert. `attempt` is a portal_zaad_attempts
// row (or the same fields) joined with invoice_number / customer_number, plus
// staff_username for staff attempts.
async function flagUnknownAttempt(attempt, reason) {
  const staff = attempt.source === 'staff';
  await logAudit({
    actorId: staff ? (attempt.staff_user_id ?? null) : null,
    actorUsername: (staff ? (attempt.staff_username || 'staff') : `portal:${attempt.customer_number}`).slice(0, 50),
    action: 'payment.zaad_reconciliation_required',
    entityType: 'invoice', entityId: attempt.invoice_id, before: null,
    after: { invoice_id: attempt.invoice_id, amount: Number(attempt.amount), currency: attempt.currency, target_phone: attempt.phone, attempt_id: attempt.id, reference: attempt.reference, channel: staff ? null : PORTAL_ZAAD_CHANNEL, source: staff ? 'staff' : 'portal', outcome: 'unknown', reason },
  }).catch(() => {});
  await notifyAdmins({
    invoiceId: attempt.invoice_id,
    title: `ZAAD payment outcome unknown — ${attempt.invoice_number}`,
    body: staff
      ? `Cashier ${attempt.staff_username || `#${attempt.staff_user_id}`} sent a ZAAD request for ${fmtAmt(attempt.amount, attempt.currency)} on invoice ${attempt.invoice_number} (customer ${attempt.customer_number}, attempt ${attempt.id}, reference ${attempt.reference}, phone ${attempt.phone}) but the result could not be confirmed (${reason}). Check the merchant account; if the money arrived, record it manually against the invoice.`
      : `Customer ${attempt.customer_number} tried to pay ${fmtAmt(attempt.amount, attempt.currency)} via ZAAD in the customer portal (attempt ${attempt.id}, reference ${attempt.reference}, phone ${attempt.phone}) but the result could not be confirmed (${reason}). Check the merchant account; if the money arrived, record it manually against the invoice.`,
  });
}

// Pending attempts older than the stale window -> unknown + alert. Runs on
// every pay request (both flows) and once at boot (index.js).
async function sweepStaleZaadAttempts() {
  const r = await pool.query(
    `UPDATE portal_zaad_attempts a SET status = 'unknown', error_code = 'STALE', finished_at = NOW()
     FROM invoices i, customers c
     WHERE a.status = 'pending' AND a.created_at < NOW() - make_interval(mins => $1)
       AND i.id = a.invoice_id AND c.id = a.customer_id
     RETURNING a.*, i.invoice_number, c.customer_number,
       (SELECT username FROM v2_users u WHERE u.id = a.staff_user_id) AS staff_username`,
    [ZAAD_STALE_MIN]
  );
  for (const row of r.rows) await flagUnknownAttempt(row, 'pending attempt went stale');
  return r.rows.length;
}

// Read-only state for the UI: is a push in flight, or is the invoice blocked
// after an unconfirmed outcome? Returns a Map invoiceId -> { in_progress, blocked_until }.
async function zaadStateFor(invoiceIds) {
  const out = new Map();
  if (!invoiceIds.length) return out;
  const r = await pool.query(
    `SELECT invoice_id,
            BOOL_OR(status = 'pending' AND created_at >= NOW() - make_interval(mins => $2)) AS in_progress,
            MAX(CASE WHEN status IN ('unknown', 'reconciliation_required')
                     THEN COALESCE(finished_at, created_at) + make_interval(mins => $3) END) AS blocked_until
     FROM portal_zaad_attempts
     WHERE invoice_id = ANY($1::int[])
       AND (status = 'pending' OR (status IN ('unknown', 'reconciliation_required') AND COALESCE(finished_at, created_at) > NOW() - make_interval(mins => $3)))
     GROUP BY invoice_id`,
    [invoiceIds, ZAAD_STALE_MIN, ZAAD_UNKNOWN_BLOCK_MIN]
  );
  for (const row of r.rows) {
    out.set(row.invoice_id, { in_progress: !!row.in_progress, blocked_until: row.blocked_until && new Date(row.blocked_until) > new Date() ? row.blocked_until : null });
  }
  return out;
}

module.exports = {
  ZAAD_INFLIGHT, ZAAD_STALE_MIN, ZAAD_UNKNOWN_BLOCK_MIN, PORTAL_ZAAD_CHANNEL, fmtAmt,
  finishZaadAttempt, notifyAdmins, flagUnknownAttempt, sweepStaleZaadAttempts, zaadStateFor,
};
