const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { pool, logPortalAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { authenticateCustomerPortal, issuePortalToken } = require('../middleware/customerPortalAuth');
const { getInvoiceBalance } = require('../lib/financialCalculations');
const { getCollectionHistory } = require('../lib/reportsCalculations');
const { buildInvoiceDocx } = require('../lib/documentGenerators');
const { sendPasswordResetWhatsApp } = require('../lib/whatsappService');

const router = express.Router();

const BCRYPT_ROUNDS = 12;
const FAILED_LOGIN_LOCK_THRESHOLD = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Generic responses everywhere auth-adjacent — never confirm whether a
// phone number/account exists (§8/§23 of the Implementation Spec, account
// enumeration prevention).
const GENERIC_LOGIN_FAIL = { error: { message: 'Invalid phone number or password.', code: 'AUTH_INVALID' } };
const GENERIC_RESET_RESPONSE = { data: { message: 'If an account exists for that phone number, password reset instructions have been sent via WhatsApp.' } };

function clientIp(req) {
  return req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || null;
}

function parseStrictId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  return parseInt(raw, 10);
}

// §24 — request-level rate limiting on the 3 auth routes, in addition to
// the account-level lockout below (two independent layers: this stops a
// distributed attack across many accounts from one IP; account lockout
// stops a targeted attack on one account from many IPs).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts. Please try again later.', code: 'RATE_LIMITED' } },
});

// ==================================================================
// AUTH
// ==================================================================

router.post('/auth/login', authLimiter, async (req, res) => {
  const { phone, password } = req.body || {};
  if (typeof phone !== 'string' || typeof password !== 'string' || !phone.trim() || !password) {
    return res.status(400).json({ error: { message: 'Phone number and password are required.', code: 'VALIDATION' } });
  }
  try {
    const custRes = await pool.query(
      `SELECT cpa.*, c.id AS customer_id, c.name AS customer_name
       FROM customer_portal_accounts cpa
       JOIN customers c ON c.id = cpa.customer_id
       WHERE c.phone = $1`,
      [phone.trim()]
    );
    if (custRes.rows.length === 0) {
      return res.status(401).json(GENERIC_LOGIN_FAIL);
    }
    const account = custRes.rows[0];

    if (account.locked_until && new Date(account.locked_until) > new Date()) {
      await logPortalAudit({ portalAccountId: account.id, customerId: account.customer_id, action: 'login_failed', ipAddress: clientIp(req), details: { reason: 'locked' } });
      return res.status(401).json(GENERIC_LOGIN_FAIL);
    }
    if (account.status !== 'active') {
      await logPortalAudit({ portalAccountId: account.id, customerId: account.customer_id, action: 'login_failed', ipAddress: clientIp(req), details: { reason: 'disabled' } });
      return res.status(401).json(GENERIC_LOGIN_FAIL);
    }

    const passwordOk = await bcrypt.compare(password, account.password_hash);
    if (!passwordOk) {
      const failCount = account.failed_login_count + 1;
      const lockUntil = failCount >= FAILED_LOGIN_LOCK_THRESHOLD ? new Date(Date.now() + LOCK_WINDOW_MS) : null;
      await pool.query(
        `UPDATE customer_portal_accounts SET failed_login_count = $1, locked_until = $2, updated_at = NOW() WHERE id = $3`,
        [failCount, lockUntil, account.id]
      );
      await logPortalAudit({
        portalAccountId: account.id, customerId: account.customer_id,
        action: lockUntil ? 'account_locked' : 'login_failed', ipAddress: clientIp(req),
      });
      return res.status(401).json(GENERIC_LOGIN_FAIL);
    }

    await pool.query(
      `UPDATE customer_portal_accounts SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [account.id]
    );
    await logPortalAudit({ portalAccountId: account.id, customerId: account.customer_id, action: 'login', ipAddress: clientIp(req) });

    const token = issuePortalToken({ portalAccountId: account.id, customerId: account.customer_id });
    return res.json({ data: { token, customer: { id: account.customer_id, name: account.customer_name } } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Login failed.', code: 'INTERNAL' } });
  }
});

router.post('/auth/forgot-password', authLimiter, async (req, res) => {
  const { phone } = req.body || {};
  if (typeof phone !== 'string' || !phone.trim()) {
    return res.status(400).json({ error: { message: 'Phone number is required.', code: 'VALIDATION' } });
  }
  try {
    const acctRes = await pool.query(
      `SELECT cpa.id AS portal_account_id, cpa.status, c.id AS customer_id, c.phone
       FROM customer_portal_accounts cpa JOIN customers c ON c.id = cpa.customer_id
       WHERE c.phone = $1`,
      [phone.trim()]
    );
    // Always return the generic response — never reveal whether the
    // account exists (§8/OD-6 anti-enumeration requirement).
    if (acctRes.rows.length === 0 || acctRes.rows[0].status !== 'active') {
      return res.json(GENERIC_RESET_RESPONSE);
    }
    const account = acctRes.rows[0];
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    await pool.query(
      `INSERT INTO customer_portal_password_resets (portal_account_id, token_hash, expires_at, requested_ip)
       VALUES ($1, $2, $3, $4)`,
      [account.portal_account_id, tokenHash, expiresAt, clientIp(req)]
    );
    await logPortalAudit({ portalAccountId: account.portal_account_id, customerId: account.customer_id, action: 'password_reset_requested', ipAddress: clientIp(req) });

    const resetUrl = `${process.env.CUSTOMER_PORTAL_WEB_URL || ''}/portal/reset-password?token=${rawToken}`;
    const dispatch = await sendPasswordResetWhatsApp({ toPhone: account.phone, resetToken: rawToken, resetUrl });
    if (!dispatch.dispatched) {
      // Honest logging only — never claim delivery succeeded (Implementation
      // Spec testing discipline §10 of user's approval message). The HTTP
      // response to the client stays the same generic message regardless,
      // so this failure is never leaked to the caller either (would itself
      // be an enumeration signal).
      console.warn(`[customerPortal] WhatsApp reset dispatch failed for portal account ${account.portal_account_id}: ${dispatch.error}`);
    }
    return res.json(GENERIC_RESET_RESPONSE);
  } catch (err) {
    return res.status(500).json({ error: { message: 'Request failed.', code: 'INTERNAL' } });
  }
});

router.post('/auth/reset-password', authLimiter, async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (typeof token !== 'string' || !token || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: { message: 'A valid token and a password of at least 8 characters are required.', code: 'VALIDATION' } });
  }
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const resetRes = await pool.query(
      `SELECT * FROM customer_portal_password_resets WHERE token_hash = $1`,
      [tokenHash]
    );
    if (resetRes.rows.length === 0) {
      return res.status(400).json({ error: { message: 'This reset link is invalid or has expired.', code: 'RESET_INVALID' } });
    }
    const reset = resetRes.rows[0];
    if (reset.used_at || new Date(reset.expires_at) < new Date()) {
      return res.status(400).json({ error: { message: 'This reset link is invalid or has expired.', code: 'RESET_INVALID' } });
    }
    const acctRes = await pool.query('SELECT * FROM customer_portal_accounts WHERE id = $1', [reset.portal_account_id]);
    const account = acctRes.rows[0];
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE customer_portal_accounts SET password_hash = $1, failed_login_count = 0, locked_until = NULL, updated_at = NOW() WHERE id = $2`,
        [passwordHash, account.id]
      );
      await client.query(`UPDATE customer_portal_password_resets SET used_at = NOW() WHERE id = $1`, [reset.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    await logPortalAudit({ portalAccountId: account.id, customerId: account.customer_id, action: 'password_reset_completed', ipAddress: clientIp(req) });
    return res.json({ data: { message: 'Password reset successfully. You may now log in.' } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Reset failed.', code: 'INTERNAL' } });
  }
});

// ==================================================================
// ACCOUNT ACTIVATION — staff-only (OD-5). Admin action from the existing
// Module 2 Customer Detail page. Uses STAFF auth (authenticateToken +
// requireRole), not portal auth — this route creates the portal account
// in the first place, so no portal token exists yet to authenticate with.
// ==================================================================

router.post('/accounts', authenticateToken, requireRole('admin'), async (req, res) => {
  const customerId = parseStrictId(req.body?.customer_id);
  const initialPassword = req.body?.initial_password;
  if (customerId === null) {
    return res.status(400).json({ error: { message: 'A valid customer_id is required.', code: 'VALIDATION' } });
  }
  if (typeof initialPassword !== 'string' || initialPassword.length < 8) {
    return res.status(400).json({ error: { message: 'initial_password is required and must be at least 8 characters.', code: 'VALIDATION' } });
  }
  try {
    const custRes = await pool.query('SELECT id, phone FROM customers WHERE id = $1', [customerId]);
    if (custRes.rows.length === 0) {
      return res.status(404).json({ error: { message: 'Customer not found.', code: 'NOT_FOUND' } });
    }
    const existing = await pool.query('SELECT id FROM customer_portal_accounts WHERE customer_id = $1', [customerId]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: { message: 'This customer already has a portal account.', code: 'ALREADY_EXISTS' } });
    }
    const passwordHash = await bcrypt.hash(initialPassword, BCRYPT_ROUNDS);
    const insertRes = await pool.query(
      `INSERT INTO customer_portal_accounts (customer_id, password_hash, status, activated_by)
       VALUES ($1, $2, 'active', $3) RETURNING id, customer_id, status, created_at`,
      [customerId, passwordHash, req.user.id]
    );
    await logPortalAudit({ portalAccountId: insertRes.rows[0].id, customerId, action: 'account_activated', ipAddress: clientIp(req), details: { activatedByStaffId: req.user.id } });
    return res.status(201).json({ data: insertRes.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to activate portal access.', code: 'INTERNAL' } });
  }
});

router.get('/accounts/by-customer/:customerId', authenticateToken, requireRole('admin', 'gudoomiye', 'zone_accountant'), async (req, res) => {
  const customerId = parseStrictId(req.params.customerId);
  if (customerId === null) return res.status(400).json({ error: { message: 'Invalid customer id.', code: 'VALIDATION' } });
  try {
    const r = await pool.query(
      `SELECT id, status, last_login_at, created_at FROM customer_portal_accounts WHERE customer_id = $1`,
      [customerId]
    );
    return res.json({ data: r.rows[0] || null });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load portal account.', code: 'INTERNAL' } });
  }
});

// ==================================================================
// SELF-SERVICE (all routes below: authenticateCustomerPortal, every
// query scoped by req.customerId from the verified token — §10/§12/OD-1)
// ==================================================================

router.get('/me', authenticateCustomerPortal, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, customer_number, customer_type, name, business_name, phone, alternate_phone, whatsapp,
              email, address_line, sub_zone, status, commercial_shift, collection_frequency, collection_mode, fee,
              (SELECT name FROM zones WHERE zones.id = customers.zone_id) AS zone_name
       FROM customers WHERE id = $1`,
      [req.customerId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Not found.', code: 'NOT_FOUND' } });
    return res.json({ data: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load profile.', code: 'INTERNAL' } });
  }
});

router.put('/me/password', authenticateCustomerPortal, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: { message: 'Current password and a new password of at least 8 characters are required.', code: 'VALIDATION' } });
  }
  try {
    const acctRes = await pool.query('SELECT * FROM customer_portal_accounts WHERE id = $1', [req.portalAccountId]);
    const account = acctRes.rows[0];
    const ok = await bcrypt.compare(currentPassword, account.password_hash);
    if (!ok) return res.status(401).json({ error: { message: 'Current password is incorrect.', code: 'AUTH_INVALID' } });
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query('UPDATE customer_portal_accounts SET password_hash = $1, updated_at = NOW() WHERE id = $2', [passwordHash, account.id]);
    await logPortalAudit({ portalAccountId: account.id, customerId: req.customerId, action: 'password_changed', ipAddress: clientIp(req) });
    return res.json({ data: { message: 'Password changed successfully.' } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to change password.', code: 'INTERNAL' } });
  }
});

router.get('/summary', authenticateCustomerPortal, async (req, res) => {
  try {
    const customerId = req.customerId;
    const balanceRes = await pool.query(
      `SELECT COALESCE(SUM(i.invoice_total - i.discount_amount), 0) AS billed
       FROM invoices i WHERE i.customer_id = $1 AND i.status != 'voided'`,
      [customerId]
    );
    const paidRes = await pool.query(
      `SELECT COALESCE(SUM(p.amount_usd), 0) AS paid
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE i.customer_id = $1 AND p.status = 'recorded'`,
      [customerId]
    );
    const debtRes = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS outstanding_debt FROM debts WHERE customer_id = $1 AND status = 'unpaid'`,
      [customerId]
    );
    const lastPaymentRes = await pool.query(
      `SELECT p.amount, p.currency, p.created_at FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE i.customer_id = $1 AND p.status = 'recorded' ORDER BY p.created_at DESC LIMIT 1`,
      [customerId]
    );
    const lastCollectionRes = await pool.query(
      `SELECT bc.status, bc.status_at FROM batch_customers bc WHERE bc.customer_id = $1 AND bc.status_at IS NOT NULL
       ORDER BY bc.status_at DESC LIMIT 1`,
      [customerId]
    );
    const billed = parseFloat(balanceRes.rows[0].billed);
    const paid = parseFloat(paidRes.rows[0].paid);
    return res.json({
      data: {
        outstandingInvoiceBalance: Math.max(billed - paid, 0),
        outstandingDebt: parseFloat(debtRes.rows[0].outstanding_debt),
        lastPayment: lastPaymentRes.rows[0] || null,
        lastCollection: lastCollectionRes.rows[0] || null,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load summary.', code: 'INTERNAL' } });
  }
});

router.get('/collection-history', authenticateCustomerPortal, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    // Reuses Module 8's own getCollectionHistory() rather than a new query
    // (Implementation Spec §17) — a wide period window stands in for "all
    // time" since the function requires explicit bounds.
    const rows = await getCollectionHistory({
      customerId: req.customerId,
      periodStart: '1970-01-01',
      periodEnd: new Date(Date.now() + 24 * 60 * 60 * 1000),
      limit, offset,
    });
    return res.json({ data: rows });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load collection history.', code: 'INTERNAL' } });
  }
});

router.get('/invoices', authenticateCustomerPortal, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, invoice_number, invoice_total, discount_amount, currency, status, created_at
       FROM invoices WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.customerId]
    );
    return res.json({ data: r.rows });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load invoices.', code: 'INTERNAL' } });
  }
});

// §35 ownership test: a customer requesting an invoice_id that is not
// theirs gets 404 (OD-7), never 403 — never confirms the record exists.
router.get('/invoices/:id', authenticateCustomerPortal, async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'Invoice not found.', code: 'NOT_FOUND' } });
  try {
    const r = await pool.query('SELECT * FROM invoices WHERE id = $1 AND customer_id = $2', [id, req.customerId]);
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Invoice not found.', code: 'NOT_FOUND' } });
    const balance = await getInvoiceBalance(id);
    const payments = await pool.query(
      `SELECT amount, currency, method, amount_usd, status, created_at FROM payments WHERE invoice_id = $1 AND status = 'recorded' ORDER BY created_at ASC`,
      [id]
    );
    return res.json({ data: { ...r.rows[0], balance, payments: payments.rows } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load invoice.', code: 'INTERNAL' } });
  }
});

router.get('/invoices/:id/document.docx', authenticateCustomerPortal, async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'Invoice not found.', code: 'NOT_FOUND' } });
  try {
    const invRes = await pool.query(
      `SELECT invoices.*, customers.name AS customer_name, customers.customer_number
       FROM invoices JOIN customers ON invoices.customer_id = customers.id
       WHERE invoices.id = $1 AND invoices.customer_id = $2`,
      [id, req.customerId]
    );
    if (invRes.rows.length === 0) return res.status(404).json({ error: { message: 'Invoice not found.', code: 'NOT_FOUND' } });
    const invoice = invRes.rows[0];
    const balance = await getInvoiceBalance(id);
    const payments = await pool.query(
      `SELECT amount, currency, method, amount_usd, status, created_at FROM payments WHERE invoice_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    const buffer = await buildInvoiceDocx({ ...invoice, balance, payments: payments.rows });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoice_number}.docx"`);
    return res.send(buffer);
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to generate document.', code: 'INTERNAL' } });
  }
});

router.get('/payments', authenticateCustomerPortal, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.amount, p.currency, p.method, p.amount_usd, p.status, p.created_at,
              i.invoice_number, i.id AS invoice_id
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE i.customer_id = $1 ORDER BY p.created_at DESC LIMIT 200`,
      [req.customerId]
    );
    return res.json({ data: r.rows });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load payments.', code: 'INTERNAL' } });
  }
});

router.get('/balance', authenticateCustomerPortal, async (req, res) => {
  try {
    const balanceRes = await pool.query(
      `SELECT COALESCE(SUM(i.invoice_total - i.discount_amount), 0) AS billed
       FROM invoices i WHERE i.customer_id = $1 AND i.status != 'voided'`,
      [req.customerId]
    );
    const paidRes = await pool.query(
      `SELECT COALESCE(SUM(p.amount_usd), 0) AS paid
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
       WHERE i.customer_id = $1 AND p.status = 'recorded'`,
      [req.customerId]
    );
    const debtsRes = await pool.query(
      `SELECT id, amount, currency, description, status, created_at FROM debts WHERE customer_id = $1 ORDER BY created_at DESC`,
      [req.customerId]
    );
    const billed = parseFloat(balanceRes.rows[0].billed);
    const paid = parseFloat(paidRes.rows[0].paid);
    return res.json({
      data: {
        outstandingInvoiceBalance: Math.max(billed - paid, 0),
        debts: debtsRes.rows,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load balance.', code: 'INTERNAL' } });
  }
});

module.exports = router;
