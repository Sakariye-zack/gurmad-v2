// Integration test runner. Safety first: this ONLY ever talks to a LOCAL throwaway
// database named gurmad_v2_test, which it drops and recreates on every run.
// It refuses to run if DB_HOST is not localhost.
//
//   npm test
const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

const TEST_DB = 'gurmad_v2_test';
const PORT = process.env.TEST_PORT || '5199';
const HOST = process.env.DB_HOST;

if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) {
  console.error(`Refusing to run: DB_HOST is "${HOST}", tests only run against a local database.`);
  process.exit(1);
}

const stubclamd = require('./stubclamd');
const CLAM_PORT = process.env.TEST_CLAM_PORT || '5198';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function recreateDb() {
  const c = new Client({ host: HOST, port: process.env.DB_PORT, database: 'postgres', user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await c.query(`CREATE DATABASE ${TEST_DB}`);
  await c.end();
}

async function waitHealthy(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(base + '/api/v2/health'); if (r.ok) return; } catch (_) { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('test server did not become healthy');
}

(async () => {
  await recreateDb();
  const clam = await stubclamd.start(Number(CLAM_PORT));
  const env = { ...process.env, DB_NAME: TEST_DB, PORT, CLAMAV_ENABLED: 'true', CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: CLAM_PORT, CLAMAV_FAIL_MODE: 'closed', NODE_OPTIONS: `--require ${path.join(__dirname, 'nolimit.js')}` };
  const server = spawn(process.execPath, ['index.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  const base = `http://localhost:${PORT}`;
  let code = 1;
  try {
    await waitHealthy(base);
    const files = require('fs').readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(__dirname, f));
    code = await new Promise((resolve) => {
      const t = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { env: { ...env, TEST_BASE: base }, stdio: 'inherit' });
      t.on('exit', (c) => resolve(c ?? 1));
    });
  } catch (e) {
    console.error(e.message); console.error(log.slice(-2000));
  } finally {
    server.kill();
    clam.close();
  }
  process.exit(code);
})();
