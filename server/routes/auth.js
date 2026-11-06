const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { pool, logAudit } = require('../db');
const { authenticateToken, issueStaffToken, JWT_SECRET } = require('../middleware/auth');
const { resolveAccessContext } = require('../lib/accessResolution');
const { validatePassword, policyErrorBody } = require('../lib/passwordPolicy');
const sec = require('../lib/accountSecurity');

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
const PENDING_2FA_TTL = '5m';
const TWO_FACTOR_LOCK_THRESHOLD = 5; // consecutive wrong codes at verify-login
const BACKUP_CODE_COUNT = 8;

const GENERIC_LOGIN_FAIL = { error: { message: 'Invalid username or password.', code: 'AUTH_INVALID' } };
const GENERIC_RESET_RESPONSE = { data: { message: 'If an account exists for that username, password reset instructions have been generated.' } };

// req.ip — honours app.set('trust proxy', 1) (index.js), so this is the
// real client IP behind nginx, not a spoofable X-Forwarded-For entry.
const clientIp = sec.requestIp;

// The one place a real staff session is created: a user_sessions row,
// a token carrying its sid, and the login-history/new-device bookkeeping.
async function completeLogin(req, user, ctx) {
  const sid = await sec.createSession(req, user.id);
  await sec.recordSuccessfulLogin(req, user);
  const token = issueStaffToken({ id: user.id, username: user.username, role: ctx.role, zone: ctx.zoneName, tokenVersion: user.token_version, sid });
  const flags = sec.securityFlags({ role: ctx.role, authSource: user.auth_source, twoFactorEnabled: user.two_factor_enabled, mustChangePassword: user.must_change_password });
  return { token, user: { id: user.id, username: user.username, full_name: user.full_name, role: ctx.role, zone: ctx.zoneName, ...flags } };
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
      // username_attempted stays NULL here: an unknown "username" is
      // often a password typed into the wrong field — never store it.
      await sec.recordAuthEvent(req, { username: null, event: 'login_failed' });
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
      await sec.recordAuthEvent(req, { userId: user.id, username: user.username, event: 'locked' });
      return res.status(401).json(GENERIC_LOGIN_FAIL);
    }
    if (!user.is_active) {
      await logAudit({ actorId: user.id, actorUsername: user.username, action: 'login_failed', entityType: 'v2_user', entityId: user.id, after: { reason: 'disabled' } });
      await sec.recordAuthEvent(req, { userId: user.id, username: user.username, event: 'login_failed' });
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
      await sec.recordAuthEvent(req, { userId: user.id, username: user.username, event: lockUntil ? 'locked' : 'login_failed' });
      return res.status(401).json(GENERIC_LOGIN_FAIL);
    }

    // Employee-status gate at login too (not just on subsequent requests
    // via authenticateToken) — a deactivated employee shouldn't be able
    // to obtain a fresh token at all, not merely be blocked from using
    // one they already hold.
    const ctx = await resolveAccessContext(user.id);
    if (!ctx || !ctx.authorized) {
      await logAudit({ actorId: user.id, actorUsername: user.username, action: 'login_failed', entityType: 'v2_user', entityId: user.id, after: { reason: 'employee_inactive' } });
      await sec.recordAuthEvent(req, { userId: user.id, username: user.username, event: 'login_failed' });
      return res.status(401).json(GENERIC_LOGIN_FAIL);
    }

    await pool.query('UPDATE v2_users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [user.id]);

    // Two-Factor Authentication (user-requested) — password alone is not
    // enough for an account with 2FA enabled. Rather than issuing the
    // real staff token here, issue a short-lived pending-2FA token
    // (distinct `purpose` claim, 5 minutes) and tell the caller a second
    // step is required. No permanent session exists yet — a stolen
    // password alone still cannot reach any /api/v2/* route.
    if (user.two_factor_enabled) {
      await logAudit({ actorId: user.id, actorUsername: user.username, action: 'login_2fa_pending', entityType: 'v2_user', entityId: user.id });
      const pendingToken = jwt.sign({ id: user.id, purpose: '2fa_pending' }, JWT_SECRET, { expiresIn: PENDING_2FA_TTL });
      return res.json({ data: { requires2FA: true, pendingToken } });
    }

    await logAudit({ actorId: user.id, actorUsername: user.username, action: 'login', entityType: 'v2_user', entityId: user.id });

    // token_version is NOT bumped on login (OD-3, approved) — a new
    // login/device is not itself a compromise signal.
    return res.json({ data: await completeLogin(req, user, ctx) });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Login failed.', code: 'INTERNAL' } });
  }
});

// ==================================================================
// TWO-FACTOR AUTHENTICATION (user-requested) — TOTP, additive to the
// password flow above. Enrollment (setup/enable/disable) requires a
// full existing session (authenticateToken); completing a 2FA-pending
// login (verify-login) deliberately does NOT — the caller only has the
// short-lived pending token from POST /login above, not a real session.
// ==================================================================

router.get('/2fa/status', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT two_factor_enabled FROM v2_users WHERE id = $1', [req.user.id]);
    return res.json({ data: { enabled: !!r.rows[0]?.two_factor_enabled, required: sec.requires2fa({ role: req.user.role, authSource: req.user.authSource }) } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load 2FA status.', code: 'INTERNAL' } });
  }
});

function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    codes.push(crypto.randomBytes(5).toString('hex'));
  }
  return codes;
}

// Step 1 of enrollment: generate (but do not yet persist as enabled) a
// TOTP secret, and return it as both a raw string (manual entry) and a
// scannable QR. Calling this again before /2fa/enable simply overwrites
// the not-yet-confirmed secret — no partial state to clean up.
// Refused once 2FA is ON: re-keying an enabled account must go through
// disable (password re-check) or an admin 2FA reset — otherwise a stolen
// session could silently swap in the attacker's own authenticator.
async function refuseIfEnabled(req, res) {
  const r = await pool.query('SELECT two_factor_enabled FROM v2_users WHERE id = $1', [req.user.id]);
  if (r.rows[0]?.two_factor_enabled) {
    res.status(409).json({ error: { message: 'Two-factor authentication is already enabled.', code: 'TWO_FACTOR_ALREADY_ENABLED' } });
    return true;
  }
  return false;
}

router.post('/2fa/setup', authenticateToken, async (req, res) => {
  try {
    if (await refuseIfEnabled(req, res)) return;
    const secret = authenticator.generateSecret();
    await pool.query('UPDATE v2_users SET two_factor_secret = $1 WHERE id = $2', [secret, req.user.id]);
    const otpauth = authenticator.keyuri(req.user.username, 'GURMAD', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth);
    return res.json({ data: { secret, qrDataUrl } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to start 2FA setup.', code: 'INTERNAL' } });
  }
});

// Step 2: the user proves they actually captured the secret in a real
// authenticator app by submitting one live code. Only THIS confirmation
// flips two_factor_enabled on — an abandoned /2fa/setup call (secret
// generated, QR shown, never confirmed) can never lock the account out,
// since two_factor_enabled stays false. Backup codes are generated once,
// here, and returned in plaintext exactly once — only their bcrypt
// hashes are ever persisted.
router.post('/2fa/enable', authenticateToken, async (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: { message: 'A verification code is required.', code: 'VALIDATION' } });
  }
  try {
    if (await refuseIfEnabled(req, res)) return;
    const r = await pool.query('SELECT two_factor_secret FROM v2_users WHERE id = $1', [req.user.id]);
    const secret = r.rows[0]?.two_factor_secret;
    if (!secret) return res.status(400).json({ error: { message: 'Start 2FA setup first.', code: 'VALIDATION' } });
    if (!authenticator.check(code.trim(), secret)) {
      return res.status(401).json({ error: { message: 'Incorrect code.', code: 'AUTH_INVALID' } });
    }
    const rawCodes = generateBackupCodes();
    const hashedCodes = await Promise.all(rawCodes.map((c) => bcrypt.hash(c, BCRYPT_ROUNDS)));
    await pool.query('UPDATE v2_users SET two_factor_enabled = TRUE, two_factor_backup_codes = $1, two_factor_failed_count = 0 WHERE id = $2', [hashedCodes, req.user.id]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: '2fa_enabled', entityType: 'v2_user', entityId: req.user.id });
    await sec.recordAuthEvent(req, { userId: req.user.id, username: req.user.username, event: '2fa_enabled' });
    await sec.notify2faEnabled(req, { id: req.user.id, username: req.user.username });
    return res.json({ data: { message: 'Two-factor authentication enabled.', backupCodes: rawCodes } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to enable 2FA.', code: 'INTERNAL' } });
  }
});

// Disabling requires the current password again (not just an active
// session) — the same "prove you're still you" bar as changing the
// password itself, since this removes a security control.
router.post('/2fa/disable', authenticateToken, async (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: { message: 'Your current password is required.', code: 'VALIDATION' } });
  }
  if (sec.requires2fa({ role: req.user.role, authSource: req.user.authSource })) {
    return res.status(403).json({ error: { message: 'Two-factor authentication is mandatory for your role and cannot be turned off.', code: 'TWO_FACTOR_MANDATORY' } });
  }
  try {
    const r = await pool.query('SELECT password_hash FROM v2_users WHERE id = $1', [req.user.id]);
    const ok = await bcrypt.compare(password, r.rows[0]?.password_hash || '');
    if (!ok) return res.status(401).json({ error: { message: 'Incorrect password.', code: 'AUTH_INVALID' } });
    await pool.query(`UPDATE v2_users SET two_factor_enabled = FALSE, two_factor_secret = NULL, two_factor_backup_codes = '{}' WHERE id = $1`, [req.user.id]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: '2fa_disabled', entityType: 'v2_user', entityId: req.user.id });
    await sec.notifySecurityEvent(req.user.id, 'security.2fa_disabled', 'Two-factor authentication was turned off for your account', null);
    return res.json({ data: { message: 'Two-factor authentication disabled.' } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to disable 2FA.', code: 'INTERNAL' } });
  }
});

// Completes a login that POST /login flagged as requires2FA. Accepts
// EITHER a live TOTP code OR one of the one-time backup codes (the
// recovery path for a lost authenticator device) — a redeemed backup
// code is removed from the array immediately so it can never be reused.
router.post('/2fa/verify-login', authLimiter, async (req, res) => {
  const { pendingToken, code } = req.body || {};
  if (typeof pendingToken !== 'string' || !pendingToken) {
    return res.status(400).json({ error: { message: 'pendingToken is required.', code: 'VALIDATION' } });
  }
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: { message: 'A verification code is required.', code: 'VALIDATION' } });
  }
  let decoded;
  try {
    decoded = jwt.verify(pendingToken, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: { message: 'This login attempt has expired. Please sign in again.', code: 'AUTH_INVALID' } });
  }
  if (decoded.purpose !== '2fa_pending') {
    return res.status(401).json({ error: { message: 'Invalid token.', code: 'AUTH_INVALID' } });
  }
  try {
    const r = await pool.query('SELECT * FROM v2_users WHERE id = $1', [decoded.id]);
    const user = r.rows[0];
    if (!user || !user.two_factor_enabled) {
      return res.status(401).json({ error: { message: 'Invalid token.', code: 'AUTH_INVALID' } });
    }
    // Per-account 2FA attempt limit — the same lock (locked_until, 15
    // minutes) as the password lockout, so a stolen password plus a
    // still-valid pendingToken can't be used to brute-force the code.
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await sec.recordAuthEvent(req, { userId: user.id, username: user.username, event: 'locked' });
      return res.status(401).json({ error: { message: 'Too many incorrect codes. Please try again later.', code: 'AUTH_LOCKED' } });
    }

    const trimmed = code.trim();
    let ok = authenticator.check(trimmed, user.two_factor_secret);
    let usedBackupCode = null;

    if (!ok) {
      // Not a valid live code — check it against the remaining backup
      // codes (bcrypt-compare each, since they're one-way hashed).
      for (const hashed of user.two_factor_backup_codes) {
        if (await bcrypt.compare(trimmed, hashed)) { ok = true; usedBackupCode = hashed; break; }
      }
    }

    if (!ok) {
      await logAudit({ actorId: user.id, actorUsername: user.username, action: 'login_2fa_failed', entityType: 'v2_user', entityId: user.id });
      await sec.recordAuthEvent(req, { userId: user.id, username: user.username, event: '2fa_failed' });
      const upd = await pool.query(
        'UPDATE v2_users SET two_factor_failed_count = two_factor_failed_count + 1, updated_at = NOW() WHERE id = $1 RETURNING two_factor_failed_count',
        [user.id]
      );
      if (upd.rows[0].two_factor_failed_count >= TWO_FACTOR_LOCK_THRESHOLD) {
        await pool.query(
          'UPDATE v2_users SET locked_until = $1, two_factor_failed_count = 0, updated_at = NOW() WHERE id = $2',
          [new Date(Date.now() + LOCK_WINDOW_MS), user.id]
        );
        await logAudit({ actorId: user.id, actorUsername: user.username, action: 'account_locked', entityType: 'v2_user', entityId: user.id, after: { reason: '2fa_attempts' } });
        await sec.recordAuthEvent(req, { userId: user.id, username: user.username, event: 'locked' });
        return res.status(401).json({ error: { message: 'Too many incorrect codes. Please try again later.', code: 'AUTH_LOCKED' } });
      }
      return res.status(401).json({ error: { message: 'Incorrect code.', code: 'AUTH_INVALID' } });
    }
    await pool.query('UPDATE v2_users SET two_factor_failed_count = 0 WHERE id = $1', [user.id]);

    if (usedBackupCode) {
      const remaining = user.two_factor_backup_codes.filter((h) => h !== usedBackupCode);
      await pool.query('UPDATE v2_users SET two_factor_backup_codes = $1 WHERE id = $2', [remaining, user.id]);
      await logAudit({ actorId: user.id, actorUsername: user.username, action: '2fa_backup_code_used', entityType: 'v2_user', entityId: user.id, after: { remaining: remaining.length } });
    }

    const ctx = await resolveAccessContext(user.id);
    if (!ctx || !ctx.authorized) {
      return res.status(401).json({ error: { message: 'Invalid token.', code: 'AUTH_INVALID' } });
    }
    await pool.query('UPDATE v2_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [user.id]);
    await logAudit({ actorId: user.id, actorUsername: user.username, action: 'login', entityType: 'v2_user', entityId: user.id });
    return res.json({ data: await completeLogin(req, user, ctx) });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Verification failed.', code: 'INTERNAL' } });
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

// A single-device logout revokes THIS device's session (its sid) —
// other devices stay logged in. A pre-sessions token (no sid) has
// nothing to revoke server-side and simply expires naturally.
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    if (req.user.sid) await sec.revokeSession(req.user.id, req.user.sid);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'logout', entityType: 'v2_user', entityId: req.user.id });
    await sec.recordAuthEvent(req, { userId: req.user.id, username: req.user.username, event: 'logout' });
    return res.json({ data: { message: 'Logged out.' } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to log out.', code: 'INTERNAL' } });
  }
});

router.post('/logout-all', authenticateToken, async (req, res) => {
  try {
    await pool.query('UPDATE v2_users SET token_version = token_version + 1, updated_at = NOW() WHERE id = $1', [req.user.id]);
    await sec.revokeAllSessions(req.user.id);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'logout_all', entityType: 'v2_user', entityId: req.user.id });
    await sec.recordAuthEvent(req, { userId: req.user.id, username: req.user.username, event: 'logout' });
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
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: { message: 'currentPassword and newPassword are required.', code: 'VALIDATION' } });
  }
  const policy = validatePassword(newPassword, req.user.username);
  if (!policy.ok) return res.status(400).json(policyErrorBody(policy));
  try {
    const r = await pool.query('SELECT * FROM v2_users WHERE id = $1', [req.user.id]);
    const user = r.rows[0];
    if (!user) return res.status(404).json({ error: { message: 'Account not found.', code: 'NOT_FOUND' } });
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: { message: 'Current password is incorrect.', code: 'AUTH_INVALID' } });
    if (await bcrypt.compare(newPassword, user.password_hash)) {
      return res.status(400).json({ error: { message: 'The new password must be different from the current one.', code: 'VALIDATION', reasons: ['same_as_current'] } });
    }
    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // OD-3: password change bumps token_version — invalidates every token
    // issued before this change, everywhere. Matches the Customer
    // Portal's own precedent exactly: immediately issue a FRESH token
    // embedding the new version, so THIS device/request stays logged in
    // uninterrupted while every other outstanding token dies.
    const updated = await pool.query(
      'UPDATE v2_users SET password_hash = $1, token_version = token_version + 1, must_change_password = FALSE, updated_at = NOW() WHERE id = $2 RETURNING token_version',
      [newHash, user.id]
    );
    // Every other session dies with the token_version bump — mark them
    // revoked too so the Active Sessions list stays truthful. THIS
    // device keeps its session (same sid, fresh 24h token). A
    // pre-sessions token (no sid) gets a brand-new session here.
    let sid = req.user.sid;
    if (sid) await sec.extendSession(sid);
    else sid = await sec.createSession(req, user.id);
    await sec.revokeAllSessions(user.id, sid);
    const ctx = await resolveAccessContext(user.id);
    const token = issueStaffToken({ id: user.id, username: user.username, role: ctx.role, zone: ctx.zoneName, tokenVersion: updated.rows[0].token_version, sid });
    await logAudit({ actorId: user.id, actorUsername: user.username, action: 'password_change', entityType: 'v2_user', entityId: user.id });
    await sec.recordAuthEvent(req, { userId: user.id, username: user.username, event: 'password_changed' });
    await sec.notifySecurityEvent(user.id, 'security.password_changed', 'Your password was changed', null);
    return res.json({ data: { message: 'Password changed. You remain signed in on this device — other devices will need to sign in again.', token, ...sec.securityFlags({ role: ctx.role, authSource: ctx.authSource, twoFactorEnabled: ctx.twoFactorEnabled, mustChangePassword: false }) } });
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
  if (typeof token !== 'string' || !token || typeof newPassword !== 'string') {
    return res.status(400).json({ error: { message: 'A valid token and a newPassword are required.', code: 'VALIDATION' } });
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
    const owner = await pool.query('SELECT username FROM v2_users WHERE id = $1', [reset.user_id]);
    const policy = validatePassword(newPassword, owner.rows[0]?.username);
    if (!policy.ok) return res.status(400).json(policyErrorBody(policy));
    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query('UPDATE v2_users SET password_hash = $1, token_version = token_version + 1, must_change_password = FALSE, failed_login_count = 0, locked_until = NULL, updated_at = NOW() WHERE id = $2', [newHash, reset.user_id]);
    await pool.query('UPDATE v2_password_resets SET used_at = NOW() WHERE id = $1', [reset.id]);
    await sec.revokeAllSessions(reset.user_id);
    await logAudit({ actorId: reset.user_id, action: 'password_reset', entityType: 'v2_user', entityId: reset.user_id, after: { stage: 'confirmed' } });
    await sec.recordAuthEvent(req, { userId: reset.user_id, username: owner.rows[0]?.username, event: 'password_changed' });
    await sec.notifySecurityEvent(reset.user_id, 'security.password_changed', 'Your password was reset', null);
    return res.json({ data: { message: 'Password reset. Please log in with your new password.' } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to reset password.', code: 'INTERNAL' } });
  }
});

// ==================================================================
// ACCOUNT SECURITY — status, login history, active sessions
// ==================================================================

// What the client needs to decide whether to force the Change Password
// screen / the mandatory-2FA banner (survives a page reload, unlike the
// login response). Reachable while either gate is active.
router.get('/security-status', authenticateToken, (req, res) => {
  // A not-yet-migrated (legacy-claims) user has no v2_users row, so the
  // server gates never apply to them — report nothing pending.
  if (req.user.twoFactorEnabled === undefined) {
    return res.json({ data: { must_change_password: false, must_enroll_2fa: false, two_factor_required: false, two_factor_enabled: false } });
  }
  return res.json({ data: { ...sec.securityFlags({ role: req.user.role, authSource: req.user.authSource, twoFactorEnabled: req.user.twoFactorEnabled, mustChangePassword: req.user.mustChangePassword }), two_factor_enabled: !!req.user.twoFactorEnabled } });
});

router.get('/login-history', authenticateToken, async (req, res) => {
  try {
    return res.json({ data: await sec.loginHistory(req.user.id, 50) });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load login history.', code: 'INTERNAL' } });
  }
});

router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    return res.json({ data: await sec.listSessions(req.user.id, req.user.sid) });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load sessions.', code: 'INTERNAL' } });
  }
});

// Own sessions only — a not-found-or-not-owned id is a 404 either way.
router.post('/sessions/:id/revoke', authenticateToken, async (req, res) => {
  try {
    const ok = await sec.revokeSession(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ error: { message: 'Session not found.', code: 'NOT_FOUND' } });
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'session_revoke', entityType: 'v2_user', entityId: req.user.id, after: { session_id: req.params.id } });
    return res.json({ data: { message: 'Session signed out.', current: req.params.id === req.user.sid } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to revoke session.', code: 'INTERNAL' } });
  }
});

module.exports = router;
