const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const backups = require('../lib/backups');
const logger = require('../lib/logger');

const router = express.Router();

const TOKEN_TTL_MS = 60 * 1000;
const downloadTokens = new Map(); // token -> { name, exp, userId }
const failedAttempts = new Map(); // userId -> { count, resetAt }
const MAX_FAILS = 5;
const FAIL_WINDOW_MS = 5 * 60 * 1000;

function sweepTokens() {
  const now = Date.now();
  for (const [t, v] of downloadTokens) if (v.exp <= now) downloadTokens.delete(t);
}

const gone = (res) => res.status(410).json({ error: { message: 'Download link is invalid, expired or already used.', code: 'TOKEN_INVALID' } });

// GET /download/:token — NO authenticateToken (browsers navigate here). The
// credential is a 256-bit random single-use token minted only after an admin
// re-entered their password, valid 60 s, bound to one validated file name.
// It is consumed (deleted) before the file is touched, so it cannot be replayed.
router.get('/download/:token', async (req, res) => {
  sweepTokens();
  const token = String(req.params.token || '');
  const entry = /^[a-f0-9]{64}$/.test(token) ? downloadTokens.get(token) : null;
  if (!entry) return gone(res);
  downloadTokens.delete(token);
  if (entry.exp <= Date.now()) return gone(res);
  const f = backups.resolveFile(entry.name);
  if (!f) return gone(res);
  try {
    const st = await fs.promises.stat(f.full);
    if (!st.isFile()) return res.status(404).json({ error: { message: 'Backup file not found.', code: 'NOT_FOUND' } });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', st.size);
    res.setHeader('Content-Disposition', `attachment; filename="${entry.name}"`);
    res.setHeader('Cache-Control', 'no-store');
    const stream = fs.createReadStream(f.full);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (_) {
    res.status(404).json({ error: { message: 'Backup file not found.', code: 'NOT_FOUND' } });
  }
});

router.use(authenticateToken, requireRole('admin'));

router.get('/status', async (req, res) => {
  try {
    res.json({ data: await backups.getStatus() });
  } catch (err) {
    logger.error('backups_status_failed', { message: err.message });
    res.status(500).json({ error: { message: 'Failed to load backup status.', code: 'INTERNAL' } });
  }
});

router.get('/', async (req, res) => {
  try {
    res.json({ data: await backups.listFiles() });
  } catch (err) {
    logger.error('backups_list_failed', { message: err.message });
    res.status(500).json({ error: { message: 'Failed to list backups.', code: 'INTERNAL' } });
  }
});

router.post('/run', async (req, res) => {
  if (backups.isRunning()) return res.status(409).json({ error: { message: 'A backup is already running.', code: 'BACKUP_RUNNING' } });
  try {
    const result = await backups.runBackup();
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'backup.run', entityType: 'backup', entityId: null, after: { file: result.file } });
    res.json({ data: { file: result.file } });
  } catch (err) {
    if (err.code === 'BACKUP_RUNNING') return res.status(409).json({ error: { message: 'A backup is already running.', code: 'BACKUP_RUNNING' } });
    logger.error('backup_run_failed', { message: err.message });
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'backup.run', entityType: 'backup', entityId: null, after: { failed: true } }).catch(() => {});
    res.status(500).json({ error: { message: 'Backup failed. Check the backup log on the server.', code: 'BACKUP_FAILED' } });
  }
});

router.post('/:name/download-token', async (req, res) => {
  const name = req.params.name;
  const f = backups.resolveFile(name);
  if (!f) return res.status(400).json({ error: { message: 'Invalid backup file name.', code: 'VALIDATION' } });
  const password = req.body && req.body.password;
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: { message: 'Password is required.', code: 'VALIDATION' } });

  const now = Date.now();
  const fails = failedAttempts.get(req.user.id);
  if (fails && fails.resetAt > now && fails.count >= MAX_FAILS) {
    return res.status(429).json({ error: { message: 'Too many wrong passwords. Try again in a few minutes.', code: 'RATE_LIMITED' } });
  }
  try {
    const u = await pool.query('SELECT password_hash FROM v2_users WHERE id = $1 AND is_active = TRUE', [req.user.id]);
    const ok = u.rows[0] && u.rows[0].password_hash && (await bcrypt.compare(password, u.rows[0].password_hash));
    if (!ok) {
      const cur = fails && fails.resetAt > now ? fails : { count: 0, resetAt: now + FAIL_WINDOW_MS };
      cur.count += 1;
      failedAttempts.set(req.user.id, cur);
      return res.status(401).json({ error: { message: 'Incorrect password.', code: 'BAD_PASSWORD' } });
    }
    failedAttempts.delete(req.user.id);
    try { await fs.promises.access(f.full); } catch (_) {
      return res.status(404).json({ error: { message: 'Backup file not found.', code: 'NOT_FOUND' } });
    }
    sweepTokens();
    const token = crypto.randomBytes(32).toString('hex');
    downloadTokens.set(token, { name, exp: now + TOKEN_TTL_MS, userId: req.user.id });
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'backup.download', entityType: 'backup', entityId: null, after: { file: name } });
    res.json({ data: { token, expires_in: TOKEN_TTL_MS / 1000, url: `/api/v2/backups/download/${token}` } });
  } catch (err) {
    logger.error('backup_download_token_failed', { message: err.message });
    res.status(500).json({ error: { message: 'Failed to prepare download.', code: 'INTERNAL' } });
  }
});

module.exports = router;
