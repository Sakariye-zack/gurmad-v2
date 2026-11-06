const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { api, db, setupWorld, PASSWORD } = require('./helpers');

const DIR = process.env.BACKUP_DIR;
const BASE = process.env.TEST_BASE;
if (!DIR) throw new Error('BACKUP_DIR must be set by test/run.js');

function put(sub, name, content = 'x') {
  fs.mkdirSync(path.join(DIR, sub), { recursive: true });
  fs.writeFileSync(path.join(DIR, sub, name), content);
}

test('non-admin roles are forbidden on every backups endpoint', async () => {
  const w = await setupWorld();
  for (const role of ['gudoomiye', 'accountant', 'cashier', 'collector']) {
    assert.equal((await api('GET', '/backups', { token: w.tokens[role] })).status, 403, role);
    assert.equal((await api('GET', '/backups/status', { token: w.tokens[role] })).status, 403, role);
    assert.equal((await api('POST', '/backups/run', { token: w.tokens[role] })).status, 403, role);
    assert.equal((await api('POST', '/backups/gurmad_v2_20260101_020000.dump/download-token', { token: w.tokens[role], body: { password: PASSWORD } })).status, 403, role);
  }
  assert.equal((await api('GET', '/backups')).status, 401);
});

test('list returns only exact-pattern backup files, newest first', async () => {
  const w = await setupWorld();
  put('db', 'gurmad_v2_20260101_020000.dump', 'aaaa');
  put('db', 'gurmad_v2_20260102_020000.dump', 'bbbbbb');
  put('db', 'notes.txt');
  put('db', 'gurmad_v2_20260101_020000.dump.bak');
  put('db', 'evil.dump');
  put('uploads', 'uploads_20260101_020000.tar.gz', 'zz');
  put('uploads', 'uploads_bad.tar.gz');
  fs.writeFileSync(path.join(DIR, 'secret.dump'), 'nope');
  // make "newest" deterministic via mtime
  fs.utimesSync(path.join(DIR, 'db', 'gurmad_v2_20260101_020000.dump'), new Date('2026-01-01T02:00:00Z'), new Date('2026-01-01T02:00:00Z'));
  fs.utimesSync(path.join(DIR, 'db', 'gurmad_v2_20260102_020000.dump'), new Date('2026-01-02T02:00:00Z'), new Date('2026-01-02T02:00:00Z'));
  fs.utimesSync(path.join(DIR, 'uploads', 'uploads_20260101_020000.tar.gz'), new Date('2026-01-01T03:00:00Z'), new Date('2026-01-01T03:00:00Z'));
  const r = await api('GET', '/backups', { token: w.tokens.admin });
  assert.equal(r.status, 200);
  const names = r.data.map((f) => f.name);
  assert.deepEqual(names, ['gurmad_v2_20260102_020000.dump', 'uploads_20260101_020000.tar.gz', 'gurmad_v2_20260101_020000.dump']);
  assert.equal(r.data[0].type, 'database');
  assert.equal(r.data[0].size, 6);
  assert.equal(r.data[1].type, 'uploads');
  assert.ok(!Number.isNaN(Date.parse(r.data[0].created_at)));
});

test('status exposes last, next run, counts, sizes, disk, schedule and retention', async () => {
  const w = await setupWorld();
  const r = await api('GET', '/backups/status', { token: w.tokens.admin });
  assert.equal(r.status, 200);
  const s = r.data;
  assert.equal(s.last.file, 'gurmad_v2_20260102_020000.dump');
  assert.equal(s.last.ok, true);
  assert.equal(s.last.size, 6);
  assert.equal(s.last_error, null);
  assert.equal(s.count_db, 2);
  assert.equal(s.count_uploads, 1);
  assert.equal(s.total_bytes, 4 + 6 + 2);
  assert.equal(s.schedule_utc, '02:30');
  assert.deepEqual(s.retention_days, { db: 14, uploads: 28 });
  const next = new Date(s.next_run_at);
  assert.ok(next > new Date());
  assert.equal(next.getUTCHours(), 2);
  assert.equal(next.getUTCMinutes(), 30);
  assert.ok(next - new Date() <= 24 * 3600 * 1000);
  assert.ok(s.disk === null || (typeof s.disk.free_bytes === 'number' && typeof s.disk.total_bytes === 'number'));
});

test('run creates a file, logs it, audits it; a second concurrent run gets 409', async () => {
  const w = await setupWorld();
  const before = (await api('GET', '/backups', { token: w.tokens.admin })).data.length;
  fs.writeFileSync(path.join(DIR, 'slow.flag'), '1');
  const first = api('POST', '/backups/run', { token: w.tokens.admin });
  await new Promise((r) => setTimeout(r, 400));
  const second = await api('POST', '/backups/run', { token: w.tokens.admin });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'BACKUP_RUNNING');
  const done = await first;
  fs.unlinkSync(path.join(DIR, 'slow.flag'));
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.match(done.data.file, /^gurmad_v2_\d{8}_\d{6}\.dump$/);
  assert.ok(fs.existsSync(path.join(DIR, 'db', done.data.file)));
  assert.equal((await api('GET', '/backups', { token: w.tokens.admin })).data.length, before + 1);
  assert.match(fs.readFileSync(process.env.BACKUP_LOG, 'utf8'), /backup ok gurmad_v2_/);
  const a = await db.query(`SELECT 1 FROM v2_audit_log WHERE action = 'backup.run'`);
  assert.ok(a.rows.length >= 1);
  // lock released: another run works
  assert.equal((await api('POST', '/backups/run', { token: w.tokens.admin })).status, 200);
});

test('download-token: bad names rejected, wrong password 401, right password gives a single-use token', async () => {
  const w = await setupWorld();
  const name = 'gurmad_v2_20260102_020000.dump';
  for (const bad of ['..%2F..%2Fetc%2Fpasswd', '..%5Csecret.dump', 'secret.dump', 'notes.txt', 'gurmad_v2_20260101_020000.dump.bak']) {
    const r = await api('POST', `/backups/${bad}/download-token`, { token: w.tokens.admin, body: { password: PASSWORD } });
    assert.ok([400, 404].includes(r.status), `${bad} -> ${r.status}`);
  }
  assert.equal((await api('POST', '/backups/gurmad_v2_20300101_000000.dump/download-token', { token: w.tokens.admin, body: { password: PASSWORD } })).status, 404);
  assert.equal((await api('POST', `/backups/${name}/download-token`, { token: w.tokens.admin, body: { password: 'wrong-pass' } })).status, 401);
  assert.equal((await api('POST', `/backups/${name}/download-token`, { token: w.tokens.admin, body: {} })).status, 400);

  const t = await api('POST', `/backups/${name}/download-token`, { token: w.tokens.admin, body: { password: PASSWORD } });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.ok(t.data.token && t.data.expires_in <= 60);
  // no auth header: token is the credential
  const res = await fetch(`${BASE}/api/v2/backups/download/${t.data.token}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="gurmad_v2_20260102_020000\.dump"/);
  assert.equal(await res.text(), 'bbbbbb');
  const again = await fetch(`${BASE}/api/v2/backups/download/${t.data.token}`);
  assert.ok([404, 410].includes(again.status));
  const junk = await fetch(`${BASE}/api/v2/backups/download/not-a-token`);
  assert.ok([404, 410].includes(junk.status));
  const aud = await db.query(`SELECT 1 FROM v2_audit_log WHERE action = 'backup.download'`);
  assert.ok(aud.rows.length >= 1);
});

test('monitor alerts active admins once per 24h when the newest backup is overdue', async () => {
  const w = await setupWorld();
  const old = new Date(Date.now() - 30 * 3600 * 1000);
  for (const sub of ['db', 'uploads']) {
    for (const f of fs.readdirSync(path.join(DIR, sub))) fs.utimesSync(path.join(DIR, sub, f), old, old);
  }
  const { checkOnce } = require('../lib/backupMonitor');
  await checkOnce();
  await checkOnce();
  const adminId = (await db.query(`SELECT id FROM v2_users WHERE username = 't_admin'`)).rows[0].id;
  const n = await db.query(`SELECT * FROM v2_staff_notifications WHERE event_type = 'backup.alert' AND recipient_id = $1`, [adminId]);
  assert.equal(n.rows.length, 1);
  assert.match(n.rows[0].title, /Nightly backup failed or is overdue/);
});
