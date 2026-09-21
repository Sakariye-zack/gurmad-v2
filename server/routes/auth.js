const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { pool, logAudit } = require('../db');
const { authenticateToken, issueStaffToken } = require('../middleware/auth');
const { resolveAccessContext } = require('../lib/accessResolution');

// User & Access Administration — Implementation Spec §16 (API Route
// Inventory), §9 (Login Security). Directly mirrors
// routes/customerPortal.js's own already-proven auth pattern (bcrypt,
// per-account lockout + IP rate limiting, generic anti-enumeration
// responses, token_version revocation) — no new pattern invented, no new
// dependency (bcrypt/express-rate-limit both already present).
//
// Only accounts with v2_users.auth_source = 'v2' may log in here
// (Preconditions §2 — auth_source is routing metadata, checked ONLY at
// login time, never consulted anywhere in authorization decisions, which
// always go through lib/accessResolution.js instead). An account still on
// 'legacy' gets a distinct, honest response telling the caller to use the
// legacy login route — not a generic failure, since this is a routing
// fact, not a credential/security boundary (Preconditions §2).

const router = express.Router();

const BCRYPT_ROUNDS = 12;
const FAILED_LOGIN_LOCK_THRESHOLD = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

const GENERIC_LOGIN_FAIL = { error: { message: 'Invalid username or password.', code: 'AUTH_INVALID' } };
const GENERIC_RESET_RESPONSE = { data: { message: 'If an account exists for that username, password reset instructions have been generated.' } };

function clientIp(req) {
  return req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || null;
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts. Please try again later.', code: 'RATE_LIMITED' } },
});

// ==================================================================
// LOGIN
// ==================================================================

router.post('/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: { message: 'Username and password are required.', code: 'VALIDATION' } });
  }
  try {
    const r = await pool.query('SELECT * FROM v2_users WHERE username = $1', [username.trim()]);
    if (r.rows.length === 0) {
      return res.status(401).json(GENERIC_LOGIN_FAIL);
    }
    const user = r.rows[0];

    // A not-yet-cut-over account — an honest routing response, not a
    // credential failure (Preconditions §2: auth_source is metadata, not
    // a security gate — this account's credentials may well be correct,
    // it simply isn't authoritative here yet).
    if (user.auth_source !== 'v2') {
      return res.status(409).json({ error: { message: 'This account has not been migrated to V2 authentication yet. Use the existing login.', code: 'AUTH_SOURCE_LEGACY' } });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await logAudit({ actorId: user.id, actorUsername: user.username, action: 'login_failed', entityType: 'v2_user', entityId: user.id, after: { reason: 'locked' } });
      return res.status(401).json(GENERIC_LOGIN_FAIL);
    }
    if (!user.is_active) {
      await logAudit({ actorId: user.id, actorUsername: user.username, action: 'login_failed', entityType: 'v2_user', entityId: user.id, after: { reason: 'disabled' } });
      return res.status(401).json(GENERIC_LOGIN_FAIL);
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) {
      const failCount = user.failed_login_count + 1;
      const lockUntil = failCount >= FAILED_LOGIN_LOCK_THRESHOLD ? new Date(Date.now() + LOCK_WINDOW_MS) : null;
      await pool.query('UPDATE v2_users SET failed_login_count = $1, locked_until = $2, updated_at = NOW() WHERE id = $3', [failCount, lockUntil, user.id]);
      await logAudit({
        actorId: user.id, actorUsername: user.username,
        action: lockUntil ? 'account_locked' : 'login_failed', entityType: 'v2_user', entityId: user.id,
      });
      return res.status(401).json(GENERIC_LOGIN_FAIL);
    }

    // Employee-status gate at login too (not just on subsequent requests
    // via authenticateToken) — a deactivated employee shouldn't be able
    // to obtain a fresh token at all, not merely be blocked from using
    // one they already hold.
    const ctx = await resolveAccessContext(user.id);
    if (!ctx || !ctx.authorized) {
      await logAudit({ actorId: user.id, actorUsername: user.username, action: 'login_failed', entityType: 'v2_user', entityId: user.id, after: { reason: 'employee_inactive' } });
      return res.status(401).json(GENERIC_LOGIN_FAIL);
    }

    await pool.query('UPDATE v2_users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [user.id]);
    await logAudit({ actorId: user.id, actorUsername: user.username, action: 'login', entityType: 'v2_user', entityId: user.id });

    // token_version is NOT bumped on login (OD-3, approved) — a new
    // login/device is not itself a compromise signal.
    const token = issueStaffToken({ id: user.id, username: user.username, role: ctx.role, zone: ctx.zoneName, tokenVersion: user.token_version });
    return res.json({ data: { token, user: { id: user.id, username: user.username, full_name: user.full_name, role: ctx.role, zone: ctx.zoneName } } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Login failed.', code: 'INTERNAL' } });
  }
});

// ==================================================================
// MY PERMISSIONS (Dynamic Roles & Permissions, user-requested)
// ==================================================================

// A bare JSON array, not the { data: ... } envelope every other V2 route
// uses — matching client/src/hooks/usePermissions.js's own existing
// `data || []` unwrapping exactly, since that hook was already written
// against this shape before this endpoint existed.
router.get('/my-permissions', authenticateToken, (req, res) => {
  return res.json(req.user.permissions || []);
});

// ==================================================================
// LOGOUT / LOGOUT-ALL
// ==================================================================

// A single-device logout has no server-side action beyond an audit
// record — the token still naturally expires, and other devices must
// remain logged in (same reasoning as the Customer Portal's own design).
router.post('/logout', authenticateToken, async (req, res) => {
  await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'logout', entityType: 'v2_user', entityId: req.user.id });
  return res.json({ data: { message: 'Logged out.' } });
});

router.post('/logout-all', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE v2_users SET token_version = token_version + 1, updated_at = NOW() WHERE id = $1', [req.user.id]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'logout_all', entityType: 'v2_user', entityId: req.user.id });
    return res.json({ data: { message: 'Logged out of all devices.' } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to log out of all devices.', code: 'INTERNAL' } });
  }
});

// ==================================================================
// PASSWORD CHANGE (self-service, authenticated)
// ==================================================================

router.post('/password/change', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: { message: 'currentPassword and a newPassword of at least 8 characters are required.', code: 'VALIDATION' } });
  }
  try {
    const r = await pool.query('SELECT * FROM v2_users WHERE id = $1', [req.user.id]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: { message: 'Account not found.', code: 'NOT_FOUND' } });
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: { message: 'Current password is incorrect.', code: 'AUTH_INVALID' } });
    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // OD-3: password change bumps token_version — invalidates every token
    // issued before this change, everywhere. Matches the Customer
    // Portal's own precedent exactly: immediately issue a FRESH token
    // embedding the new version, so THIS device/request stays logged in
    // uninterrupted while every other outstanding token dies.
    const updated = await pool.query(
      'UPDATE v2_users SET password_hash = $1, token_version = token_version + 1, updated_at = NOW() WHERE id = $2 RETURNING token_version',
      [newHash, user.id]
    );
    const ctx = await resolveAccessContext(user.id);
    const token = issueStaffToken({ id: user.id, username: user.username, role: ctx.role, zone: ctx.zoneName, tokenVersion: updated.rows[0].token_version });
    await logAudit({ actorId: user.id, actorUsername: user.username, action: 'password_change', entityType: 'v2_user', entityId: user.id });
    return res.json({ data: { message: 'Password changed. You remain signed in on this device — other devices will need to sign in again.', token } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to change password.', code: 'INTERNAL' } });
  }
});

// ==================================================================
// PASSWORD RESET (unauthenticated, generic-response, matches the
// Customer Portal's own anti-enumeration precedent exactly)
// ==================================================================

router.post('/password/reset/request', authLimiter, async (req, res) => {
  const { username } = req.body || {};
  if (typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: { message: 'Username is required.', code: 'VALIDATION' } });
  }
  try {
    const r = await pool.query('SELECT id, username FROM v2_users WHERE username = $1 AND is_active = TRUE', [username.trim()]);
    if (r.rows.length > 0) {
      const user = r.rows[0];
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      await pool.query(
        'INSERT INTO v2_password_resets (user_id, token_hash, expires_at, requested_ip) VALUES ($1, $2, $3, $4)',
        [user.id, tokenHash, new Date(Date.now() + RESET_TOKEN_TTL_MS), clientIp(req)]
      );
      await logAudit({ actorId: user.id, actorUsername: user.username, action: 'password_reset', entityType: 'v2_user', entityId: user.id, after: { stage: 'requested' } });
      // No delivery channel is wired here (matches Precondition/Out-of-
      // Scope: no new integration introduced) — the raw token is returned
      // ONLY in non-production (dev/QA) contexts, for local testing; a
      // real delivery mechanism (email/SMS) is an Open Implementation
      // Precondition not resolved by this pass.
      if (process.env.NODE_ENV !== 'production') {
        return res.json({ ...GENERIC_RESET_RESPONSE, dev_only_reset_token: rawToken });
      }
    }
    return res.json(GENERIC_RESET_RESPONSE);
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to process reset request.', code: 'INTERNAL' } });
  }
});

router.post('/password/reset/confirm', authLimiter, async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (typeof token !== 'string' || !token || typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: { message: 'A valid token and a newPassword of at least 8 characters are required.', code: 'VALIDATION' } });
  }
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const r = await pool.query(
      'SELECT * FROM v2_password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()',
      [tokenHash]
    );
    if (r.rows.length === 0) {
      return res.status(400).json({ error: { message: 'This reset link is invalid or has expired.', code: 'RESET_INVALID' } });
    }
    const reset = r.rows[0];
    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query('UPDATE v2_users SET password_hash = $1, token_version = token_version + 1, failed_login_count = 0, locked_until = NULL, updated_at = NOW() WHERE id = $2', [newHash, reset.user_id]);
    await pool.query('UPDATE v2_password_resets SET used_at = NOW() WHERE id = $1', [reset.id]);
    await logAudit({ actorId: reset.user_id, action: 'password_reset', entityType: 'v2_user', entityId: reset.user_id, after: { stage: 'confirmed' } });
    return res.json({ data: { message: 'Password reset. Please log in with your new password.' } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to reset password.', code: 'INTERNAL' } });
  }
});

module.exports = router;
