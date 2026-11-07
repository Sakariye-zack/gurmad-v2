const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { pool, logPortalAudit } = require('../db');
const { sniffFileType } = require('../lib/fileSniff');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { authenticateCustomerPortal, issuePortalToken } = require('../middleware/customerPortalAuth');
const { getInvoiceBalance, getCurrentExchangeRate, paidInInvoiceCurrency } = require('../lib/financialCalculations');
const { getCollectionHistory, getCollectionDetail } = require('../lib/reportsCalculations');
const { buildInvoiceDocx, buildInvoiceHtml } = require('../lib/documentGenerators');
const { getWorkedDays } = require('../lib/workedDays');
const { getTimezone } = require('../lib/autoBilling');
const { sendPasswordResetWhatsApp } = require('../lib/whatsappService');
// Phase 5 — Complaints now exists: createComplaint/getComplaintsForCustomer/
// getComplaintDetail are imported directly from the ONE shared service
// module also used by routes/complaints.js (staff) — no duplicated
// business logic between the two API surfaces, per the approved contract.
const { createComplaint, getComplaintsForCustomer, getComplaintDetail } = require('../lib/complaintsService');
const { rejectIfInfected } = require('../lib/virusScan');
const paymentsRouter = require('./payments');
const { createStaffNotification, logNotificationFailure } = require('../lib/staffNotifications');
const { EPSILON } = require('../lib/financialCalculations');

const COMPLAINT_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'complaints');
fs.mkdirSync(COMPLAINT_UPLOAD_DIR, { recursive: true });
const COMPLAINT_ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
const uploadComplaintPhoto = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, COMPLAINT_UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, COMPLAINT_ALLOWED_MIME.includes(file.mimetype)),
});

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
      // Hardening — Audit Review: a token hash matching no row at all is a
      // security-relevant signal (someone guessing/fabricating reset
      // tokens) with no account to attribute it to yet — logged with
      // portalAccountId/customerId null, never the raw token itself.
      await logPortalAudit({ action: 'password_reset_failed', ipAddress: clientIp(req), details: { reason: 'token_not_found' } });
      return res.status(400).json({ error: { message: 'This reset link is invalid or has expired.', code: 'RESET_INVALID' } });
    }
    const reset = resetRes.rows[0];
    const acctRes = await pool.query('SELECT * FROM customer_portal_accounts WHERE id = $1', [reset.portal_account_id]);
    const account = acctRes.rows[0];
    if (reset.used_at || new Date(reset.expires_at) < new Date()) {
      // Hardening — Audit Review: an expired/reused token attempt against a
      // REAL account is exactly the "authentication accountability" case
      // the review's own criteria named — added during Hardening, not left
      // omitted. Never logs the token itself, only the reason.
      await logPortalAudit({
        portalAccountId: account?.id ?? null, customerId: account?.customer_id ?? null,
        action: 'password_reset_failed', ipAddress: clientIp(req),
        details: { reason: reset.used_at ? 'token_reused' : 'token_expired' },
      });
      return res.status(400).json({ error: { message: 'This reset link is invalid or has expired.', code: 'RESET_INVALID' } });
    }
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

// Outstanding invoice balance for the portal. Each invoice is settled in ITS OWN currency
// (paid from frozen amount_invoice_currency), then converted to USD at the same current rate
// used for billed figures, so a fully paid SLSH invoice is exactly 0 outstanding.
async function portalInvoiceOutstanding(customerId, rate) {
  const curRate = rate ? parseFloat(rate.rate) : null;
  const inv = await pool.query(
    `SELECT id, currency, invoice_total - discount_amount AS net FROM invoices WHERE customer_id = $1 AND status != 'voided'`, [customerId]);
  const byCurrency = { USD: 0, SLSH: 0 };
  let usd = 0;
  for (const i of inv.rows) {
    const cur = i.currency === 'SLSH' ? 'SLSH' : 'USD';
    const paid = await paidInInvoiceCurrency(i.id, cur, pool, { rate });
    const out = Math.max(parseFloat(i.net) - paid, 0);
    byCurrency[cur] += out;
    usd += cur === 'SLSH' ? (curRate > 0 ? out / curRate : 0) : out;
  }
  return { usd, byCurrency };
}

router.get('/summary', authenticateCustomerPortal, async (req, res) => {
  try {
    const customerId = req.customerId;
    const portalRate = await getCurrentExchangeRate(pool);
    const outstanding = await portalInvoiceOutstanding(customerId, portalRate);
    const debtRes = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN currency = 'SLSH' THEN (CASE WHEN $2::numeric > 0 THEN amount / $2::numeric ELSE 0 END) ELSE amount END), 0) AS outstanding_debt
       FROM debts WHERE customer_id = $1 AND status = 'unpaid'`,
      [customerId, portalRate ? parseFloat(portalRate.rate) : null]
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
    return res.json({
      data: {
        outstandingInvoiceBalance: outstanding.usd,
        outstandingByCurrency: outstanding.byCurrency,
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
    // One query: each invoice plus what is already paid on it, in the invoice's
    // own currency (same rules as paidInInvoiceCurrency) -> outstanding, which
    // drives the portal's "Pay with ZAAD" button.
    const rate = await getCurrentExchangeRate(pool);
    const r = await pool.query(
      `SELECT i.id, i.invoice_number, i.invoice_total, i.discount_amount, i.currency, i.status, i.created_at,
              COALESCE(SUM(CASE WHEN i.currency = 'SLSH'
                                THEN COALESCE(p.amount_invoice_currency,
                                              CASE WHEN p.currency = 'SLSH' THEN p.amount
                                                   ELSE p.amount_usd * COALESCE(er.rate, $2::numeric) END)
                                ELSE p.amount_usd END) FILTER (WHERE p.status = 'recorded'), 0) AS paid
       FROM invoices i
       LEFT JOIN payments p ON p.invoice_id = i.id
       LEFT JOIN exchange_rates er ON er.id = p.exchange_rate_id
       WHERE i.customer_id = $1
       GROUP BY i.id
       ORDER BY i.created_at DESC LIMIT 200`,
      [req.customerId, rate ? parseFloat(rate.rate) : null]
    );
    const rows = r.rows.map(({ paid, ...inv }) => {
      const net = parseFloat(inv.invoice_total) - parseFloat(inv.discount_amount);
      return { ...inv, outstanding: inv.status === 'voided' ? 0 : Math.max(net - parseFloat(paid), 0) };
    });
    return res.json({ data: rows });
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
      `SELECT amount, currency, method, amount_usd, status, channel, reference_code, created_at FROM payments WHERE invoice_id = $1 AND status = 'recorded' ORDER BY created_at ASC`,
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
      `SELECT invoices.*, customers.name AS customer_name, COALESCE(invoices.customer_number_snapshot, customers.customer_number) AS customer_number
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
    const worked_days = invoice.billing_period ? await getWorkedDays(invoice.customer_id, invoice.billing_period, await getTimezone()) : undefined;
    const buffer = await buildInvoiceDocx({ ...invoice, balance, payments: payments.rows, worked_days });
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
      `SELECT invoices.*, customers.name AS customer_name, COALESCE(invoices.customer_number_snapshot, customers.customer_number) AS customer_number
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
    const worked_days = invoice.billing_period ? await getWorkedDays(invoice.customer_id, invoice.billing_period, await getTimezone()) : undefined;
    const html = await buildInvoiceHtml({ ...invoice, balance, payments: payments.rows, worked_days });
    return res.json({ data: { html } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to generate preview.', code: 'INTERNAL' } });
  }
});

// ==================================================================
// ZAAD SELF-PAYMENT — the customer pays their own invoice from the portal.
// Same WAAFI flow as staff POST /payments/zaad-request (shared
// runZaadCollect in routes/payments.js). Guards, in order:
//   ownership (404), archived customer (403), voided / already paid (409),
//   amount <= outstanding (precheck BEFORE any gateway call), target phone
//   must be one of the customer's registered numbers, an invoice with an
//   unconfirmed (unknown) attempt in the last 15 min is blocked, one
//   in-flight request per invoice (in-process lock + DB partial unique index
//   on pending attempts), max 5 attempts per customer and 3 per target phone
//   per 10 minutes (count + insert serialised by an advisory lock).
// Outcome 'unknown' (gateway timeout / transport error after sending, or a
// pending row older than the stale window) is never treated as declined:
// it is audited as reconciliation-required and every admin is notified.
// Payments are recorded with cashier_id NULL, channel 'portal_zaad' and an
// audit actor of 'portal:<customer_number>'.
// ==================================================================
const { GATEWAY_TIMEOUT_MS } = require('../lib/zaadService');
// Canonical international form for comparing / counting numbers
// (0XXXXXXXX, XXXXXXXX and 252XXXXXXXX are the same number).
function canonicalPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('252')) return d;
  return '252' + (d.startsWith('0') ? d.slice(1) : d);
}

const ZAAD_INFLIGHT = new Set(); // invoice ids with a request in flight in this process
const ZAAD_RATE_MAX = 5;
const ZAAD_PHONE_RATE_MAX = 3;
const ZAAD_RATE_WINDOW_MIN = 10;
// >= 2x the gateway timeout: a pending row older than this cannot still be in flight.
const ZAAD_STALE_MIN = Math.max(5, Math.ceil((2 * GATEWAY_TIMEOUT_MS) / 60000));
const ZAAD_UNKNOWN_BLOCK_MIN = 15;
const PORTAL_ZAAD_CHANNEL = 'portal_zaad';
const ZAAD_ADVISORY_NS = 7390; // advisory-lock namespace for portal ZAAD attempts

// Fixed customer-facing messages per code: raw gateway text is never shown.
const ZAAD_MSG = {
  NOT_FOUND: 'Invoice not found.',
  ARCHIVED: 'Online payment is not available for this account. Please contact customer service.',
  VOIDED: 'This invoice has been voided and cannot be paid.',
  ALREADY_PAID: 'This invoice is already fully paid.',
  VALIDATION_AMOUNT: 'Amount must be a positive number.',
  VALIDATION_SLSH: 'SLSH amounts must be whole numbers.',
  PHONE_NOT_REGISTERED: 'Payments can only be sent to one of the phone numbers registered on your account.',
  OVERPAYMENT: 'The amount is more than what you owe on this invoice.',
  IN_PROGRESS: 'A ZAAD payment for this invoice is already in progress. Please check your phone.',
  PAYMENT_UNCONFIRMED: 'A recent payment on this invoice could not be confirmed. Please wait 15 minutes, or contact customer service, before paying again.',
  TOO_MANY_ATTEMPTS: 'Too many payment attempts. Please wait 10 minutes and try again.',
  NOT_CONFIGURED: 'Online ZAAD payment is not available right now. Please pay at our office or contact customer service.',
  ZAAD_DECLINED: 'The payment was not approved. No money was taken.',
  PAYMENT_UNKNOWN: 'We could not confirm your payment. If money left your wallet, it will be reconciled — do not pay again for now.',
  INTERNAL: 'Payment could not be processed.',
};

const fmtAmt = (n, cur) => (cur === 'SLSH' ? `${Math.round(n).toLocaleString('en-US')} SLSH` : `$${Number(n).toFixed(2)}`);
const zaadErr = (res, status, code, msgKey = code) => res.status(status).json({ error: { message: ZAAD_MSG[msgKey], code } });

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

// Unknown outcome: audit + admin alert. `attempt` is a portal_zaad_attempts row
// (or the same fields), joined with invoice_number / customer_number.
async function flagUnknownAttempt(attempt, reason) {
  const { logAudit } = require('../db');
  await logAudit({
    actorId: null, actorUsername: `portal:${attempt.customer_number}`.slice(0, 50), action: 'payment.zaad_reconciliation_required',
    entityType: 'invoice', entityId: attempt.invoice_id, before: null,
    after: { invoice_id: attempt.invoice_id, amount: Number(attempt.amount), currency: attempt.currency, target_phone: attempt.phone, attempt_id: attempt.id, reference: attempt.reference, channel: PORTAL_ZAAD_CHANNEL, outcome: 'unknown', reason },
  }).catch(() => {});
  await notifyAdmins({
    invoiceId: attempt.invoice_id,
    title: `ZAAD payment outcome unknown — ${attempt.invoice_number}`,
    body: `Customer ${attempt.customer_number} tried to pay ${fmtAmt(attempt.amount, attempt.currency)} via ZAAD in the customer portal (attempt ${attempt.id}, reference ${attempt.reference}, phone ${attempt.phone}) but the result could not be confirmed (${reason}). Check the merchant account; if the money arrived, record it manually against the invoice.`,
  });
}

// Pending attempts older than the stale window -> unknown + alert. Runs on
// every pay request and once at boot (index.js).
async function sweepStaleZaadAttempts() {
  const r = await pool.query(
    `UPDATE portal_zaad_attempts a SET status = 'unknown', error_code = 'STALE', finished_at = NOW()
     FROM invoices i, customers c
     WHERE a.status = 'pending' AND a.created_at < NOW() - make_interval(mins => $1)
       AND i.id = a.invoice_id AND c.id = a.customer_id
     RETURNING a.*, i.invoice_number, c.customer_number`,
    [ZAAD_STALE_MIN]
  );
  for (const row of r.rows) await flagUnknownAttempt(row, 'pending attempt went stale');
  return r.rows.length;
}

const registeredPhones = (c) => [c.phone, c.alternate_phone, c.whatsapp]
  .map((p) => String(p || '').replace(/\D/g, ''))
  .filter((p) => p.length >= 7);

router.post('/invoices/:id/pay-zaad', authenticateCustomerPortal, async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return zaadErr(res, 404, 'NOT_FOUND');
  let attemptId = null;
  let locked = false;
  try {
    const invRes = await pool.query('SELECT * FROM invoices WHERE id = $1 AND customer_id = $2', [id, req.customerId]);
    if (invRes.rows.length === 0) return zaadErr(res, 404, 'NOT_FOUND');
    const invoice = invRes.rows[0];
    const customer = (await pool.query('SELECT id, phone, alternate_phone, whatsapp, customer_number, status FROM customers WHERE id = $1', [req.customerId])).rows[0];
    if (customer.status === 'archived') return zaadErr(res, 403, 'ACCOUNT_ARCHIVED', 'ARCHIVED');
    if (invoice.status === 'voided') return zaadErr(res, 409, 'CONFLICT', 'VOIDED');

    const cur = invoice.currency === 'SLSH' ? 'SLSH' : 'USD';
    const { outstanding } = await getInvoiceBalance(id);
    if (outstanding <= EPSILON) return zaadErr(res, 409, 'ALREADY_PAID');

    const rawAmount = req.body?.amount;
    let amt;
    if (rawAmount === undefined || rawAmount === null || rawAmount === '') {
      // floor, never round up past the outstanding
      amt = cur === 'SLSH' ? Math.floor(outstanding + 1e-6) : Math.floor(outstanding * 100 + 1e-6) / 100;
    } else {
      amt = typeof rawAmount === 'number' ? rawAmount : parseFloat(String(rawAmount));
      if (!Number.isFinite(amt)) return zaadErr(res, 400, 'VALIDATION', 'VALIDATION_AMOUNT');
      if (cur === 'SLSH' && !Number.isInteger(amt)) return zaadErr(res, 400, 'VALIDATION', 'VALIDATION_SLSH');
      amt = Math.round(amt * 100) / 100;
    }
    if (!(amt > 0)) return zaadErr(res, 400, 'VALIDATION', 'VALIDATION_AMOUNT');

    // Target phone: only the customer's own registered numbers.
    const allowed = registeredPhones(customer);
    const requested = String(req.body?.phone || customer.phone || '').replace(/\D/g, '');
    const match = allowed.find((p) => canonicalPhone(p) === canonicalPhone(requested));
    if (!match) return zaadErr(res, 400, 'PHONE_NOT_REGISTERED');
    const phoneDigits = match;
    const phoneKey = canonicalPhone(match);

    // Read-only precheck before bothering WAAFI / the customer's phone.
    const blocked = await paymentsRouter.precheckPayment(pool, invoice, { amt, cur });
    if (blocked) {
      if (blocked.code === 'OVERPAYMENT') return zaadErr(res, 409, 'OVERPAYMENT');
      return res.status(blocked.status).json({ error: { message: ZAAD_MSG.INTERNAL, code: blocked.code } });
    }

    // In-process lock first (cheap), then the DB guards below.
    if (ZAAD_INFLIGHT.has(id)) return zaadErr(res, 409, 'IN_PROGRESS');
    ZAAD_INFLIGHT.add(id);
    locked = true;

    await sweepStaleZaadAttempts();
    const unknownRecent = await pool.query(
      `SELECT 1 FROM portal_zaad_attempts WHERE invoice_id = $1 AND status = 'unknown'
         AND COALESCE(finished_at, created_at) > NOW() - make_interval(mins => $2) LIMIT 1`,
      [id, ZAAD_UNKNOWN_BLOCK_MIN]
    );
    if (unknownRecent.rows.length) return zaadErr(res, 409, 'PAYMENT_UNCONFIRMED');

    // Count + insert serialised per customer (advisory xact lock), so two
    // parallel requests cannot both slip under the limits.
    const reference = (n) => `${invoice.invoice_number}-A${n}`;
    const db = await pool.connect();
    let limitHit = null;
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock($1, $2)', [ZAAD_ADVISORY_NS, req.customerId]);
      const counted = (await db.query(
        `SELECT
           COUNT(*) FILTER (WHERE customer_id = $1)::int AS by_customer,
           COUNT(*) FILTER (WHERE phone = $2)::int AS by_phone
         FROM portal_zaad_attempts
         WHERE (customer_id = $1 OR phone = $2) AND created_at > NOW() - make_interval(mins => $3)
           AND COALESCE(error_code, '') <> 'NOT_CONFIGURED'`,
        [req.customerId, phoneKey, ZAAD_RATE_WINDOW_MIN]
      )).rows[0];
      if (counted.by_customer >= ZAAD_RATE_MAX) limitHit = 'TOO_MANY_ATTEMPTS';
      else if (counted.by_phone >= ZAAD_PHONE_RATE_MAX) limitHit = 'TOO_MANY_ATTEMPTS_PHONE';
      if (!limitHit) {
        const ins = await db.query(
          `INSERT INTO portal_zaad_attempts (customer_id, invoice_id, amount, currency, phone) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [req.customerId, id, amt, cur, phoneKey]
        );
        attemptId = ins.rows[0].id;
        await db.query('UPDATE portal_zaad_attempts SET reference = $2 WHERE id = $1', [attemptId, reference(attemptId)]);
      }
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      attemptId = null;
      if (e.code === '23505') return zaadErr(res, 409, 'IN_PROGRESS');
      throw e;
    } finally {
      db.release();
    }
    if (limitHit) return zaadErr(res, 429, limitHit, 'TOO_MANY_ATTEMPTS');

    const attemptRow = { id: attemptId, invoice_id: id, amount: amt, currency: cur, phone: phoneKey, reference: reference(attemptId), invoice_number: invoice.invoice_number, customer_number: customer.customer_number };
    const actor = { id: null, username: `portal:${customer.customer_number}`.slice(0, 50), role: 'portal', zone: null };
    const auditExtra = { target_phone: phoneKey, attempt_id: attemptId, reference: attemptRow.reference };
    let r;
    try {
      r = await paymentsRouter.runZaadCollect({ invoice, amt, cur, phoneDigits, actor, channel: PORTAL_ZAAD_CHANNEL, reference: attemptRow.reference, auditExtra });
    } catch (e) {
      // Transport error after the request may have been sent: outcome unknown.
      r = { kind: 'unknown', reason: 'gateway transport error' };
    }

    if (r.kind === 'unknown') {
      await finishZaadAttempt(attemptId, 'unknown', { errorCode: 'UNKNOWN' });
      await flagUnknownAttempt(attemptRow, r.reason || 'gateway timeout');
      await logPortalAudit({ portalAccountId: req.portalAccountId, customerId: req.customerId, action: 'zaad_payment_unknown', ipAddress: clientIp(req), details: auditExtra }).catch(() => {});
      return zaadErr(res, 504, 'PAYMENT_UNKNOWN');
    }

    if (r.kind === 'declined') {
      if (r.zaadResult.notConfigured) {
        await finishZaadAttempt(attemptId, 'failed', { errorCode: 'NOT_CONFIGURED' });
        return zaadErr(res, 503, 'NOT_CONFIGURED');
      }
      await finishZaadAttempt(attemptId, 'failed', { errorCode: 'ZAAD_DECLINED' });
      await logPortalAudit({ portalAccountId: req.portalAccountId, customerId: req.customerId, action: 'zaad_payment_failed', ipAddress: clientIp(req), details: { ...auditExtra, invoice_id: id, amount: amt, currency: cur, gateway_message: r.zaadResult.message } }).catch(() => {});
      return zaadErr(res, 402, 'ZAAD_DECLINED');
    }

    if (r.kind === 'reconciliation') {
      const txId = r.zaadResult.transactionId;
      await finishZaadAttempt(attemptId, 'reconciliation_required', { transactionId: txId, errorCode: 'RECONCILIATION_REQUIRED' });
      await notifyAdmins({
        invoiceId: id,
        title: `ZAAD payment needs reconciliation — ${invoice.invoice_number}`,
        body: `Customer ${customer.customer_number} paid ${fmtAmt(amt, cur)} via ZAAD in the customer portal (transaction ${txId}, attempt ${attemptId}, phone ${phoneKey}), but it could not be recorded: ${r.error.message}. Review the invoice and record it manually with reference code ${txId}.`,
      });
      await logPortalAudit({ portalAccountId: req.portalAccountId, customerId: req.customerId, action: 'zaad_payment_reconciliation', ipAddress: clientIp(req), details: { ...auditExtra, invoice_id: id, amount: amt, currency: cur, transaction_id: txId } }).catch(() => {});
      return res.status(409).json({ error: {
        code: 'RECONCILIATION_REQUIRED',
        message: `Your ZAAD payment was received (transaction ${txId}) but could not be applied to this invoice automatically. Our team has been notified and will apply it — please keep this transaction number.`,
        transaction_id: txId,
      } });
    }

    const { payment, recalculated } = r;
    await finishZaadAttempt(attemptId, 'ok', { transactionId: r.zaadResult.transactionId, paymentId: payment.id });
    await logPortalAudit({ portalAccountId: req.portalAccountId, customerId: req.customerId, action: 'zaad_payment_success', ipAddress: clientIp(req), details: { ...auditExtra, invoice_id: id, payment_id: payment.id, amount: amt, currency: cur } }).catch(() => {});
    return res.status(201).json({ data: {
      payment_id: payment.id,
      invoice_id: id,
      invoice_number: invoice.invoice_number,
      amount: Number(payment.amount),
      currency: payment.currency,
      method: 'zaad',
      transaction_id: r.zaadResult.transactionId,
      paid_at: payment.created_at,
      invoice_status: recalculated.status,
      outstanding: recalculated.outstanding,
      outstanding_currency: recalculated.currency,
    } });
  } catch (err) {
    if (attemptId) await finishZaadAttempt(attemptId, 'failed', { errorCode: 'INTERNAL' });
    return zaadErr(res, 500, 'INTERNAL');
  } finally {
    if (locked) ZAAD_INFLIGHT.delete(id);
  }
});

router.get('/payments', authenticateCustomerPortal, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.amount, p.currency, p.method, p.amount_usd, p.status, p.channel, p.reference_code, p.created_at,
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
    const portalRate = await getCurrentExchangeRate(pool);
    const outstanding = await portalInvoiceOutstanding(req.customerId, portalRate);
    const debtsRes = await pool.query(
      `SELECT id, amount, currency, description, status, created_at FROM debts WHERE customer_id = $1 ORDER BY created_at DESC`,
      [req.customerId]
    );
    return res.json({
      data: {
        outstandingInvoiceBalance: outstanding.usd,
        outstandingByCurrency: outstanding.byCurrency,
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

// ==================================================================
// COMPLAINTS (Phase 5 — 3 additive routes, existing 23 routes above
// unchanged verbatim). customer_id always derived from req.customerId
// (the verified token) — a customer structurally cannot submit or view
// a complaint for another customer, matching every other route in this
// file. Uses the SAME lib/complaintsService.js as the staff-facing
// routes/complaints.js — zero duplicated business logic.
// ==================================================================

router.get('/complaints', authenticateCustomerPortal, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const rows = await getComplaintsForCustomer({ customerId: req.customerId, limit, offset });
    return res.json({ data: rows });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load complaints.', code: 'INTERNAL' } });
  }
});

router.post('/complaints', authenticateCustomerPortal, uploadComplaintPhoto.single('photo'), async (req, res) => {
  const { title, description } = req.body || {};
  if (typeof title !== 'string' || !title.trim() || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: { message: 'title and description are required.', code: 'VALIDATION' } });
  }
  // Content-sniffing validation (Future CR promoted to in-scope, Phase 10
  // Gap Audit) — see lib/fileSniff.js. Checked before creating the
  // complaint so a bad photo never leaves an orphan complaint row behind.
  if (req.file && !sniffFileType(fs.readFileSync(req.file.path), req.file.mimetype)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: { message: 'Photo content does not match its claimed type.', code: 'VALIDATION' } });
  }
  if (req.file && await rejectIfInfected(req, res, { filePath: req.file.path, label: 'portal_complaint_photo' })) return;
  // QA fix (Phase 5 QA, defect found live-testing): priority is staff-set
  // only, per the approved Decision Record — a customer-supplied priority
  // was previously accepted and honored here. Any client-sent `priority`
  // is now ignored entirely; every customer-submitted complaint is created
  // at the fixed 'medium' default, exactly like every other unspecified
  // field, until staff triage it.
  try {
    const complaint = await createComplaint({
      customerId: req.customerId, title: title.trim(), description: description.trim(),
      priority: 'medium', source: 'customer',
    });
    if (req.file) {
      await pool.query(
        `INSERT INTO complaint_attachments (complaint_id, original_filename, storage_path, mime_type, file_size, uploaded_by_customer)
         VALUES ($1, $2, $3, $4, $5, TRUE)`,
        [complaint.id, req.file.originalname, req.file.path, req.file.mimetype, req.file.size]
      );
      await logPortalAudit({ portalAccountId: req.portalAccountId, customerId: req.customerId, action: 'complaint_attachment_uploaded', details: { complaintId: complaint.id } });
    }
    return res.status(201).json({ data: complaint });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to submit complaint.', code: 'INTERNAL' } });
  }
});

// A cross-customer id returns 404 — ownership enforced INSIDE
// getComplaintDetail() (customer_id = $2 in the query itself), matching
// the exact 404-not-403 pattern every other detail route in this file uses.
router.get('/complaints/:id', authenticateCustomerPortal, async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'Complaint not found.', code: 'NOT_FOUND' } });
  try {
    const complaint = await getComplaintDetail({ complaintId: id, customerId: req.customerId });
    if (!complaint) return res.status(404).json({ error: { message: 'Complaint not found.', code: 'NOT_FOUND' } });
    return res.json({ data: complaint });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load complaint.', code: 'INTERNAL' } });
  }
});

router.sweepStaleZaadAttempts = sweepStaleZaadAttempts;
module.exports = router;
