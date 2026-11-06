// Account security (feat/account-security): trust proxy, login history,
// sessions, new-device alerts, mandatory 2FA gate, password policy, and
// forced password change.
//
// Mandatory-2FA note: test/run.js sets MANDATORY_2FA_ROLES=sec_mfa_test so
// the shared world's admin/gudoomiye users are NOT gated (that would break
// every other test file). The gate is exercised end-to-end here with a
// user of that dedicated role; the production default (admin, gudoomiye)
// is unit-tested via parseMandatory2faRoles().
const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const { api, db, insertUser, login, tokenFor, setupWorld, PASSWORD } = require('./helpers');
const { validatePassword } = require('../lib/passwordPolicy');
const { parseMandatory2faRoles, describeUserAgent } = require('../lib/accountSecurity');
const { configureTrustProxy } = require('../lib/trustProxy');

const UA_A = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const UA_B = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

function loginWith(username, password, headers) {
  return api('POST', '/auth/login', { body: { username, password }, headers });
}
async function userId(username) {
  return (await db.query('SELECT id FROM v2_users WHERE username = $1', [username])).rows[0].id;
}

test('trust proxy is opt-in: off unless TRUST_PROXY=1, then loopback hops only', () => {
  const calls = [];
  const fakeApp = { set: (k, v) => calls.push([k, v]) };
  assert.equal(configureTrustProxy(fakeApp, {}), false);
  assert.equal(configureTrustProxy(fakeApp, { TRUST_PROXY: 'true' }), false);
  assert.deepEqual(calls, [], 'default: trust proxy untouched (req.ip = socket address)');
  assert.equal(configureTrustProxy(fakeApp, { TRUST_PROXY: '1' }), true);
  assert.deepEqual(calls, [['trust proxy', 'loopback']]);
});

// The test server runs with TRUST_PROXY=1 (test/run.js).
test('trust proxy (enabled): req.ip comes from X-Forwarded-For (one trusted hop), recorded per client', async () => {
  await insertUser('t_sec_ip', 'cashier');
  const a = await loginWith('t_sec_ip', PASSWORD, { 'X-Forwarded-For': '203.0.113.7' });
  assert.equal(a.status, 200);
  const b = await loginWith('t_sec_ip', PASSWORD, { 'X-Forwarded-For': '198.51.100.9' });
  assert.equal(b.status, 200);
  const hist = await api('GET', '/auth/login-history', { token: b.data.token });
  assert.equal(hist.status, 200);
  const ips = hist.data.filter((e) => e.event === 'login_success').map((e) => e.ip);
  assert.ok(ips.includes('203.0.113.7'), 'first client IP recorded: ' + JSON.stringify(ips));
  assert.ok(ips.includes('198.51.100.9'), 'second client IP recorded separately');
  // Only the right-most (proxy-written) entry is trusted — a client-supplied
  // left-hand entry cannot spoof the address.
  const c = await loginWith('t_sec_ip', PASSWORD, { 'X-Forwarded-For': '6.6.6.6, 192.0.2.44' });
  const hist2 = await api('GET', '/auth/login-history', { token: c.data.token });
  assert.equal(hist2.data[0].ip, '192.0.2.44');
});

test('login history: success, failure, unknown user, 2FA failure, logout, password change are recorded; admin can view', async () => {
  const { tokens } = await setupWorld();
  const id = await insertUser('t_sec_hist', 'cashier');
  assert.equal((await login('t_sec_hist', 'wrong-password')).status, 401);
  assert.equal((await loginWith('t_sec_hist_nobody', 'whatever', { 'X-Forwarded-For': '192.0.2.200' })).status, 401);
  const tok = await tokenFor('t_sec_hist');
  const changed = await api('POST', '/auth/password/change', { token: tok, body: { currentPassword: PASSWORD, newPassword: 'Hist-Secure-2026' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal((await api('POST', '/auth/logout', { token: changed.data.token, body: {} })).status, 200);

  const rows = (await db.query('SELECT event FROM auth_events WHERE user_id = $1 ORDER BY id', [id])).rows.map((r) => r.event);
  for (const e of ['login_failed', 'login_success', 'password_changed', 'logout']) assert.ok(rows.includes(e), `${e} recorded: ${rows}`);
  const unknown = await db.query("SELECT user_id, username_attempted FROM auth_events WHERE ip = '192.0.2.200'");
  assert.equal(unknown.rows.length, 1);
  assert.equal(unknown.rows[0].user_id, null, 'unknown username has no user_id');
  assert.equal(unknown.rows[0].username_attempted, null, 'an unmatched username (maybe a mistyped password) is never stored');
  assert.equal((await db.query("SELECT 1 FROM auth_events WHERE username_attempted = 't_sec_hist_nobody'")).rows.length, 0);

  // 2FA failure
  const id2 = await insertUser('t_sec_hist2fa', 'cashier');
  const t2 = await tokenFor('t_sec_hist2fa');
  const setup = await api('POST', '/auth/2fa/setup', { token: t2, body: {} });
  assert.equal((await api('POST', '/auth/2fa/enable', { token: t2, body: { code: authenticator.generate(setup.data.secret) } })).status, 200);
  const pending = await login('t_sec_hist2fa');
  assert.equal(pending.data.requires2FA, true);
  assert.equal((await api('POST', '/auth/2fa/verify-login', { body: { pendingToken: pending.data.pendingToken, code: '000000x' } })).status, 401);
  const r2 = await db.query("SELECT 1 FROM auth_events WHERE user_id = $1 AND event = '2fa_failed'", [id2]);
  assert.equal(r2.rows.length, 1);

  // Own history only; admin endpoint is admin-only.
  const fresh = await tokenFor('t_sec_hist2fa').catch(() => null);
  assert.equal(fresh, null, '2FA user gets no token from password alone');
  const own = await api('GET', '/auth/login-history', { token: tokens.cashier });
  assert.ok(own.data.every((e) => e.event), 'rows have events');
  const adminView = await api('GET', `/users/${id}/login-history`, { token: tokens.admin });
  assert.equal(adminView.status, 200);
  assert.ok(adminView.data.length >= 4);
  assert.equal((await api('GET', `/users/${id}/login-history`, { token: tokens.cashier })).status, 403);
});

test('a pending-2FA token can never be used as a session token', async () => {
  await insertUser('t_sec_pend', 'cashier');
  const t = await tokenFor('t_sec_pend');
  const setup = await api('POST', '/auth/2fa/setup', { token: t, body: {} });
  await api('POST', '/auth/2fa/enable', { token: t, body: { code: authenticator.generate(setup.data.secret) } });
  const pending = await login('t_sec_pend');
  assert.equal((await api('GET', '/auth/my-permissions', { token: pending.data.pendingToken })).status, 401);
});

test('sessions: login creates a session (sid), list marks current, revoke -> 401 SESSION_REVOKED, logout revokes, sid-less tokens still work', async () => {
  const id = await insertUser('t_sec_sess', 'cashier');
  const a = (await loginWith('t_sec_sess', PASSWORD, { 'User-Agent': UA_A })).data.token;
  const b = (await loginWith('t_sec_sess', PASSWORD, { 'User-Agent': UA_B })).data.token;
  assert.ok(jwt.decode(a).sid, 'token carries sid');

  const list = await api('GET', '/auth/sessions', { token: a });
  assert.equal(list.status, 200);
  assert.ok(list.data.length >= 2);
  const current = list.data.filter((s) => s.current);
  assert.equal(current.length, 1);
  assert.equal(current[0].id, jwt.decode(a).sid);

  // Revoke B from A.
  const sidB = jwt.decode(b).sid;
  assert.equal((await api('POST', `/auth/sessions/${sidB}/revoke`, { token: a, body: {} })).status, 200);
  const dead = await api('GET', '/auth/my-permissions', { token: b });
  assert.equal(dead.status, 401);
  assert.equal(dead.body.error.code, 'SESSION_REVOKED');
  assert.equal((await api('GET', '/auth/my-permissions', { token: a })).status, 200, 'other session unaffected');

  // Cannot revoke someone else's session.
  await insertUser('t_sec_other', 'cashier');
  const other = await tokenFor('t_sec_other');
  assert.equal((await api('POST', `/auth/sessions/${jwt.decode(a).sid}/revoke`, { token: other, body: {} })).status, 404);
  assert.equal((await api('POST', '/auth/sessions/not-a-uuid/revoke', { token: other, body: {} })).status, 404);

  // Logout revokes the current session.
  assert.equal((await api('POST', '/auth/logout', { token: a, body: {} })).status, 200);
  assert.equal((await api('GET', '/auth/my-permissions', { token: a })).status, 401);

  // A pre-deploy token (no sid) keeps working until it expires.
  const tv = (await db.query('SELECT token_version FROM v2_users WHERE id = $1', [id])).rows[0].token_version;
  const legacy = jwt.sign({ id, username: 't_sec_sess', role: 'cashier', zone: null, tokenVersion: tv }, process.env.JWT_SECRET, { expiresIn: '1h' });
  assert.equal((await api('GET', '/auth/my-permissions', { token: legacy })).status, 200);

  // A forged sid that doesn't exist is rejected.
  const forged = jwt.sign({ id, username: 't_sec_sess', role: 'cashier', zone: null, tokenVersion: tv, sid: '00000000-0000-4000-8000-000000000000' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  assert.equal((await api('GET', '/auth/my-permissions', { token: forged })).status, 401);
});

test('logout-all revokes every session and bumps token_version', async () => {
  const id = await insertUser('t_sec_all', 'cashier');
  const a = await tokenFor('t_sec_all');
  const b = await tokenFor('t_sec_all');
  assert.equal((await api('POST', '/auth/logout-all', { token: a, body: {} })).status, 200);
  assert.equal((await api('GET', '/auth/my-permissions', { token: b })).status, 401);
  const open = await db.query('SELECT 1 FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL', [id]);
  assert.equal(open.rows.length, 0);
});

test('new-login alert: notified once for a new IP+device, not for a repeat, not on the first-ever login', async () => {
  const id = await insertUser('t_sec_alert', 'cashier');
  const count = async () => (await db.query("SELECT COUNT(*)::int AS n FROM v2_staff_notifications WHERE recipient_id = $1 AND event_type = 'security.new_login'", [id])).rows[0].n;
  await loginWith('t_sec_alert', PASSWORD, { 'User-Agent': UA_A, 'X-Forwarded-For': '192.0.2.10' });
  assert.equal(await count(), 0, 'first-ever login is not an alert');
  await loginWith('t_sec_alert', PASSWORD, { 'User-Agent': UA_A, 'X-Forwarded-For': '192.0.2.10' });
  assert.equal(await count(), 0, 'same device again: no alert');
  const r = await loginWith('t_sec_alert', PASSWORD, { 'User-Agent': UA_B, 'X-Forwarded-For': '192.0.2.11' });
  assert.equal(await count(), 1, 'new device: one alert');
  await loginWith('t_sec_alert', PASSWORD, { 'User-Agent': UA_B, 'X-Forwarded-For': '192.0.2.11' });
  assert.equal(await count(), 1, 'repeat of the new device: still one alert');
  const notes = await api('GET', '/staff-notifications', { token: r.data.token });
  const alert = notes.data.find((n) => n.event_type === 'security.new_login');
  assert.match(alert.title, /Chrome on Android · 192\.0\.2\.11/);
  assert.equal(describeUserAgent(UA_A), 'Chrome on Windows');
  const evil = describeUserAgent('Evil\u0007\nBot/1.0 ' + 'x'.repeat(200));
  assert.ok(!/[\u0000-\u001f]/.test(evil), 'control characters stripped');
  assert.ok(evil.length <= 40, 'label capped at 40 chars');
});

test('password change and 2FA disable create security notifications', async () => {
  const id = await insertUser('t_sec_notif', 'cashier');
  const t = await tokenFor('t_sec_notif');
  const ch = await api('POST', '/auth/password/change', { token: t, body: { currentPassword: PASSWORD, newPassword: 'Notif-Secure-2026' } });
  assert.equal(ch.status, 200);
  const t2 = ch.data.token;
  const setup = await api('POST', '/auth/2fa/setup', { token: t2, body: {} });
  await api('POST', '/auth/2fa/enable', { token: t2, body: { code: authenticator.generate(setup.data.secret) } });
  assert.equal((await api('POST', '/auth/2fa/disable', { token: t2, body: { password: 'Notif-Secure-2026' } })).status, 200);
  const types = (await db.query('SELECT event_type FROM v2_staff_notifications WHERE recipient_id = $1', [id])).rows.map((r) => r.event_type);
  assert.ok(types.includes('security.password_changed'));
  assert.ok(types.includes('security.2fa_disabled'));
});

test('mandatory 2FA: default roles are admin + gudoomiye; override parses', () => {
  assert.deepEqual(parseMandatory2faRoles(undefined), ['admin', 'gudoomiye']);
  assert.deepEqual(parseMandatory2faRoles('none'), []);
  assert.deepEqual(parseMandatory2faRoles(''), []);
  assert.deepEqual(parseMandatory2faRoles(' a, b '), ['a', 'b']);
});

test('mandatory 2FA gate: 403 TWO_FACTOR_REQUIRED until enabled, setup/enable/logout reachable, cannot disable', async () => {
  await db.query("INSERT INTO roles (key, label, is_system) VALUES ('sec_mfa_test', 'Security MFA test role', FALSE) ON CONFLICT (key) DO NOTHING");
  await insertUser('t_sec_mfa', 'sec_mfa_test');
  const r = await login('t_sec_mfa');
  assert.equal(r.status, 200, 'login itself still succeeds');
  assert.equal(r.data.user.must_enroll_2fa, true);
  const tok = r.data.token;

  const blocked = await api('GET', '/staff-tasks/my', { token: tok });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'TWO_FACTOR_REQUIRED');
  // Narrow allowlist: no password change, no notification writes, no
  // settings writes while held.
  const pw = await api('POST', '/auth/password/change', { token: tok, body: { currentPassword: PASSWORD, newPassword: 'Held-Account-2026' } });
  assert.equal(pw.body.error?.code, 'TWO_FACTOR_REQUIRED');
  assert.equal((await api('PUT', '/staff-notifications/read-all', { token: tok, body: {} })).body.error?.code, 'TWO_FACTOR_REQUIRED');
  assert.equal((await api('PUT', '/settings/company', { token: tok, body: {} })).body.error?.code, 'TWO_FACTOR_REQUIRED');
  assert.equal((await api('GET', '/auth/sessions', { token: tok })).status, 200);
  assert.equal((await api('GET', '/auth/login-history', { token: tok })).status, 200);
  assert.equal((await api('GET', '/auth/2fa/status', { token: tok })).status, 200);
  assert.equal((await api('GET', '/auth/my-permissions', { token: tok })).status, 200);
  assert.equal((await api('GET', '/staff-notifications', { token: tok })).status, 200);
  // GET /settings/company is admin-only (FORBIDDEN for this role) — but the 2FA gate itself must not fire there.
  assert.notEqual((await api('GET', '/settings/company', { token: tok })).body.error?.code, 'TWO_FACTOR_REQUIRED');
  const status = await api('GET', '/auth/security-status', { token: tok });
  assert.equal(status.data.must_enroll_2fa, true);

  const setup = await api('POST', '/auth/2fa/setup', { token: tok, body: {} });
  assert.equal(setup.status, 200);
  const en = await api('POST', '/auth/2fa/enable', { token: tok, body: { code: authenticator.generate(setup.data.secret) } });
  assert.equal(en.status, 200);
  const mfaId = await userId('t_sec_mfa');
  assert.equal((await db.query("SELECT 1 FROM auth_events WHERE user_id = $1 AND event = '2fa_enabled'", [mfaId])).rows.length, 1);
  assert.equal((await db.query("SELECT 1 FROM v2_staff_notifications WHERE recipient_id = $1 AND event_type = 'security.2fa_enabled'", [mfaId])).rows.length, 1, 'user notified');
  const adminId = await userId('t_admin');
  const adminNote = await db.query("SELECT title FROM v2_staff_notifications WHERE recipient_id = $1 AND event_type = 'security.2fa_enabled' AND title LIKE 't_sec_mfa enabled%'", [adminId]);
  assert.equal(adminNote.rows.length, 1, 'other active admins notified');

  // No re-keying while enabled.
  const again = await api('POST', '/auth/2fa/setup', { token: tok, body: {} });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'TWO_FACTOR_ALREADY_ENABLED');
  assert.equal((await api('POST', '/auth/2fa/enable', { token: tok, body: { code: '123456' } })).status, 409);

  assert.equal((await api('GET', '/staff-tasks/my', { token: tok })).status, 200, 'unblocked after enabling');
  assert.equal((await api('GET', '/auth/security-status', { token: tok })).data.must_enroll_2fa, false);
  const dis = await api('POST', '/auth/2fa/disable', { token: tok, body: { password: PASSWORD } });
  assert.equal(dis.status, 403);
  assert.equal(dis.body.error.code, 'TWO_FACTOR_MANDATORY');
  assert.equal((await api('POST', '/auth/logout', { token: tok, body: {} })).status, 200);
});

test('mandatory 2FA gate skips accounts not on auth_source v2', async () => {
  await db.query("INSERT INTO roles (key, label, is_system) VALUES ('sec_mfa_test', 'Security MFA test role', FALSE) ON CONFLICT (key) DO NOTHING");
  const id = await insertUser('t_sec_mfa_legacy', 'sec_mfa_test');
  await db.query("UPDATE v2_users SET auth_source = 'legacy' WHERE id = $1", [id]);
  const tv = (await db.query('SELECT token_version FROM v2_users WHERE id = $1', [id])).rows[0].token_version;
  const tok = jwt.sign({ id, username: 't_sec_mfa_legacy', role: 'sec_mfa_test', zone: null, tokenVersion: tv }, process.env.JWT_SECRET, { expiresIn: '1h' });
  assert.equal((await api('GET', '/staff-tasks/my', { token: tok })).status, 200);
  assert.equal((await api('GET', '/auth/security-status', { token: tok })).data.must_enroll_2fa, false);
});

async function enroll2fa(username) {
  const t = await tokenFor(username);
  const setup = await api('POST', '/auth/2fa/setup', { token: t, body: {} });
  const en = await api('POST', '/auth/2fa/enable', { token: t, body: { code: authenticator.generate(setup.data.secret) } });
  assert.equal(en.status, 200);
  return { token: t, secret: setup.data.secret };
}

test('2FA attempt limit: 5 consecutive wrong codes lock the account; a success resets the count', async () => {
  const id = await insertUser('t_sec_2falock', 'cashier');
  const { secret } = await enroll2fa('t_sec_2falock');

  // 4 wrong then right -> counter reset.
  let p = (await login('t_sec_2falock')).data.pendingToken;
  for (let i = 0; i < 4; i++) {
    assert.equal((await api('POST', '/auth/2fa/verify-login', { body: { pendingToken: p, code: 'bad-code' } })).body.error.code, 'AUTH_INVALID');
  }
  const okLogin = await api('POST', '/auth/2fa/verify-login', { body: { pendingToken: p, code: authenticator.generate(secret) } });
  assert.equal(okLogin.status, 200);
  assert.equal((await db.query('SELECT two_factor_failed_count FROM v2_users WHERE id = $1', [id])).rows[0].two_factor_failed_count, 0);

  // 5 wrong -> locked.
  p = (await login('t_sec_2falock')).data.pendingToken;
  let last;
  for (let i = 0; i < 5; i++) last = await api('POST', '/auth/2fa/verify-login', { body: { pendingToken: p, code: 'bad-code' } });
  assert.equal(last.status, 401);
  assert.equal(last.body.error.code, 'AUTH_LOCKED');
  const lockedRow = (await db.query('SELECT locked_until FROM v2_users WHERE id = $1', [id])).rows[0];
  assert.ok(lockedRow.locked_until && new Date(lockedRow.locked_until) > new Date(), 'locked_until set');
  assert.ok((await db.query("SELECT 1 FROM auth_events WHERE user_id = $1 AND event = 'locked'", [id])).rows.length >= 1);
  // Even the right code is refused while locked, and so is the password step.
  assert.equal((await api('POST', '/auth/2fa/verify-login', { body: { pendingToken: p, code: authenticator.generate(secret) } })).body.error.code, 'AUTH_LOCKED');
  assert.equal((await login('t_sec_2falock')).status, 401);
});

test('admin 2FA reset: clears 2FA, revokes sessions, notifies; admin-only, not on self', async () => {
  const { tokens } = await setupWorld();
  const id = await insertUser('t_sec_2fareset', 'cashier');
  const { token: userTok } = await enroll2fa('t_sec_2fareset');
  const adminId = await userId('t_admin');

  assert.equal((await api('POST', `/users/${id}/2fa/reset`, { token: tokens.cashier, body: {} })).status, 403, 'non-admin');
  assert.equal((await api('POST', `/users/${adminId}/2fa/reset`, { token: tokens.admin, body: {} })).status, 400, 'not on self');
  assert.equal((await api('POST', '/users/999999/2fa/reset', { token: tokens.admin, body: {} })).status, 404);
  const r = await api('POST', `/users/${id}/2fa/reset`, { token: tokens.admin, body: {} });
  assert.equal(r.status, 200);

  const row = (await db.query('SELECT two_factor_enabled, two_factor_secret, two_factor_backup_codes FROM v2_users WHERE id = $1', [id])).rows[0];
  assert.equal(row.two_factor_enabled, false);
  assert.equal(row.two_factor_secret, null);
  assert.deepEqual(row.two_factor_backup_codes, []);
  assert.equal((await api('GET', '/auth/my-permissions', { token: userTok })).status, 401, 'sessions revoked');
  assert.equal((await db.query('SELECT 1 FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL', [id])).rows.length, 0);
  assert.equal((await db.query("SELECT 1 FROM v2_staff_notifications WHERE recipient_id = $1 AND event_type = 'security.2fa_reset'", [id])).rows.length, 1);
  assert.equal((await db.query("SELECT 1 FROM v2_audit_log WHERE action = '2fa_reset_by_admin' AND entity_id::text = $1", [String(id)])).rows.length, 1);
  const fresh = await login('t_sec_2fareset');
  assert.ok(fresh.data.token, 'password-only login works again');
});

test('password policy: unit rules', () => {
  assert.equal(validatePassword('short1', 'u').ok, false);
  assert.deepEqual(validatePassword('abcdefghijk', 'u').errors, ['needs_digit']);
  assert.deepEqual(validatePassword('12345678901', 'u').errors, ['needs_letter']);
  for (const p of ['12345678', 'password', 'qwerty123', 'gurmad123', '1234567890']) assert.equal(validatePassword(p, 'u').ok, false, p);
  assert.ok(validatePassword('Password123', 'u').errors.includes('too_common'));
  assert.ok(validatePassword('ahmed12345', 'Ahmed12345').errors.includes('same_as_username'));
  assert.equal(validatePassword('Blue-Camel-2026', 'u').ok, true);
});

test('password policy: enforced on change, admin create and admin reset', async () => {
  const { tokens } = await setupWorld();
  const id = await insertUser('t_sec_pol', 'cashier');
  const t = await tokenFor('t_sec_pol');
  for (const weak of ['short1', 'qwerty123', 'gurmad123', 'onlyletterspw', 't_sec_pol']) {
    const r = await api('POST', '/auth/password/change', { token: t, body: { currentPassword: PASSWORD, newPassword: weak } });
    assert.equal(r.status, 400, weak);
    assert.ok(Array.isArray(r.body.error.reasons), 'reasons listed');
  }
  const bad = await api('POST', '/users', { token: tokens.admin, body: { username: 't_sec_weak', password: 'password', role: 'cashier' } });
  assert.equal(bad.status, 400);
  assert.equal((await api('PUT', `/users/${id}/password`, { token: tokens.admin, body: { password: '1234567890' } })).status, 400);
  assert.equal((await api('POST', '/auth/password/change', { token: t, body: { currentPassword: PASSWORD, newPassword: 'Strong-Policy-2026' } })).status, 200);
});

test('forced password change: admin-created user is gated until they change it; admin reset sets it again', async () => {
  const { tokens } = await setupWorld();
  const created = await api('POST', '/users', { token: tokens.admin, body: { username: 't_sec_new', password: 'Welcome-Temp-2026', role: 'cashier' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.data.must_change_password, true);

  const r = await login('t_sec_new', 'Welcome-Temp-2026');
  assert.equal(r.status, 200);
  assert.equal(r.data.user.must_change_password, true);
  const tok = r.data.token;
  const blocked = await api('GET', '/staff-tasks/my', { token: tok });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await api('GET', '/auth/my-permissions', { token: tok })).status, 200);
  assert.equal((await api('GET', '/auth/sessions', { token: tok })).status, 403, 'other auth routes stay blocked');

  const ch = await api('POST', '/auth/password/change', { token: tok, body: { currentPassword: 'Welcome-Temp-2026', newPassword: 'My-Own-Secret-77' } });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  assert.equal(ch.data.must_change_password, false);
  assert.equal((await api('GET', '/staff-tasks/my', { token: ch.data.token })).status, 200);
  assert.equal((await login('t_sec_new', 'My-Own-Secret-77')).data.user.must_change_password, false);

  const id = await userId('t_sec_new');
  assert.equal((await api('PUT', `/users/${id}/password`, { token: tokens.admin, body: { password: 'Reset-By-Admin-9' } })).status, 200);
  const again = await login('t_sec_new', 'Reset-By-Admin-9');
  assert.equal(again.data.user.must_change_password, true);
  assert.equal((await api('GET', '/staff-tasks/my', { token: again.data.token })).body.error.code, 'PASSWORD_CHANGE_REQUIRED');
});
