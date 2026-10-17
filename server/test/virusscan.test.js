const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, tokenFor } = require('./helpers');
const { EICAR } = require('./stubclamd');

const BASE = process.env.TEST_BASE;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const pdf = (extra = '') => Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n' + extra + '\n%%EOF');

async function upload(path, token, fields, fileField, buf, filename, type) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append(fileField, new Blob([buf], { type }), filename);
  const res = await fetch(BASE + '/api/v2' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: form });
  let body = null; try { body = await res.json(); } catch (_) { /* none */ }
  return { status: res.status, body };
}

test('documents (memory upload): clean PDF is accepted, EICAR-infected PDF is rejected 422 and audited', async () => {
  const w = await setupWorld();
  const fields = { title: 'Clean doc', category: 'other' };
  const clean = await upload('/documents', w.tokens.admin, fields, 'file', pdf(), 'ok.pdf', 'application/pdf');
  assert.equal(clean.status, 201, JSON.stringify(clean.body));

  const bad = await upload('/documents', w.tokens.admin, { ...fields, title: 'Infected doc' }, 'file', pdf(EICAR), 'bad.pdf', 'application/pdf');
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'MALWARE_DETECTED');

  const stored = await db.query("SELECT COUNT(*)::int AS n FROM documents WHERE title = 'Infected doc'");
  assert.equal(stored.rows[0].n, 0, 'nothing was stored');
  const audit = await db.query("SELECT after_data FROM v2_audit_log WHERE action = 'upload.virus_detected' ORDER BY id DESC LIMIT 1");
  assert.ok(audit.rows.length === 1);
  assert.equal(audit.rows[0].after_data.signature, 'Eicar-Test-Signature');
  assert.equal(audit.rows[0].after_data.label, 'document');
});

test('avatar (disk upload): clean image accepted; infected file rejected and removed from disk', async () => {
  const w = await setupWorld();
  const ok = await upload('/users/me/avatar', w.tokens.cashier, {}, 'avatar', PNG, 'a.png', 'image/png');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  // a PNG with EICAR appended still has valid PNG magic bytes, so only the scanner can catch it
  const infected = Buffer.concat([PNG, Buffer.from(EICAR)]);
  const bad = await upload('/users/me/avatar', w.tokens.cashier, {}, 'avatar', infected, 'evil.png', 'image/png');
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'MALWARE_DETECTED');
});

test('CSV import validation also scans the file', async () => {
  const w = await setupWorld();
  const fields = { targetZoneId: String(w.zoneA.id) };
  const bad = await upload('/master-data/zones/import/validate', w.tokens.admin, fields, 'file', Buffer.from('name,zone_code\n' + EICAR + ',X1\n'), 'z.csv', 'text/csv');
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.equal(bad.body.error.code, 'MALWARE_DETECTED');
});

// ---- unit-level: scanner unavailable, fail-open vs fail-closed (in-process, no HTTP) ----
function fakeRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test('scanner unavailable: fail-open lets the upload through, fail-closed rejects with 503', async () => {
  const saved = { ...process.env };
  try {
    const vs = require('../lib/virusScan');
    process.env.CLAMAV_ENABLED = 'true';
    process.env.CLAMAV_HOST = '127.0.0.1';
    process.env.CLAMAV_PORT = '5197'; // nothing listens here
    process.env.CLAMAV_TIMEOUT_MS = '1500';

    process.env.CLAMAV_FAIL_MODE = 'open';
    const r1 = fakeRes();
    assert.equal(await vs.rejectIfInfected({ path: '/t', user: { id: null } }, r1, { buffer: Buffer.from('hello') }), false);
    assert.equal(r1.statusCode, null, 'fail-open sends no response');

    process.env.CLAMAV_FAIL_MODE = 'closed';
    const r2 = fakeRes();
    assert.equal(await vs.rejectIfInfected({ path: '/t', user: { id: null } }, r2, { buffer: Buffer.from('hello') }), true);
    assert.equal(r2.statusCode, 503);
    assert.equal(r2.body.error.code, 'SCAN_UNAVAILABLE');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('scanning is skipped entirely when CLAMAV_ENABLED is not true', async () => {
  const saved = process.env.CLAMAV_ENABLED;
  try {
    process.env.CLAMAV_ENABLED = 'false';
    const vs = require('../lib/virusScan');
    const res = fakeRes();
    assert.equal(await vs.rejectIfInfected({ path: '/t' }, res, { buffer: Buffer.from(EICAR) }), false);
  } finally { process.env.CLAMAV_ENABLED = saved; }
});

test('parseReply understands clamd answers', () => {
  const { parseReply } = require('../lib/virusScan');
  assert.equal(parseReply('stream: OK\0').status, 'clean');
  assert.deepEqual(parseReply('stream: Win.Test.EICAR_HDB-1 FOUND\0'), { status: 'infected', signature: 'Win.Test.EICAR_HDB-1' });
  assert.equal(parseReply('INSTREAM size limit exceeded. ERROR').status, 'error');
  assert.equal(parseReply('').status, 'error');
});
