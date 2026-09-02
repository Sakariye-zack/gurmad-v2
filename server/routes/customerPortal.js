const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { pool, logPortalAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { authenticateCustomerPortal, issuePortalToken } = require('../middleware/customerPortalAuth');
const { getInvoiceBalance } = require('../lib/financialCalculations');
const { getCollectionHistory, getCollectionDetail } = require('../lib/reportsCalculations');
const { buildInvoiceDocx, buildInvoiceHtml } = require('../lib/documentGenerators');
const { sendPasswordResetWhatsApp } = require('../lib/whatsappService');
// createPortalNotification is intentionally NOT imported here — per the
// Rebuild Implementation Spec §8, no live producer is wired in during this
// pass (the only named producer, Complaints, does not exist in V2 yet).
// The write function lives in lib/portalNotifications.js, ready for a
// future producer to import.

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

    // token_version is NOT bumped on login (Rebuild Spec §6) — a new login
    // from a different device is not itself a compromise signal and must
    // not invalidate other still-legitimate sessions. The token simply
    // embeds the account's current version as of issue time.
    const token = issuePortalToken({ portalAccountId: account.id, customerId: account.customer_id, tokenVersion: account.token_version });
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
      // token_version bumped here too (Rebuild Spec §6) — a password reset
      // is exactly the "security compromise response" scenario: the new
      // password AND every session issued under the old one are both
      // invalidated together, not just the password.
      await client.query(
        `UPDATE customer_portal_accounts SET password_hash = $1, failed_login_count = 0, locked_until = NULL, token_version = token_version + 1, updated_at = NOW() WHERE id = $2`,
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

// Disable / re-enable — same authorization boundary already approved for
// activation itself (admin-only, §"accounts" route above): this is the
// same class of administrative control over a portal account, not a new
// decision. Reversible, additive-only (touches only
// customer_portal_accounts.status), does not delete the account, the
// customer, or any financial/operational history. Hardening pass —
// approved via the user's "Portal Account Disable Gap" instruction.
router.put('/accounts/:id/disable', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid account id.', code: 'VALIDATION' } });
  try {
    // token_version bumped on disable too (Rebuild Spec §6/OD-3) — closes
    // the exact gap OD-3 named: disabling previously only blocked FUTURE
    // logins, leaving an already-issued token valid for its full 24h.
    const r = await pool.query(
      `UPDATE customer_portal_accounts SET status = 'disabled', token_version = token_version + 1, updated_at = NOW() WHERE id = $1 RETURNING id, customer_id, status`,
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Portal account not found.', code: 'NOT_FOUND' } });
    await logPortalAudit({ portalAccountId: id, customerId: r.rows[0].customer_id, action: 'account_disabled', ipAddress: clientIp(req), details: { disabledByStaffId: req.user.id } });
    return res.json({ data: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to disable portal access.', code: 'INTERNAL' } });
  }
});

router.put('/accounts/:id/enable', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid account id.', code: 'VALIDATION' } });
  try {
    const r = await pool.query(
      `UPDATE customer_portal_accounts SET status = 'active', failed_login_count = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1 RETURNING id, customer_id, status`,
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Portal account not found.', code: 'NOT_FOUND' } });
    await logPortalAudit({ portalAccountId: id, customerId: r.rows[0].customer_id, action: 'account_reenabled', ipAddress: clientIp(req), details: { reenabledByStaffId: req.user.id } });
    return res.json({ data: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to re-enable portal access.', code: 'INTERNAL' } });
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
    // token_version bumped on password change (Rebuild Spec §6) — every
    // OTHER session dies immediately. Since token_version has no per-device
    // concept (it's a single account-wide counter), bumping it would also
    // invalidate the token this very request authenticated with — so a
    // fresh token (embedding the new version) is issued and returned here,
    // keeping the CURRENT device seamlessly logged in while every other
    // already-issued token fails its next use. This is what makes the
    // "you stay logged in here, other devices need to log in again" UI
    // copy (§21) actually true rather than contradicted by the mechanism.
    const updated = await pool.query(
      'UPDATE customer_portal_accounts SET password_hash = $1, token_version = token_version + 1, updated_at = NOW() WHERE id = $2 RETURNING token_version',
      [passwordHash, account.id]
    );
    await logPortalAudit({ portalAccountId: account.id, customerId: req.customerId, action: 'password_changed', ipAddress: clientIp(req) });
    const newToken = issuePortalToken({ portalAccountId: account.id, customerId: req.customerId, tokenVersion: updated.rows[0].token_version });
    return res.json({ data: { message: 'Password changed successfully.', token: newToken } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to change password.', code: 'INTERNAL' } });
  }
});

// "Log out of all devices" — the concrete customer-initiated security
// compromise response named in the approved scope (Rebuild Spec §6/§21).
// Bumps token_version; the CURRENT request's own token dies along with
// every other one (correct here — the customer explicitly asked to end
// every session, including this one).
router.post('/me/revoke-sessions', authenticateCustomerPortal, async (req, res) => {
  try {
    await pool.query('UPDATE customer_portal_accounts SET token_version = token_version + 1, updated_at = NOW() WHERE id = $1', [req.portalAccountId]);
    await logPortalAudit({ portalAccountId: req.portalAccountId, customerId: req.customerId, action: 'sessions_revoked', ipAddress: clientIp(req) });
    return res.json({ data: { message: 'You have been logged out of all devices.' } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to revoke sessions.', code: 'INTERNAL' } });
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

// Collection Detail (OD-5/Rebuild Spec §10). Ownership enforced INSIDE
// getCollectionDetail() (bc.customer_id = $2) — a cross-customer id
// returns null here, mapped to the same 404 every other detail route
// uses. Per approved OD-A, raw GPS (status_lat/status_lng) is never
// selected by getCollectionDetail() in the first place — there is no
// hidden field to accidentally leak; it structurally cannot happen.
router.get('/collection-history/:id', authenticateCustomerPortal, async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'Collection event not found.', code: 'NOT_FOUND' } });
  try {
    const detail = await getCollectionDetail({ batchCustomerId: id, customerId: req.customerId });
    if (!detail) return res.status(404).json({ error: { message: 'Collection event not found.', code: 'NOT_FOUND' } });
    return res.json({ data: detail });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load collection detail.', code: 'INTERNAL' } });
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

// Invoice inline preview (OD-5/Rebuild Spec §11) — HTML twin of the same
// data the .docx route above assembles, same ownership check verbatim
// (invoices.customer_id = $2), same 404-not-403 cross-customer behavior.
router.get('/invoices/:id/preview', authenticateCustomerPortal, async (req, res) => {
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
    const html = buildInvoiceHtml({ ...invoice, balance, payments: payments.rows });
    return res.json({ data: { html } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to generate preview.', code: 'INTERNAL' } });
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

// ==================================================================
// NOTIFICATIONS (Decision Record OD-2 / Rebuild Spec §8 — infrastructure
// built now, zero live producer wired in yet). Ordinary reads here are
// NOT audited (Decision Record §7 — "avoid audit noise"); marking a
// notification read is likewise not audited, matching the Decision
// Record's own explicit example of what NOT to log.
// ==================================================================

router.get('/notifications', authenticateCustomerPortal, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const r = await pool.query(
      `SELECT id, type, title, body, action_type, action_id, is_read, read_at, created_at
       FROM customer_portal_notifications WHERE customer_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.customerId, limit, offset]
    );
    return res.json({ data: r.rows });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load notifications.', code: 'INTERNAL' } });
  }
});

router.get('/notifications/unread-count', authenticateCustomerPortal, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COUNT(*) AS count FROM customer_portal_notifications WHERE customer_id = $1 AND is_read = FALSE`,
      [req.customerId]
    );
    return res.json({ data: { count: parseInt(r.rows[0].count, 10) } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load unread count.', code: 'INTERNAL' } });
  }
});

router.put('/notifications/:id/read', authenticateCustomerPortal, async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'Notification not found.', code: 'NOT_FOUND' } });
  try {
    const r = await pool.query(
      `UPDATE customer_portal_notifications SET is_read = TRUE, read_at = NOW()
       WHERE id = $1 AND customer_id = $2 RETURNING id, is_read, read_at`,
      [id, req.customerId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Notification not found.', code: 'NOT_FOUND' } });
    return res.json({ data: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to update notification.', code: 'INTERNAL' } });
  }
});

router.put('/notifications/read-all', authenticateCustomerPortal, async (req, res) => {
  try {
    await pool.query(
      `UPDATE customer_portal_notifications SET is_read = TRUE, read_at = NOW() WHERE customer_id = $1 AND is_read = FALSE`,
      [req.customerId]
    );
    return res.json({ data: { message: 'All notifications marked read.' } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to update notifications.', code: 'INTERNAL' } });
  }
});

module.exports = router;
