const { pool } = require('../db');
const logger = require('./logger');
const backups = require('./backups');
const { createStaffNotification } = require('./staffNotifications');

// Hourly check: alert every active admin (at most once per 24 h) when the
// newest database backup is older than 26 h or the backup log ends in an error.
const EVENT = 'backup.alert';

async function checkOnce(now = Date.now()) {
  const status = await backups.getStatus();
  const lastAt = status.last ? Date.parse(status.last.at) : 0;
  const overdue = !status.last || now - lastAt > backups.OVERDUE_MS;
  const bad = overdue || !!status.last_error;
  if (!bad) return false;
  const recent = await pool.query(
    `SELECT 1 FROM v2_staff_notifications WHERE event_type = $1 AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`, [EVENT]);
  if (recent.rows.length) return false;
  const admins = await pool.query(`SELECT id FROM v2_users WHERE role = 'admin' AND is_active = TRUE`);
  for (const a of admins.rows) {
    await createStaffNotification({
      recipientId: a.id,
      eventType: EVENT,
      title: 'Backup-ka habeenkii wuu fashilmay / Nightly backup failed or is overdue',
      body: status.last_error ? status.last_error.line : 'No successful database backup in the last 26 hours.',
    });
  }
  return admins.rows.length > 0;
}

function startMonitor() {
  if (process.env.BACKUP_MONITOR === 'off') return null;
  const safe = () => checkOnce().catch((e) => logger.error('backup_monitor_failed', { message: e && e.message }));
  const first = setTimeout(safe, 60 * 1000);
  const timer = setInterval(safe, 60 * 60 * 1000);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return { first, timer };
}

module.exports = { checkOnce, startMonitor, EVENT };
