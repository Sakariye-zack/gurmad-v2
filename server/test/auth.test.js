const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, insertUser, login, tokenFor, setupWorld, PASSWORD } = require('./helpers');

test('login: correct credentials return a token; wrong password is 401 with a generic message', async () => {
  await setupWorld();
  const ok = await login('t_admin');
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
  const bad = await login('t_admin', 'wrong-password');
  assert.equal(bad.status, 401);
  const unknown = await login('no_such_user', 'whatever');
  assert.equal(unknown.status, 401);
  assert.equal(bad.body.error.message, unknown.body.error.message, 'unknown user and wrong password must be indistinguishable');
});

test('login: 5 failed attempts lock the account, even for the correct password', async () => {
  await insertUser('t_lockme', 'cashier');
  for (let i = 0; i < 5; i++) await login('t_lockme', 'nope-' + i);
  const locked = await login('t_lockme', PASSWORD);
  assert.notEqual(locked.status, 200, 'correct password must not work while locked');
  await db.query("UPDATE v2_users SET locked_until = NULL, failed_login_count = 0 WHERE username = 't_lockme'");
  assert.equal((await login('t_lockme', PASSWORD)).status, 200, 'works again once the lock is cleared');
});

test('protected routes reject missing and garbage tokens', async () => {
  assert.equal((await api('GET', '/users')).status, 401);
  assert.equal((await api('GET', '/users', { token: 'garbage.token.value' })).status, 401);
});

test('users admin API is admin-only', async () => {
  const { tokens } = await setupWorld();
  assert.equal((await api('GET', '/users', { token: tokens.admin })).status, 200);
  for (const r of ['gudoomiye', 'accountant', 'head', 'cashier', 'collector']) {
    assert.equal((await api('GET', '/users', { token: tokens[r] })).status, 403, r + ' must not list users');
  }
});

test('revoking sessions invalidates existing tokens', async () => {
  const { tokens } = await setupWorld();
  const id = await insertUser('t_revokee', 'cashier');
  const tok = await tokenFor('t_revokee');
  assert.equal((await api('GET', '/auth/my-permissions', { token: tok })).status, 200);
  assert.equal((await api('PUT', `/users/${id}/revoke`, { token: tokens.admin, body: {} })).status, 200);
  assert.equal((await api('GET', '/auth/my-permissions', { token: tok })).status, 401);
});

test('disabled users cannot log in', async () => {
  const { tokens } = await setupWorld();
  const id = await insertUser('t_disabled', 'cashier');
  assert.equal((await api('PUT', `/users/${id}/disable`, { token: tokens.admin, body: {} })).status, 200);
  assert.notEqual((await login('t_disabled')).status, 200);
});

test('admin password reset: validation, authorization, session revoke, lockout cleared, audited', async () => {
  const { tokens } = await setupWorld();
  const id = await insertUser('t_resetme', 'cashier');
  const oldTok = await tokenFor('t_resetme');
  const adminId = (await db.query("SELECT id FROM v2_users WHERE username='t_admin'")).rows[0].id;

  assert.equal((await api('PUT', `/users/${id}/password`, { token: oldTok, body: { password: 'BrandNew1234' } })).status, 403, 'non-admin');
  assert.equal((await api('PUT', `/users/${id}/password`, { token: tokens.admin, body: { password: 'short' } })).status, 400, 'too short');
  assert.equal((await api('PUT', `/users/${adminId}/password`, { token: tokens.admin, body: { password: 'BrandNew1234' } })).status, 400, 'admin cannot reset self');
  assert.equal((await api('PUT', `/users/999999/password`, { token: tokens.admin, body: { password: 'BrandNew1234' } })).status, 404);

  await db.query("UPDATE v2_users SET failed_login_count = 5, locked_until = NOW() + interval '15 minutes' WHERE id = $1", [id]);
  assert.equal((await api('PUT', `/users/${id}/password`, { token: tokens.admin, body: { password: 'BrandNew1234' } })).status, 200);

  assert.equal((await api('GET', '/auth/my-permissions', { token: oldTok })).status, 401, 'old session revoked');
  assert.notEqual((await login('t_resetme', PASSWORD)).status, 200, 'old password rejected');
  assert.equal((await login('t_resetme', 'BrandNew1234')).status, 200, 'new password works and lockout was cleared');
  const audit = await db.query("SELECT 1 FROM v2_audit_log WHERE action = 'password_reset_by_admin' AND entity_id::text = $1", [String(id)]);
  assert.ok(audit.rows.length >= 1, 'reset is audited');
});
