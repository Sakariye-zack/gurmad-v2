const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Backups: read-side helpers and the single-run executor for the nightly
// pg_dump job (deploy/backup.sh). Only files whose names match the exact
// patterns below are ever listed or served; nothing else in BACKUP_DIR is
// reachable through this module.

const DB_RE = /^gurmad_v2_\d{8}_\d{6}\.dump$/;
const UPLOADS_RE = /^uploads_\d{8}_\d{6}\.tar\.gz$/;
const RETENTION_DAYS = { db: 14, uploads: 28 };
const OVERDUE_MS = 26 * 60 * 60 * 1000;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

function config() {
  const dir = process.env.BACKUP_DIR || '/home/zakariye/backups';
  return {
    dir,
    script: process.env.BACKUP_SCRIPT || path.join(__dirname, '..', '..', 'deploy', 'backup.sh'),
    log: process.env.BACKUP_LOG || path.join(dir, 'backup.log'),
    schedule: process.env.BACKUP_SCHEDULE_UTC || '02:30',
  };
}

// Returns { subdir, type } for a valid backup file name, else null. Basename
// only: any separator, dot-dot or other shape is rejected by the regexes.
function classifyName(name) {
  if (typeof name !== 'string' || name !== path.basename(name)) return null;
  if (DB_RE.test(name)) return { subdir: 'db', type: 'database' };
  if (UPLOADS_RE.test(name)) return { subdir: 'uploads', type: 'uploads' };
  return null;
}

function resolveFile(name) {
  const c = classifyName(name);
  if (!c) return null;
  return { ...c, full: path.join(config().dir, c.subdir, name) };
}

async function listFiles() {
  const { dir } = config();
  const out = [];
  for (const [subdir, re, type] of [['db', DB_RE, 'database'], ['uploads', UPLOADS_RE, 'uploads']]) {
    let names = [];
    try { names = await fs.promises.readdir(path.join(dir, subdir)); } catch (_) { continue; }
    for (const name of names) {
      if (!re.test(name)) continue;
      try {
        const st = await fs.promises.lstat(path.join(dir, subdir, name));
        if (!st.isFile()) continue;
        out.push({ name, type, size: st.size, created_at: st.mtime.toISOString() });
      } catch (_) { /* vanished (retention) */ }
    }
  }
  out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.name < b.name ? 1 : -1));
  return out;
}

// Last non-empty line of the log, and whether it reports success.
async function readLogTail() {
  const { log } = config();
  try {
    const st = await fs.promises.stat(log);
    const fh = await fs.promises.open(log, 'r');
    try {
      const len = Math.min(st.size, 8192);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.size - len);
      const lines = buf.toString('utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const line = lines[lines.length - 1] || null;
      return line ? { line, at: st.mtime.toISOString(), ok: /backup ok /.test(line) } : null;
    } finally { await fh.close(); }
  } catch (_) { return null; }
}

function nextRunAt(now = new Date(), schedule = config().schedule) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(schedule) || ['', '2', '30'];
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(m[1]), Number(m[2]), 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

async function diskInfo() {
  try {
    if (typeof fs.promises.statfs !== 'function') return null;
    const s = await fs.promises.statfs(config().dir);
    return { free_bytes: Number(s.bavail) * Number(s.bsize), total_bytes: Number(s.blocks) * Number(s.bsize) };
  } catch (_) { return null; }
}

async function getStatus() {
  const files = await listFiles();
  const dbFiles = files.filter((f) => f.type === 'database');
  const tail = await readLogTail();
  const newest = dbFiles[0] || null;
  const failed = tail && !tail.ok;
  return {
    last: newest ? { file: newest.name, at: newest.created_at, ok: !(failed && tail.at >= newest.created_at), size: newest.size } : null,
    last_error: failed ? { line: tail.line.slice(0, 200), at: tail.at } : null,
    next_run_at: nextRunAt(),
    count_db: dbFiles.length,
    count_uploads: files.length - dbFiles.length,
    total_bytes: files.reduce((s, f) => s + f.size, 0),
    disk: await diskInfo(),
    schedule_utc: config().schedule,
    retention_days: RETENTION_DAYS,
  };
}

let running = false;
function isRunning() { return running; }

// Runs the backup script once. The lock is taken synchronously, so a
// concurrent call throws BACKUP_RUNNING.
function runBackup() {
  if (running) { const e = new Error('Backup already running'); e.code = 'BACKUP_RUNNING'; throw e; }
  running = true;
  const { script, log, dir } = config();
  const isJs = /\.js$/i.test(script);
  const cmd = isJs ? process.execPath : script;
  const args = isJs ? [script] : [];
  return new Promise((resolve, reject) => {
    const finish = async (err, stdout, stderr) => {
      try {
        let text = `${stdout || ''}${stderr || ''}`.trim();
        if (err && !text) text = `${new Date().toISOString()} backup FAILED ${err.message}`;
        else if (err) text += `
${new Date().toISOString()} backup FAILED exit ${err.code}`;
        if (text) {
          await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
          await fs.promises.appendFile(log, `${text}
`).catch(() => {});
        }
      } finally { running = false; }
      if (err) return reject(err);
      const m = /backup ok (\S+)/.exec(stdout || '');
      resolve({ file: m ? m[1] : null });
    };
    let child;
    try {
      // detached (POSIX) puts the script in its own process group so a timeout
      // can kill pg_dump/tar too. On Windows only the direct child is killed.
      child = execFile(cmd, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: process.env, detached: process.platform !== 'win32' }, finish);
    } catch (e) { running = false; return reject(e); }
    if (process.platform !== 'win32' && child && child.pid) {
      const killer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* gone */ } }, RUN_TIMEOUT_MS + 2000);
      if (killer.unref) killer.unref();
      child.on('exit', () => clearTimeout(killer));
    }
  });
}

module.exports = { DB_RE, UPLOADS_RE, RETENTION_DAYS, OVERDUE_MS, config, classifyName, resolveFile, listFiles, readLogTail, nextRunAt, getStatus, isRunning, runBackup };
