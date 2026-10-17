const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.TEST_BASE;
if (!BASE) throw new Error('Run the suite with `npm test` (TEST_BASE is set by test/run.js).');
if (process.env.DB_NAME !== 'gurmad_v2_test') throw new Error('Tests must run against gurmad_v2_test only.');

const PASSWORD = 'TestPass123!';
const db = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: 'gurmad_v2_test', user: process.env.DB_USER, password: process.env.DB_PASSWORD });

async function api(method, url, { token, body } = {}) {
  const res = await fetch(BASE + '/api/v2' + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* no body */ }
  return { status: res.status, body: json, data: json && json.data };
}

// Insert a user straight into the DB (the very first admin cannot be created via the API).
async function insertUser(username, role, zoneName = null) {
  const hash = await bcrypt.hash(PASSWORD, 4);
  const roleRow = await db.query('SELECT id FROM roles WHERE key = $1', [role]);
  const r = await db.query(
    `INSERT INTO v2_users (username, password_hash, full_name, role, role_id, zone, is_active, auth_source)
     VALUES ($1,$2,$3,$4,$5,$6,TRUE,'v2') ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`,
    [username, hash, username, role, roleRow.rows[0].id, zoneName]
  );
  return r.rows[0].id;
}

async function login(username, password = PASSWORD) {
  const r = await api('POST', '/auth/login', { body: { username, password } });
  return r;
}
async function tokenFor(username) {
  const r = await login(username);
  if (r.status !== 200 || !r.data || !r.data.token) throw new Error(`login failed for ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.data.token;
}

// One shared world: two zones, one user per role, a few customers. Idempotent per process.
let world;
async function setupWorld() {
  if (world) return world;
  await insertUser('t_admin', 'admin');
  const admin = await tokenFor('t_admin');
  const mkZone = async (name, code) => {
    const ex = await db.query('SELECT id, name FROM zones WHERE zone_code = $1', [code]);
    if (ex.rows[0]) return ex.rows[0];
    return (await api('POST', '/zones', { token: admin, body: { name, zone_code: code } })).data;
  };
  const zoneA = await mkZone('Test Zone A', 'TZA');
  const zoneB = await mkZone('Test Zone B', 'TZB');
  if (!zoneA || !zoneB) throw new Error('zone creation failed');

  await insertUser('t_gudoomiye', 'gudoomiye', zoneA.name);
  await insertUser('t_accountant', 'zone_accountant', zoneA.name);
  await insertUser('t_head', 'head_of_cashiers', zoneA.name);
  await insertUser('t_cashier', 'cashier', zoneA.name);
  await insertUser('t_cashier_b', 'cashier', zoneB.name);
  await insertUser('t_collector', 'collector', zoneA.name);
  const tokens = { admin };
  for (const [k, u] of Object.entries({ gudoomiye: 't_gudoomiye', accountant: 't_accountant', head: 't_head', cashier: 't_cashier', cashierB: 't_cashier_b', collector: 't_collector' })) tokens[k] = await tokenFor(u);

  const mkCustomer = async (name, zone, phone) => {
    const ex = await db.query('SELECT id, zone_id FROM customers WHERE name = $1', [name]);
    if (ex.rows[0]) return ex.rows[0];
    const r = await api('POST', '/customers', { token: admin, body: { customer_type: 'residential', name, phone, zone_id: zone.id, fee: 10 } });
    if (r.status !== 201) throw new Error('customer create failed: ' + JSON.stringify(r.body));
    return r.data;
  };
  const custA = await mkCustomer('Test Customer A', zoneA, '0630000001');
  const custB = await mkCustomer('Test Customer B', zoneB, '0630000002');
  const ids = {};
  for (const u of ['t_cashier', 't_cashier_b', 't_head']) ids[u] = (await db.query('SELECT id FROM v2_users WHERE username=$1', [u])).rows[0].id;
  world = { tokens, zoneA, zoneB, custA, custB, ids };
  return world;
}

async function createInvoice(token, customer, total) {
  const r = await api('POST', '/invoices', { token, body: { customer_id: customer.id, invoice_total: total } });
  if (r.status !== 201) throw new Error('invoice create failed: ' + JSON.stringify(r.body));
  return r.data;
}

module.exports = { api, db, insertUser, login, tokenFor, setupWorld, createInvoice, PASSWORD };
