const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// System Settings — Phase 1 (Company Settings). Admin-only, company-wide,
// typed single-row table — NOT a generic key/value store. Reuses the
// existing logAudit() writer (no second audit table/writer) and the
// existing multer disk-storage pattern already proven in cashouts.js/
// complaints.js (no second generic file-management system). No file in
// this router touches auth.js, middleware/auth.js, or any Audit &
// Security Center file — all CLOSED and untouched.
router.use(authenticateToken, requireRole('admin'));

const SETTINGS_ROW_ID = 1; // single-row convention, enforced here only

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'settings');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// SVG deliberately excluded (can embed executable script — a real XSS
// vector); PDF excluded (not a logo format). 2MB, not the unrelated 10MB
// cashout-attachment limit — a logo is a small image, not a document.
const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/jpg'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    // Server-generated filename ONLY — the client-supplied original
    // filename is never used as (or interpolated into) the stored path,
    // which is what actually prevents path traversal/double-extension/
    // malicious-filename attacks, not a filename blocklist.
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.includes(file.mimetype)),
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let VALID_TIMEZONES = null;
function getValidTimezones() {
  if (VALID_TIMEZONES) return VALID_TIMEZONES;
  try {
    VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));
  } catch {
    VALID_TIMEZONES = null; // Node too old for supportedValuesOf — fall back to per-value try/construct below
  }
  return VALID_TIMEZONES;
}
function isValidTimezone(tz) {
  const known = getValidTimezones();
  if (known) return known.has(tz);
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Server-side field whitelist — only these 5 business fields are ever
// read from the PUT body. id/created_by/updated_by/logo_* internals/any
// unexpected field (role, zone_id, secret, password, jwt_secret,
// database_url, ...) are never read from req.body at all, so there is
// nothing to "ignore" — they were never looked at (mass-assignment is
// structurally not possible, not merely filtered).
function validateSettingsInput(body) {
  const errors = [];
  const out = {};
  if (body.company_name !== undefined) {
    if (body.company_name !== null && (typeof body.company_name !== 'string' || body.company_name.trim().length > 150)) {
      errors.push('company_name must be a string up to 150 characters.');
    } else {
      out.company_name = body.company_name === null ? null : body.company_name.trim() || null;
    }
  }
  if (body.address !== undefined) {
    if (body.address !== null && (typeof body.address !== 'string' || body.address.length > 2000)) {
      errors.push('address must be a string up to 2000 characters.');
    } else {
      out.address = body.address === null ? null : String(body.address).trim() || null;
    }
  }
  if (body.phone !== undefined) {
    if (body.phone !== null && (typeof body.phone !== 'string' || body.phone.trim().length > 20)) {
      errors.push('phone must be a string up to 20 characters.');
    } else {
      out.phone = body.phone === null ? null : body.phone.trim() || null;
    }
  }
  if (body.email !== undefined) {
    const email = body.email === null ? '' : String(body.email).trim();
    if (email && !EMAIL_RE.test(email)) {
      errors.push('email must be a valid email address.');
    } else {
      out.email = email || null;
    }
  }
  if (body.timezone !== undefined) {
    if (body.timezone !== null && (typeof body.timezone !== 'string' || !isValidTimezone(body.timezone))) {
      errors.push('timezone must be a valid IANA timezone identifier.');
    } else {
      out.timezone = body.timezone;
    }
  }
  return { errors, data: out };
}

function shapeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    company_name: row.company_name,
    // No leading '/api' — apiClient's own BASE constant already prepends
    // it (matching every other path this client passes to apiClient.*,
    // e.g. '/v2/settings/company' itself). Found live this pass: the
    // original '/api/v2/...' value doubled up with apiClient's own prefix
    // into '/api/api/v2/...', a 404. Fixed here, entirely within this
    // CR's own new file — no shared client file was touched.
    logo_url: row.logo_storage_path ? '/v2/settings/company/logo' : null,
    address: row.address,
    phone: row.phone,
    email: row.email,
    timezone: row.timezone,
    updated_at: row.updated_at,
  };
}

// GET /api/v2/settings/company — no row yet is a valid, expected state
// (200 + data:null), never a 404.
router.get('/company', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM company_settings WHERE id = $1', [SETTINGS_ROW_ID]);
    res.json({ data: shapeRow(result.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load company settings.', code: 'INTERNAL' } });
  }
});

// PUT /api/v2/settings/company — partial update, upsert-shaped (always
// leaves exactly one row present after a successful call).
router.put('/company', async (req, res) => {
  const { errors, data } = validateSettingsInput(req.body || {});
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  if (Object.keys(data).length === 0) return res.status(400).json({ error: { message: 'No valid fields provided to update.', code: 'VALIDATION' } });

  try {
    const existing = await pool.query('SELECT * FROM company_settings WHERE id = $1', [SETTINGS_ROW_ID]);
    const before = existing.rows[0] || null;

    let result;
    if (before) {
      const fields = Object.keys(data);
      const setSql = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
      const values = fields.map((f) => data[f]);
      values.push(SETTINGS_ROW_ID);
      result = await pool.query(
        `UPDATE company_settings SET ${setSql}, updated_by = $${values.length + 1}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`,
        [...values, req.user.id]
      );
    } else {
      const fields = Object.keys(data);
      const cols = ['id', ...fields, 'updated_by'];
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const values = [SETTINGS_ROW_ID, ...fields.map((f) => data[f]), req.user.id];
      result = await pool.query(
        `INSERT INTO company_settings (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        values
      );
    }

    const after = result.rows[0];
    await logAudit({
      actorId: req.user.id, actorUsername: req.user.username, action: 'settings.company_update',
      entityType: 'company_settings', entityId: SETTINGS_ROW_ID,
      before: before ? Object.fromEntries(Object.keys(data).map((f) => [f, before[f]])) : null,
      after: Object.fromEntries(Object.keys(data).map((f) => [f, after[f]])),
    });
    res.json({ data: shapeRow(after) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update company settings.', code: 'INTERNAL' } });
  }
});

// POST /api/v2/settings/company/logo — replaces the single logo reference.
// POST, not PUT, matching the existing file-upload precedent (cashouts.js's
// own POST /:id/attachments — apiClient.uploadFile() is hardcoded to POST,
// and matching it avoids any change to that shared client file). Registered
// with its own multer middleware; a rejected file (bad MIME/oversized)
// never reaches disk (multer's own fileFilter/limits run before the
// handler body).
router.post('/company/logo', (req, res, next) => {
  upload.single('logo')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: { message: 'Logo exceeds the maximum allowed size (2MB).', code: 'VALIDATION' } });
      return res.status(400).json({ error: { message: 'Invalid logo upload.', code: 'VALIDATION' } });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: { message: 'A logo file is required (png or jpeg).', code: 'VALIDATION' } });
  try {
    const existing = await pool.query('SELECT * FROM company_settings WHERE id = $1', [SETTINGS_ROW_ID]);
    const before = existing.rows[0] || null;
    const oldPath = before?.logo_storage_path ? path.join(UPLOAD_DIR, before.logo_storage_path) : null;

    let result;
    if (before) {
      result = await pool.query(
        `UPDATE company_settings SET logo_storage_path = $1, logo_original_filename = $2, logo_mime_type = $3, updated_by = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 RETURNING *`,
        [req.file.filename, req.file.originalname, req.file.mimetype, req.user.id, SETTINGS_ROW_ID]
      );
    } else {
      result = await pool.query(
        `INSERT INTO company_settings (id, logo_storage_path, logo_original_filename, logo_mime_type, updated_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [SETTINGS_ROW_ID, req.file.filename, req.file.originalname, req.file.mimetype, req.user.id]
      );
    }

    // Delete the old file only AFTER the new file is on disk and the DB
    // row is successfully updated — never before, so a failed update
    // never leaves the settings row pointing at a deleted file.
    if (oldPath && fs.existsSync(oldPath)) {
      fs.unlink(oldPath, () => {}); // best-effort; never blocks the response
    }

    const after = result.rows[0];
    // Never the raw storage path — only the original filename/MIME are
    // meaningful audit content (Spec §11: "sensitive file internals must
    // not be dumped into audit metadata").
    await logAudit({
      actorId: req.user.id, actorUsername: req.user.username, action: 'settings.company_logo_update',
      entityType: 'company_settings', entityId: SETTINGS_ROW_ID,
      before: before?.logo_original_filename ? { logo_original_filename: before.logo_original_filename } : null,
      after: { logo_original_filename: after.logo_original_filename, logo_mime_type: after.logo_mime_type },
    });
    res.json({ data: shapeRow(after) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update company logo.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/settings/company/logo — authorized binary fetch, same
// pattern as cashouts.js's own /:id/attachments/:attachmentId/file.
router.get('/company/logo', async (req, res) => {
  try {
    const result = await pool.query('SELECT logo_storage_path, logo_mime_type FROM company_settings WHERE id = $1', [SETTINGS_ROW_ID]);
    const row = result.rows[0];
    if (!row || !row.logo_storage_path) return res.status(404).json({ error: { message: 'No company logo is set.', code: 'NOT_FOUND' } });
    const filePath = path.join(UPLOAD_DIR, row.logo_storage_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: { message: 'Logo file not found.', code: 'NOT_FOUND' } });
    res.setHeader('Content-Type', row.logo_mime_type || 'application/octet-stream');
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load company logo.', code: 'INTERNAL' } });
  }
});

module.exports = router;
