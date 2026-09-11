const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { recalculateInvoiceStatus, getCurrentExchangeRate, EPSILON } = require('../lib/financialCalculations');

const router = express.Router();

// 'cashier' added (user-reported live, Phase 10) — same gap and same
// fix as invoices.js: every check in this file (GET /, POST /) already
// structurally enforces resolveUserZoneId()'s result, only the role
// list was missing 'cashier', letting them record payment on any
// customer's invoice company-wide instead of their own zone only.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'cashier'];
const VIEW_ROLES = ['admin', 'cashier', 'gudoomiye', 'zone_accountant'];
const RECORD_ROLES = ['admin', 'cashier'];
const VALID_METHODS = ['cash', 'zaad', 'edahab', 'slsh', 'debt'];

function parseStrictId(raw) {
  if (!/^\d+$/.test(raw)) return null;
  return parseInt(raw, 10);
}

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

// GET /?invoice_id=X — payment history for one invoice.
router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const invoiceId = parseStrictId(req.query.invoice_id || '');
  if (invoiceId === null) return res.status(400).json({ error: { message: 'invoice_id is required.', code: 'VALIDATION' } });
  try {
    const invRes = await pool.query('SELECT customer_id FROM invoices WHERE id = $1', [invoiceId]);
    if (invRes.rows.length === 0) return res.status(404).json({ error: { message: 'Invoice not found.', code: 'NOT_FOUND' } });
    const custRes = await pool.query('SELECT zone_id FROM customers WHERE id = $1', [invRes.rows[0].customer_id]);
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && custRes.rows[0]?.zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this invoice.', code: 'FORBIDDEN' } });
    }
    const result = await pool.query('SELECT * FROM payments WHERE invoice_id = $1 ORDER BY created_at ASC', [invoiceId]);
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load payments.', code: 'INTERNAL' } });
  }
});

// POST / — record a payment. Every financial-integrity rule from the
// approved spec lives here: row-locked invoice, balance computed inside
// the same transaction, overpayment structurally blocked, amount_usd
// captured and stored (never recomputed later).
router.post('/', authenticateToken, requireRole(...RECORD_ROLES), async (req, res) => {
  const { invoice_id, amount, currency, method, reference_code } = req.body;
  const invoiceId = parseStrictId(String(invoice_id ?? ''));
  if (invoiceId === null) return res.status(400).json({ error: { message: 'invoice_id is required.', code: 'VALIDATION' } });
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: { message: 'amount must be a positive number.', code: 'VALIDATION' } });
  const cur = (currency || 'USD').toUpperCase();
  if (!['USD', 'SLSH'].includes(cur)) return res.status(400).json({ error: { message: 'currency must be USD or SLSH.', code: 'VALIDATION' } });
  if (!VALID_METHODS.includes(method)) return res.status(400).json({ error: { message: `method must be one of: ${VALID_METHODS.join(', ')}.`, code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the invoice FIRST — deterministic lock order across every
    // Module 6 route (OD-7 / non-negotiable rule #7), so two concurrent
    // payment attempts against the same invoice can never both read a
    // stale outstanding balance.
    const invRes = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
    if (invRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Invoice not found.', code: 'NOT_FOUND' } });
    }
    const invoice = invRes.rows[0];
    if (invoice.status === 'voided') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'Cannot record a payment against a voided invoice.', code: 'CONFLICT' } });
    }
    const custRes = await client.query('SELECT zone_id FROM customers WHERE id = $1', [invoice.customer_id]);
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && custRes.rows[0]?.zone_id !== myZoneId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'You do not have access to this invoice.', code: 'FORBIDDEN' } });
    }

    let exchangeRateId = null;
    let amountUsd = amt;
    if (cur === 'SLSH') {
      const rate = await getCurrentExchangeRate(client);
      if (!rate) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message: 'No exchange rate is configured — cannot record a SLSH payment.', code: 'NO_EXCHANGE_RATE' } });
      }
      exchangeRateId = rate.id;
      amountUsd = amt / parseFloat(rate.rate);
    }

    // Outstanding balance computed INSIDE the lock, using the same
    // amount_usd-summing logic recalculateInvoiceStatus itself uses —
    // never a second, independently-derived copy.
    const paidRes = await client.query(
      `SELECT COALESCE(SUM(amount_usd), 0) AS paid FROM payments WHERE invoice_id = $1 AND status = 'recorded'`,
      [invoiceId]
    );
    const netTotal = parseFloat(invoice.invoice_total) - parseFloat(invoice.discount_amount);
    const alreadyPaid = parseFloat(paidRes.rows[0].paid);
    const outstanding = netTotal - alreadyPaid;

    if (amountUsd > outstanding + EPSILON) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: {
          message: `Payment amount exceeds outstanding balance. Outstanding: $${outstanding.toFixed(2)}. Attempted: $${amountUsd.toFixed(2)}.`,
          code: 'OVERPAYMENT',
        },
      });
    }

    const inserted = await client.query(
      `INSERT INTO payments (invoice_id, amount, currency, method, amount_usd, exchange_rate_id, cashier_id, reference_code, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'recorded') RETURNING *`,
      [invoiceId, amt, cur, method, amountUsd, exchangeRateId, req.user.id, reference_code || null]
    );
    const payment = inserted.rows[0];

    const recalculated = await recalculateInvoiceStatus(invoiceId, client);

    // Auto-track the remaining balance as a Debt — user-reported gap
    // ('qaabkeebu partial iyo debt ba u diiwaan galin karaa'). Two
    // scenarios, one rule: (a) a normal partial payment leaves a real
    // remaining balance the Debts module never reflected; (b) a payment
    // recorded with method='debt' means no actual cash changed hands —
    // recalculateInvoiceStatus (frozen, Module 6) still counts it toward
    // "paid" for invoice-closing purposes (an invoice resolved into a
    // formal receivable is the existing precedent — see cashout
    // shortages' own comment on Debts being that mechanism), so a
    // SEPARATE local sum here excludes method='debt' payments to get the
    // TRUE amount still actually owed, regardless of what the invoice's
    // own status says. One auto-tracked debt row per invoice
    // (source='auto_invoice', distinct from manually-created ones) is
    // kept in sync: created/updated while something is still owed,
    // auto-settled the moment it reaches zero. Never touches a
    // manually-created debt (source='manual').
    const trueOutstandingRes = await client.query(
      `SELECT COALESCE(SUM(amount_usd), 0) AS paid FROM payments WHERE invoice_id = $1 AND status = 'recorded' AND method != 'debt'`,
      [invoiceId]
    );
    const trueOutstanding = netTotal - parseFloat(trueOutstandingRes.rows[0].paid);
    const existingAutoDebt = await client.query(
      `SELECT * FROM debts WHERE invoice_id = $1 AND source = 'auto_invoice' AND status = 'unpaid' LIMIT 1`,
      [invoiceId]
    );
    if (trueOutstanding > EPSILON) {
      if (existingAutoDebt.rows.length > 0) {
        await client.query(`UPDATE debts SET amount = $1 WHERE id = $2`, [trueOutstanding, existingAutoDebt.rows[0].id]);
      } else {
        await client.query(
          `INSERT INTO debts (customer_id, invoice_id, amount, currency, description, status, source, created_by)
           VALUES ($1,$2,$3,'USD',$4,'unpaid','auto_invoice',$5)`,
          [invoice.customer_id, invoiceId, trueOutstanding, `Auto-tracked remaining balance on ${invoice.invoice_number}`, req.user.id]
        );
      }
    } else if (existingAutoDebt.rows.length > 0) {
      await client.query(
        `UPDATE debts SET status = 'paid', settled_at = NOW(), settled_by = $1 WHERE id = $2`,
        [req.user.id, existingAutoDebt.rows[0].id]
      );
    }

    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'payment.create', entityType: 'payment', entityId: payment.id, before: null, after: payment });
    res.status(201).json({ data: { ...payment, invoice_status: recalculated.status, outstanding: recalculated.outstanding } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to record payment.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// PUT /:id/reverse — Admin only. Preserves the original row; reversal is a
// status flip + required actor/reason/timestamp, never a DELETE.
router.put('/:id/reverse', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid payment id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'A reason is required to reverse a payment.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const payRes = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
    if (payRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Payment not found.', code: 'NOT_FOUND' } });
    }
    const payment = payRes.rows[0];
    if (payment.status === 'reversed') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'This payment is already reversed.', code: 'CONFLICT' } });
    }
    // Lock order: invoice first, then payment — consistent across every
    // Module 6 route (§11 of the Implementation Spec) to prevent a
    // deadlock between concurrent operations on the same invoice. The
    // invoice was not yet locked above, so lock it now before writing.
    // (full row, not just id — the auto-debt sync below needs
    // customer_id/invoice_total/discount_amount/invoice_number.)
    const invLockRes = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [payment.invoice_id]);
    const lockedInvoice = invLockRes.rows[0];

    const updated = await client.query(
      `UPDATE payments SET status = 'reversed', reversed_at = NOW(), reversed_by = $1, reversed_reason = $2 WHERE id = $3 RETURNING *`,
      [req.user.id, reason, id]
    );
    const recalculated = await recalculateInvoiceStatus(payment.invoice_id, client);

    // Keep the auto-tracked debt (source='auto_invoice') in sync after a
    // reversal too — same rule as POST / above, see its own comment.
    // Without this it would only self-correct on the invoice's NEXT
    // payment, leaving it stale (understated) in the meantime.
    const netTotal = parseFloat(lockedInvoice.invoice_total) - parseFloat(lockedInvoice.discount_amount);
    const trueOutstandingRes = await client.query(
      `SELECT COALESCE(SUM(amount_usd), 0) AS paid FROM payments WHERE invoice_id = $1 AND status = 'recorded' AND method != 'debt'`,
      [payment.invoice_id]
    );
    const trueOutstanding = netTotal - parseFloat(trueOutstandingRes.rows[0].paid);
    const existingAutoDebt = await client.query(
      `SELECT * FROM debts WHERE invoice_id = $1 AND source = 'auto_invoice' AND status = 'unpaid' LIMIT 1`,
      [payment.invoice_id]
    );
    if (trueOutstanding > EPSILON) {
      if (existingAutoDebt.rows.length > 0) {
        await client.query(`UPDATE debts SET amount = $1 WHERE id = $2`, [trueOutstanding, existingAutoDebt.rows[0].id]);
      } else {
        await client.query(
          `INSERT INTO debts (customer_id, invoice_id, amount, currency, description, status, source, created_by)
           VALUES ($1,$2,$3,'USD',$4,'unpaid','auto_invoice',$5)`,
          [lockedInvoice.customer_id, payment.invoice_id, trueOutstanding, `Auto-tracked remaining balance on ${lockedInvoice.invoice_number}`, req.user.id]
        );
      }
    } else if (existingAutoDebt.rows.length > 0) {
      await client.query(`UPDATE debts SET status = 'paid', settled_at = NOW(), settled_by = $1 WHERE id = $2`, [req.user.id, existingAutoDebt.rows[0].id]);
    }

    // Debt-integrity check (§6 of the Implementation Spec): a reversal
    // can move an invoice from paid back to partial/unpaid. If a linked
    // debt already shows Paid, do NOT silently revert it — surface a
    // warning and log it distinctly, so a human resolves the
    // contradiction deliberately.
    let warning = null;
    const debtRes = await client.query(`SELECT * FROM debts WHERE invoice_id = $1 AND status = 'paid'`, [payment.invoice_id]);
    if (debtRes.rows.length > 0 && recalculated.status !== 'paid') {
      warning = `Linked debt #${debtRes.rows[0].id} is marked Paid but this invoice is no longer fully paid — review its settlement.`;
      await logAudit({
        actorId: req.user.id, actorUsername: req.user.username, action: 'debt.integrity_warning',
        entityType: 'debt', entityId: debtRes.rows[0].id,
        before: { invoice_id: payment.invoice_id, invoice_status: 'paid' },
        after: { invoice_id: payment.invoice_id, invoice_status: recalculated.status, triggered_by_payment_id: id },
      });
    }

    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'payment.reverse', entityType: 'payment', entityId: id, before: payment, after: updated.rows[0] });
    const response = { data: { ...updated.rows[0], invoice_status: recalculated.status, outstanding: recalculated.outstanding } };
    if (warning) response.warnings = [warning];
    res.json(response);
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to reverse payment.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

module.exports = router;
