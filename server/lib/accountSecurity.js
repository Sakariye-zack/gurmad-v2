const crypto = require('crypto');
const { pool } = require('../db');
const logger = require('./logger');
const { createStaffNotification, logNotificationFailure } = require('./staffNotifications');

// Account security (feat/account-security) — login history, active
// sessions, new-device alerts, and the mandatory-2FA / forced-password-
// change request gates. Every side-effect writer here (history row,
// notification) is best-effort: a failure is logged, never thrown into
// the login/logout flow it describes.

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // matches STAFF_TOKEN_TTL (24h)
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

// ------------------------------------------------------------------
// Mandatory 2FA roles. Default: admin + gudoomiye. Overridable with the
// MANDATORY_2FA_ROLES env var (comma-separated role keys; 'none' or an
// empty string = no role requires 2FA). The test runner (test/run.js)
// points this at a dedicated test-only role so the gate can be tested
// end-to-end without gating every existing test's admin/gudoomiye user.
// ------------------------------------------------------------------
const DEFAULT_MANDATORY_2FA_ROLES = ['admin', 'gudoomiye'];
function parseMandatory2faRoles(raw) {
  if (raw === undefined || raw === null) return [...DEFAULT_MANDATORY_2FA_ROLES];
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === 'none') return [];
  return s.split(',').map((r) => r.trim()).filter(Boolean);
}
const MANDATORY_2FA_ROLES = parseMandatory2faRoles(process.env.MANDATORY_2FA_ROLES);
function roleRequires2fa(role) {
  return MANDATORY_2FA_ROLES.includes(role);
}

// ------------------------------------------------------------------
// Request gates (called from middleware/auth.js after authentication).
// Paths are matched against the full /api/v2/... path.
// ------------------------------------------------------------------
const PASSWORD_CHANGE_ALLOWED = [
  /^\/api\/v2\/auth\/password\/change$/,
  /^\/api\/v2\/auth\/logout(-all)?$/,
  /^\/api\/v2\/auth\/my-permissions$/,
  /^\/api\/v2\/auth\/security-status$/,
  /^\/api\/v2\/settings\/company(\/.*)?$/,
];
const TWO_FACTOR_ALLOWED = [
  /^\/api\/v2\/auth(\/.*)?$/, // includes 2fa/setup, 2fa/enable, my-permissions, logout, sessions, history
  /^\/api\/v2\/settings\/company(\/.*)?$/,
  /^\/api\/v2\/staff-notifications(\/.*)?$/,
];

// Returns null (allowed) or { status, body } to send.
function evaluateSecurityGates(ctx, fullPath) {
  const path = (fullPath || '').split('?')[0].replace(/\/+$/, '');
  if (ctx.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.some((re) => re.test(path))) {
    return { status: 403, body: { error: { message: 'You must change your password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' } } };
  }
  if (!ctx.twoFactorEnabled && roleRequires2fa(ctx.role) && !TWO_FACTOR_ALLOWED.some((re) => re.test(path))) {
    return { status: 403, body: { error: { message: 'Two-factor authentication is required for your role. Enable it in Account Security.', code: 'TWO_FACTOR_REQUIRED' } } };
  }
  return null;
}

function securityFlags({ role, twoFactorEnabled, mustChangePassword }) {
  return {
    must_change_password: !!mustChangePassword,
    must_enroll_2fa: !twoFactorEnabled && roleRequires2fa(role),
    two_factor_required: roleRequires2fa(role),
  };
}

// ------------------------------------------------------------------
// Request metadata. req.ip honours app.set('trust proxy', 1) in index.js
// (nginx is the single trusted hop), so it's the real client IP — never
// a raw, spoofable X-Forwarded-For first entry.
// ------------------------------------------------------------------
function requestIp(req) {
  const ip = req.ip || req.socket?.remoteAddress || null;
  return ip && ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
function requestUserAgent(req) {
  const ua = req.headers['user-agent'];
  return ua ? String(ua).slice(0, 500) : null;
}

// Short human label for a user agent: "Chrome on Windows".
function describeUserAgent(ua) {
  if (!ua) return 'Unknown device';
  let browser = 'Unknown browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  else browser = ua.split(/[\s/]/)[0].slice(0, 40) || browser;
  let os = '';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) os = 'iOS';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return os ? `${browser} on ${os}` : browser;
}

// ------------------------------------------------------------------
// Login history
// ------------------------------------------------------------------
async function recordAuthEvent(req, { userId = null, username = null, event }) {
  try {
    await pool.query(
      'INSERT INTO auth_events (user_id, username_attempted, event, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
      [userId, username ? String(username).slice(0, 100) : null, event, requestIp(req), requestUserAgent(req)]
    );
  } catch (err) {
    logger.error('auth_event_record_failed', { event, message: err.message });
  }
}

async function loginHistory(userId, limit = 50) {
  const r = await pool.query(
    'SELECT id, event, ip, user_agent, created_at FROM auth_events WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [userId, limit]
  );
  return r.rows.map((row) => ({ ...row, device: describeUserAgent(row.user_agent) }));
}

async function notifySecurityEvent(userId, eventType, title, body) {
  try {
    await createStaffNotification({ recipientId: userId, eventType, title, body, entityType: 'v2_user', entityId: userId });
  } catch (err) {
    logNotificationFailure(eventType, err);
  }
}

// A successful sign-in from an IP + user-agent pair this user has never
// successfully signed in from before. Skipped for a user's very first
// recorded login (no history yet — e.g. the first sign-in after this
// feature deploys), so nobody gets a spurious alert on day one.
async function recordSuccessfulLogin(req, user) {
  const ip = requestIp(req);
  const ua = requestUserAgent(req);
  try {
    const prior = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ip IS NOT DISTINCT FROM $2 AND user_agent IS NOT DISTINCT FROM $3)::int AS same
       FROM auth_events WHERE user_id = $1 AND event = 'login_success'`,
      [user.id, ip, ua]
    );
    const { total, same } = prior.rows[0];
    if (total > 0 && same === 0) {
      await notifySecurityEvent(user.id, 'security.new_login', `New sign-in from ${describeUserAgent(ua)} · ${ip || 'unknown IP'}`, null);
    }
  } catch (err) {
    logger.error('new_login_check_failed', { message: err.message });
  }
  await recordAuthEvent(req, { userId: user.id, username: user.username, event: 'login_success' });
}

// ------------------------------------------------------------------
// Sessions
// ------------------------------------------------------------------
async function createSession(req, userId) {
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO user_sessions (id, user_id, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
    [id, userId, new Date(Date.now() + SESSION_TTL_MS), requestIp(req), requestUserAgent(req)]
  );
  return id;
}

// A re-issued token (password change) gets a fresh 24h lifetime — keep
// the session row's own expiry in step so it stays listed.
async function extendSession(sid) {
  if (!sid) return;
  await pool.query('UPDATE user_sessions SET expires_at = $1 WHERE id = $2', [new Date(Date.now() + SESSION_TTL_MS), sid]);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Called on every authenticated request carrying a sid. Returns false if
// the session is revoked/unknown. last_seen_at is written at most once
// per 5 minutes per session.
async function checkSession(sid, userId) {
  if (typeof sid !== 'string' || !UUID_RE.test(sid)) return false;
  const r = await pool.query('SELECT user_id, revoked_at, last_seen_at FROM user_sessions WHERE id = $1', [sid]);
  const s = r.rows[0];
  if (!s || s.user_id !== userId || s.revoked_at) return false;
  if (Date.now() - new Date(s.last_seen_at).getTime() > LAST_SEEN_THROTTLE_MS) {
    pool.query('UPDATE user_sessions SET last_seen_at = NOW() WHERE id = $1', [sid]).catch(() => {});
  }
  return true;
}

async function listSessions(userId, currentSid) {
  const r = await pool.query(
    `SELECT id, created_at, last_seen_at, ip, user_agent FROM user_sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
     ORDER BY last_seen_at DESC`,
    [userId]
  );
  return r.rows.map((row) => ({ ...row, device: describeUserAgent(row.user_agent), current: row.id === currentSid }));
}

async function revokeSession(userId, sid) {
  if (typeof sid !== 'string' || !UUID_RE.test(sid)) return false;
  const r = await pool.query(
    'UPDATE user_sessions SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
    [sid, userId]
  );
  return r.rows.length > 0;
}

// Revoke every open session for a user, optionally keeping one.
async function revokeAllSessions(userId, exceptSid = null, client = pool) {
  await client.query(
    'UPDATE user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)',
    [userId, exceptSid && UUID_RE.test(exceptSid) ? exceptSid : null]
  );
}

module.exports = {
  DEFAULT_MANDATORY_2FA_ROLES,
  MANDATORY_2FA_ROLES,
  parseMandatory2faRoles,
  roleRequires2fa,
  evaluateSecurityGates,
  securityFlags,
  requestIp,
  describeUserAgent,
  recordAuthEvent,
  recordSuccessfulLogin,
  loginHistory,
  notifySecurityEvent,
  createSession,
  extendSession,
  checkSession,
  listSessions,
  revokeSession,
  revokeAllSessions,
};
