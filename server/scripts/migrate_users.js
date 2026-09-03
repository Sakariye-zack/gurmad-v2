#!/usr/bin/env node
// User & Access Administration — Preconditions §1/§3, Migration Safety
// requirements (Implementation Authorization message).
//
// Copies legacy `users` rows into V2's `v2_users`, VERBATIM including id
// gaps (Preconditions §3 — legacy ids are NOT contiguous, confirmed:
// local reference data has 8 rows spanning ids 1-14). Never writes to the
// legacy database. Never writes to `employees` (Precondition 1 — id
// preservation alone keeps every existing employees.user_id value
// correct, with zero action needed on the Employees side).
//
// LOCAL/DEV ONLY. This script refuses to run against anything it
// recognizes as a production-shaped target (see the guard below) and is
// never invoked by runMigrations()/app boot — it must be run manually,
// deliberately, once per environment.
//
// Re-runnable: only copies legacy users NOT already present in v2_users
// (by id) — running it twice is a no-op the second time, closing the
// Precondition-3 transition-window edge case (a legacy user created
// after an earlier run of this script gets picked up on the next run).
//
// Usage:
//   node scripts/migrate_users.js
// Env (all required, read from THIS process's own environment — never
// hardcoded, never logged):
//   LEGACY_DB_HOST, LEGACY_DB_PORT, LEGACY_DB_NAME, LEGACY_DB_USER, LEGACY_DB_PASSWORD
//   (V2's own DB_* vars, already required by db.js, are reused for the target)

require('dotenv').config();
const { Pool } = require('pg');
const { pool: v2Pool } = require('../db');

const APPROVED_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier', 'collector'];

function assertNotProduction() {
  const dbName = process.env.DB_NAME || '';
  const legacyDbName = process.env.LEGACY_DB_NAME || '';
  // The one production database name known throughout this entire
  // engagement's history is exactly `gurmad` (see every Hardening/QA/
  // Closure report's own "SELECT datname, numbackends" proof pattern) —
  // refuse outright if either side of the copy is pointed at it.
  if (dbName === 'gurmad' || legacyDbName === 'gurmad') {
    throw new Error('REFUSED: this script will not run against the production database ("gurmad"). Local/dev migration fixtures only.');
  }
}

async function migrateUsers() {
  assertNotProduction();

  const required = ['LEGACY_DB_HOST', 'LEGACY_DB_PORT', 'LEGACY_DB_NAME', 'LEGACY_DB_USER', 'LEGACY_DB_PASSWORD'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required env vars for the legacy source connection: ${missing.join(', ')}`);
  }

  const legacyPool = new Pool({
    host: process.env.LEGACY_DB_HOST,
    port: process.env.LEGACY_DB_PORT,
    database: process.env.LEGACY_DB_NAME,
    user: process.env.LEGACY_DB_USER,
    password: process.env.LEGACY_DB_PASSWORD,
  });

  const client = await v2Pool.connect();
  const report = { migrated: [], skipped_already_present: [], failed: [] };

  try {
    // Read-only against legacy — this script never writes to it.
    const legacyRows = (await legacyPool.query(
      'SELECT id, username, password, full_name, role, zone, is_active FROM users ORDER BY id'
    )).rows;

    await client.query('BEGIN');

    for (const row of legacyRows) {
      const already = await client.query('SELECT id, username FROM v2_users WHERE id = $1', [row.id]);
      if (already.rows.length > 0) {
        // Hardening fix (found live during Hardening, reproduced with a
        // real test row): an id already present in v2_users is NOT
        // automatically "already migrated" — a legacy-side id and a
        // V2-native user id (assigned from v2_users_id_seq, started
        // above the migrated max at the time it was set) can still
        // collide if legacy independently creates a new user during the
        // transition window (Preconditions §3's own named edge case,
        // now proven reproducible, not just theoretical). Comparing
        // usernames distinguishes "this row really was already
        // migrated" (safe, silent skip) from "two unrelated accounts
        // now share an id" (a real conflict — fail loudly, do not
        // silently skip and mask it).
        if (already.rows[0].username !== row.username) {
          throw new Error(
            `ID COLLISION: legacy users.id=${row.id} (username="${row.username}") collides with an existing ` +
            `v2_users.id=${row.id} belonging to a DIFFERENT account (username="${already.rows[0].username}"). ` +
            `This is not a re-migration of the same account — it is two unrelated accounts sharing an id. ` +
            `Aborting — no partial migration. Resolve manually (re-run v2_users_id_seq advancement, or assign ` +
            `the V2-native account a different id) before re-running this script.`
          );
        }
        report.skipped_already_present.push(row.id);
        continue;
      }
      if (!APPROVED_ROLES.includes(row.role)) {
        // Fail loudly, don't silently coerce or skip a row whose role
        // doesn't match one of the 7 approved strings (Preconditions §1:
        // "fail loudly on any row that doesn't fit").
        throw new Error(`Row id=${row.id} (username=${row.username}) has role "${row.role}", which is not one of the approved roles: ${APPROVED_ROLES.join(', ')}. Aborting — no partial migration.`);
      }
      // token_version = 0, matching v2_users' own default and the
      // implicit version every pre-migration legacy token already
      // carries (middleware/auth.js: `decoded.tokenVersion ?? 0`) — this
      // is what keeps an already-issued legacy JWT valid immediately
      // after migration, with zero forced re-login.
      await client.query(
        `INSERT INTO v2_users (id, username, password_hash, full_name, role, zone, is_active, auth_source, token_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'legacy', 0)`,
        [row.id, row.username, row.password, row.full_name, row.role, row.zone, row.is_active]
      );
      report.migrated.push(row.id);
    }

    // Advance the new-user sequence past the migrated range (Preconditions
    // §3) — every subsequently-created V2-native user gets an id strictly
    // above the highest id this or any prior run has ever copied,
    // guaranteeing no collision with a migrated legacy id, ever.
    await client.query(
      `SELECT setval('v2_users_id_seq', GREATEST((SELECT COALESCE(MAX(id), 0) FROM v2_users), (SELECT last_value FROM v2_users_id_seq)))`
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    report.failed.push(err.message);
    throw err;
  } finally {
    client.release();
    await legacyPool.end();
  }

  return report;
}

if (require.main === module) {
  migrateUsers()
    .then((report) => {
      console.log('Migration complete.');
      console.log(`  Migrated: ${report.migrated.length} (ids: ${report.migrated.join(', ') || 'none'})`);
      console.log(`  Already present (skipped): ${report.skipped_already_present.length} (ids: ${report.skipped_already_present.join(', ') || 'none'})`);
      process.exit(0);
    })
    .catch((err) => {
      // Hardening fix: this generic wrapper previously always said "rolled
      // back" even when the failure happened before any transaction was
      // ever opened (the production-name guard, or a missing env var) —
      // technically accurate ("no partial state" is still true either
      // way) but misleading about what actually happened. The specific
      // per-row errors thrown inside the transaction (role/collision)
      // already say "Aborting — no partial migration" themselves.
      console.error('Migration FAILED:', err.message);
      process.exit(1);
    });
}

module.exports = { migrateUsers };
