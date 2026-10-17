const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, setupWorld } = require('./helpers');

// path -> role -> expected HTTP status for a plain GET (200 allowed, 403 forbidden)
const MATRIX = {
  '/cashouts': { admin: 200, gudoomiye: 200, accountant: 200, head: 200, cashier: 403, collector: 403 },
  '/exchange-rates': { admin: 200, cashier: 200, collector: 403, gudoomiye: 403 },
  '/employees': { admin: 200, gudoomiye: 200, accountant: 200, head: 403, cashier: 403, collector: 403 },
  '/payroll-periods': { admin: 200, gudoomiye: 200, accountant: 200, head: 200, cashier: 403, collector: 403 },
  '/inventory/adjustments': { admin: 200, gudoomiye: 403, cashier: 403, collector: 403 },
  '/users': { admin: 200, gudoomiye: 403, accountant: 403, head: 403, cashier: 403, collector: 403 },
  '/roles': { admin: 200, gudoomiye: 403, accountant: 403, head: 403, cashier: 403, collector: 403 },
  '/audit': { admin: 200, gudoomiye: 403, cashier: 403, collector: 403 },
};

test('role matrix: each role gets exactly the allowed/forbidden answer on key endpoints', async () => {
  const w = await setupWorld();
  const failures = [];
  for (const [path, perRole] of Object.entries(MATRIX)) {
    for (const [role, want] of Object.entries(perRole)) {
      const r = await api('GET', path, { token: w.tokens[role] });
      if (r.status !== want) failures.push(`${role} GET ${path}: expected ${want}, got ${r.status}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('unauthenticated access is rejected everywhere on the matrix', async () => {
  for (const path of Object.keys(MATRIX)) assert.equal((await api('GET', path)).status, 401, path);
});

test('my-permissions returns a bare array of permission keys and admin sees the most', async () => {
  const w = await setupWorld();
  const admin = await api('GET', '/auth/my-permissions', { token: w.tokens.admin });
  const cashier = await api('GET', '/auth/my-permissions', { token: w.tokens.cashier });
  assert.equal(admin.status, 200);
  assert.ok(Array.isArray(admin.body) && Array.isArray(cashier.body), 'bare arrays');
  assert.ok(admin.body.length > cashier.body.length);
});
