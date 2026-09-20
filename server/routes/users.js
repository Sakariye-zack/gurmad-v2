const express = require('express');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { sniffFileType } = require('../lib/fileSniff');

// User & Access Administration — Implementation Spec §16/§17. Admin-only
// user-management surface (Preconditions §9's default, not separately
// re-litigated here). Role assignment is restricted to the 7 approved
// static roles (OD-2) — no new role can ever be created via this route.

const router = express.Router();
const BCRYPT_ROUNDS = 12;

// The 7 approved roles, restated verbatim from the Decision/Spec — this
// list is the enforcement point preventing "additional roles" (explicit
// instruction) from ever being introduced via this admin surface.
const APPROVED_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier', 'collector'];
// 'customer' is deliberately excluded — that's the Customer Portal's own,
// entirely separate authentication system (customer_portal_accounts),
// never a v2_users row.

function parseStrictId(raw) {
  if (!/^\d+$/.test(String(raw))) return null;
  return parseInt(raw, 10);
}

// ---------- Personal profile photo (Phase 10, user-requested) ----------
// 'sawir soo saaran karo' — every logged-in user (any role), not just
// admin, can view/replace their OWN avatar. Registered before GET /:id
// so 'me' is never parsed as a numeric user id. Mirrors
// routes/settings.js's own company-logo upload pattern exactly (same
// multer disk-storage shape, same fileSniff content check, same
// delete-old-file-after-new-one-is-committed ordering) — a second,
// parallel image-upload concept was deliberately avoided.
const AVATAR_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'avatars');
fs.mkdirSync(AVATAR_UPLOAD_DIR, { recursive: true });
const AVATAR_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/jpg'];
const uploadAvatar = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATAR_UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${req.user.id}-${Date.now()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, AVATAR_ALLOWED_MIME.includes(file.mimetype)),
});

router.get('/me/avatar', authenticateToken, async (req, res) => {
  try {
    const r = await pool.query('SELECT avatar_storage_path, avatar_mime_type FROM v2_users WHERE id = $1', [req.user.id]);
    const row = r.rows[0];
    if (!row || !row.avatar_storage_path) return res.status(404).json({ error: { message: 'No avatar set.', code: 'NOT_FOUND' } });
    const filePath = path.join(AVATAR_UPLOAD_DIR, row.avatar_storage_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: { message: 'Avatar file not found.', code: 'NOT_FOUND' } });
    res.setHeader('Content-Type', row.avatar_mime_type || 'application/octet-stream');
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load avatar.', code: 'INTERNAL' } });
  }
});

router.post('/me/avatar', authenticateToken, (req, res, next) => {
  uploadAvatar.single('avatar')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: { message: 'Photo exceeds the maximum allowed size (2MB).', code: 'VALIDATION' } });
      return res.status(400).json({ error: { message: 'Invalid photo upload.', code: 'VALIDATION' } });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: { message: 'A photo file is required (png or jpeg).', code: 'VALIDATION' } });
  if (!sniffFileType(fs.readFileSync(req.file.path), req.file.mimetype)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: { message: 'File content does not match its claimed type.', code: 'VALIDATION' } });
  }
  try {
    const existing = await pool.query('SELECT avatar_storage_path FROM v2_users WHERE id = $1', [req.user.id]);
    const oldPath = existing.rows[0]?.avatar_storage_path ? path.join(AVATAR_UPLOAD_DIR, existing.rows[0].avatar_storage_path) : null;

    await pool.query(
      `UPDATE v2_users SET avatar_storage_path = $1, avatar_original_filename = $2, avatar_mime_type = $3 WHERE id = $4`,
      [req.file.filename, req.file.originalname, req.file.mimetype, req.user.id]
    );
    if (oldPath && fs.existsSync(oldPath)) fs.unlink(oldPath, () => {}); // best-effort, after the DB row already points at the new file

    await logAudit({
      actorId: req.user.id, actorUsername: req.user.username, action: 'user.avatar_update',
      entityType: 'v2_user', entityId: req.user.id, before: null, after: { avatar_original_filename: req.file.originalname },
    });
    res.json({ data: { avatar_url: '/v2/users/me/avatar?' + Date.now() } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to save avatar.', code: 'INTERNAL' } });
  }
});

router.get('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.zone, u.is_active, u.auth_source,
              u.failed_login_count, u.locked_until, u.last_login_at, u.created_at,
              e.id AS employee_id, e.name AS employee_name, e.status AS employee_status
       FROM v2_users u
       LEFT JOIN employees e ON e.user_id = u.id
       ORDER BY u.username`
    );
    return res.json({ data: r.rows });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load users.', code: 'INTERNAL' } });
  }
});

router.get('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'User not found.', code: 'NOT_FOUND' } });
  try {
    const r = await pool.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.zone, u.is_active, u.auth_source,
              u.failed_login_count, u.locked_until, u.last_login_at, u.created_at,
              e.id AS employee_id, e.name AS employee_name, e.status AS employee_status
       FROM v2_users u
       LEFT JOIN employees e ON e.user_id = u.id
       WHERE u.id = $1`,
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'User not found.', code: 'NOT_FOUND' } });
    return res.json({ data: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load user.', code: 'INTERNAL' } });
  }
});

// Creation assigns a NEW id from v2_users_id_seq (never a migrated legacy
// id — Preconditions §3: the sequence is explicitly advanced past the
// migrated range by scripts/migrate_users.js, so this INSERT can never
// collide with one).
router.post('/', authenticateToken, requireRole('admin'), async (req, res) => {
  const { username, password, full_name, role, zone, employee_id } = req.body || {};
  const errors = [];
  if (typeof username !== 'string' || !username.trim()) errors.push('username is required.');
  if (typeof password !== 'string' || password.length < 8) errors.push('password (min 8 characters) is required.');
  if (!APPROVED_ROLES.includes(role)) errors.push(`role must be one of: ${APPROVED_ROLES.join(', ')}.`);
  let employeeIdNum = null;
  if (employee_id !== undefined && employee_id !== null) {
    employeeIdNum = parseStrictId(employee_id);
    if (employeeIdNum === null) errors.push('employee_id must be a positive integer or null.');
  }
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const ins = await client.query(
      `INSERT INTO v2_users (username, password_hash, full_name, role, zone, is_active, auth_source)
       VALUES ($1, $2, $3, $4, $5, TRUE, 'v2')
       RETURNING id, username, full_name, role, zone, is_active, auth_source, created_at`,
      [username.trim(), passwordHash, full_name || null, role, zone || null]
    );
    const user = ins.rows[0];

    // One employee -> one staff account, deterministic (OD-4). employees
    // itself is Module 3, closed — this is the ONLY write this route ever
    // makes to it, and it is the exact same kind of write
    // routes/employees.js's own existing PUT handler already performs
    // (setting user_id), not a new capability added to that closed module.
    if (employeeIdNum !== null) {
      const empCheck = await client.query('SELECT id, user_id FROM employees WHERE id = $1', [employeeIdNum]);
      if (empCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: { message: 'employee_id does not correspond to a real employee.', code: 'VALIDATION' } });
      }
      if (empCheck.rows[0].user_id !== null) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: { message: 'This employee is already linked to another user account.', code: 'VALIDATION' } });
      }
      await client.query('UPDATE employees SET user_id = $1, updated_at = NOW() WHERE id = $2', [user.id, employeeIdNum]);
    }

    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'create', entityType: 'v2_user', entityId: user.id, after: user });
    return res.status(201).json({ data: user });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(400).json({ error: { message: 'That username is already taken.', code: 'VALIDATION' } });
    }
    return res.status(500).json({ error: { message: 'Failed to create user.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.put('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'User not found.', code: 'NOT_FOUND' } });
  const { full_name, role, zone } = req.body || {};
  try {
    const before = await pool.query('SELECT * FROM v2_users WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'User not found.', code: 'NOT_FOUND' } });
    const prev = before.rows[0];

    if (role !== undefined && !APPROVED_ROLES.includes(role)) {
      return res.status(400).json({ error: { message: `role must be one of: ${APPROVED_ROLES.join(', ')}.`, code: 'VALIDATION' } });
    }
    const nextRole = role !== undefined ? role : prev.role;
    const nextZone = zone !== undefined ? zone : prev.zone;
    const nextFullName = full_name !== undefined ? full_name : prev.full_name;

    const r = await pool.query(
      'UPDATE v2_users SET full_name = $1, role = $2, zone = $3, updated_at = NOW() WHERE id = $4 RETURNING id, username, full_name, role, zone, is_active, auth_source',
      [nextFullName, nextRole, nextZone, id]
    );

    // Role/zone change audited distinctly (Spec §12) — takes effect
    // immediately on the user's very next request via live resolution
    // (lib/accessResolution.js), no token action needed (OD-3's approved
    // event list is intentionally not expanded to include this).
    if (role !== undefined && role !== prev.role) {
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'role_change', entityType: 'v2_user', entityId: id, before: { role: prev.role }, after: { role: nextRole } });
    }
    if (zone !== undefined && zone !== prev.zone) {
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'zone_change', entityType: 'v2_user', entityId: id, before: { zone: prev.zone }, after: { zone: nextZone } });
    }
    return res.json({ data: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to update user.', code: 'INTERNAL' } });
  }
});

router.put('/:id/disable', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'User not found.', code: 'NOT_FOUND' } });
  try {
    // Disable bumps token_version too (OD-3 approved event) — every
    // outstanding token for this account is invalidated immediately, not
    // just future logins blocked.
    const r = await pool.query(
      'UPDATE v2_users SET is_active = FALSE, token_version = token_version + 1, updated_at = NOW() WHERE id = $1 RETURNING id, username, is_active',
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'User not found.', code: 'NOT_FOUND' } });
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'account_disable', entityType: 'v2_user', entityId: id });
    return res.json({ data: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to disable user.', code: 'INTERNAL' } });
  }
});

router.put('/:id/enable', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'User not found.', code: 'NOT_FOUND' } });
  try {
    // Re-enable does NOT bump token_version (matches the Customer
    // Portal's own precedent — re-enabling isn't a compromise event).
    const r = await pool.query(
      'UPDATE v2_users SET is_active = TRUE, failed_login_count = 0, locked_until = NULL, updated_at = NOW() WHERE id = $1 RETURNING id, username, is_active',
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'User not found.', code: 'NOT_FOUND' } });
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'account_enable', entityType: 'v2_user', entityId: id });
    return res.json({ data: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to enable user.', code: 'INTERNAL' } });
  }
});

// Explicit security revocation (OD-3's 5th approved event) — distinct
// from disable: the account stays active/usable, but every currently
// outstanding token is invalidated (e.g. "I think my laptop was stolen
// but I'm not being fired").
router.put('/:id/revoke', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'User not found.', code: 'NOT_FOUND' } });
  try {
    const r = await pool.query(
      'UPDATE v2_users SET token_version = token_version + 1, updated_at = NOW() WHERE id = $1 RETURNING id, username, token_version',
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'User not found.', code: 'NOT_FOUND' } });
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'token_revoke', entityType: 'v2_user', entityId: id });
    return res.json({ data: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to revoke sessions.', code: 'INTERNAL' } });
  }
});

module.exports = router;
