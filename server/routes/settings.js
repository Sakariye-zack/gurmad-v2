const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const { pool, logAudit } = require('../db');
const { sniffFileType } = require('../lib/fileSniff');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// System Settings — Phase 1 (Company Settings). Admin-only, company-wide,
// typed single-row table — NOT a generic key/value store. Reuses the
// existing logAudit() writer (no second audit table/writer) and the
// existing multer disk-storage pattern already proven in cashouts.js/
// complaints.js (no second generic file-management system). No file in
// this router touches auth.js, middleware/auth.js, or any Audit &
// Security Center file — all CLOSED and untouched.
//
// Phase 10 Gap Audit, explicitly user-confirmed exception (not a
// unilateral decision): GET /company/logo below is registered BEFORE
// this admin gate, so it alone is reachable without authentication —
// every other route in this router (including GET /company itself)
// still requires authenticateToken + requireRole('admin'), unchanged.
// Rationale: a company logo is branding, not sensitive data, and needs
// to render on surfaces where no session exists yet — the staff/
// Customer Portal/Collector login screens, and the Sidebar header for
// every authenticated role, not just admin (the logo upload/replace
// action itself remains admin-only, untouched, below).
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

// GET /company/name — Phase 10, user-requested ('systemka magaciisa waan
// badalay... meel kasta oo magaca system ku ka soo muuqanayo waa in aan
// markan update gareeyo uu is badalaaa' — every place the system's name
// appears must reflect a Settings change immediately). Same public
// exception and rationale as GET /company/logo just above (no auth at
// all, not just "any authenticated role") — a company name is branding,
// not sensitive data, and needs to render on surfaces where no staff
// session exists: the staff/Customer Portal/Collector Mobile login
// screens themselves, and the Customer Portal's own header (its
// customer_portal_accounts session is a completely separate JWT this
// staff-only authenticateToken can't verify anyway). Deliberately a
// separate, minimal endpoint rather than widening GET /company itself,
// which also returns address/phone/email — fields with no such
// "every surface" justification.
router.get('/company/name', async (req, res) => {
  try {
    const result = await pool.query('SELECT company_name FROM company_settings WHERE id = $1', [SETTINGS_ROW_ID]);
    res.json({ data: { company_name: result.rows[0]?.company_name || null } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load company name.', code: 'INTERNAL' } });
  }
});

// PWA / browser-tab icon — user-requested ('loagada systemka ku haka
// soo muuqato mobile appska iyo xaga browserkaba'): the installed
// Customer Portal / Collector apps and the browser tab were showing the
// generic static trash-can icon (public/icon-*.png) even after a real
// company logo was uploaded. The logo itself is usually a wide wordmark,
// unusable as a square home-screen icon, so this serves a square PNG
// (logo centered on white with a maskable-safe margin) resized from the
// uploaded file. Public for the same reason as /company/logo above — the
// install prompt / manifest fetch carries no session. 404 when no logo is
// set; callers (the manifest below, useDynamicBranding.js) fall back to
// the static icons in that case, never a broken icon.
const ICON_SIZES = [64, 180, 192, 512];
const iconCache = new Map();
router.get('/company/icon/:size.png', async (req, res) => {
  const size = parseInt(req.params.size, 10);
  if (!ICON_SIZES.includes(size)) return res.status(404).json({ error: { message: 'Unsupported icon size.', code: 'NOT_FOUND' } });
  try {
    const result = await pool.query('SELECT logo_storage_path FROM company_settings WHERE id = $1', [SETTINGS_ROW_ID]);
    const stored = result.rows[0]?.logo_storage_path;
    if (!stored) return res.status(404).json({ error: { message: 'No company logo is set.', code: 'NOT_FOUND' } });
    const filePath = path.join(UPLOAD_DIR, stored);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: { message: 'Logo file not found.', code: 'NOT_FOUND' } });

    // Keyed on the stored filename (a new upload always gets a new
    // filename), so a replaced logo is never served from a stale cache.
    const cacheKey = `${stored}:${size}`;
    let png = iconCache.get(cacheKey);
    if (!png) {
      const margin = Math.round(size * 0.14);
      const inner = size - margin * 2;
      const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
      // A JPEG logo's "white" is rarely pure #fff (compression + a slightly
      // tinted background) — padding with literal white leaves a faintly
      // visible box around the logo. Sampling the logo's own top-left
      // pixel as the fill color makes the margin blend in seamlessly.
      const flat = await sharp(filePath).flatten({ background: WHITE }).toBuffer();
      const corner = await sharp(flat).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
      const bg = { r: corner[0], g: corner[1], b: corner[2], alpha: 1 };
      png = await sharp(flat)
        .resize(inner, inner, { fit: 'contain', background: bg })
        .extend({ top: margin, bottom: margin, left: margin, right: margin, background: bg })
        .png()
        .toBuffer();
      if (iconCache.size > 20) iconCache.clear();
      iconCache.set(cacheKey, png);
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to build company icon.', code: 'INTERNAL' } });
  }
});

// Dynamic web-app manifest for the two installable apps (Customer Portal,
// Collector) — replaces the static public/manifest.webmanifest /
// collector-manifest.webmanifest as what index.html links to, so the
// installed app's home-screen icon + name come from Settings > Company
// Information (logo, company name) instead of being baked into the
// build. Falls back to the static icons/GURMAD name when nothing is
// configured yet. Same public exception as the logo/name routes.
const STATIC_MANIFEST_ICONS = [
  { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
  { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
];
router.get('/company/manifest.webmanifest', async (req, res) => {
  const app = req.query.app === 'collector' ? 'collector' : 'portal';
  try {
    const result = await pool.query('SELECT company_name, logo_storage_path FROM company_settings WHERE id = $1', [SETTINGS_ROW_ID]);
    const row = result.rows[0] || {};
    const companyName = row.company_name || 'GURMAD';
    const icons = row.logo_storage_path
      ? [192, 512].map((s) => ({
          src: `/api/v2/settings/company/icon/${s}.png?v=${encodeURIComponent(row.logo_storage_path)}`,
          sizes: `${s}x${s}`, type: 'image/png', purpose: 'any maskable',
        }))
      : STATIC_MANIFEST_ICONS;
    const manifest = {
      name: app === 'collector' ? `${companyName} Collector` : `${companyName} Customer Portal`,
      short_name: app === 'collector' ? 'Collector' : companyName,
      start_url: app === 'collector' ? '/collector' : '/portal',
      scope: app === 'collector' ? '/collector' : '/portal',
      display: 'standalone',
      background_color: '#F7F8F6',
      theme_color: '#2F7D3E',
      icons,
    };
    res.setHeader('Content-Type', 'application/manifest+json');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(JSON.stringify(manifest));
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to build manifest.', code: 'INTERNAL' } });
  }
});

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

    // Hardening H-S1: the original SELECT-then-branch-to-INSERT-or-UPDATE
    // had a real race window on first-ever save — two truly concurrent
    // PUT requests could both see "no row exists" and both attempt
    // INSERT id=1, the second throwing an unhandled 23505 (duplicate key)
    // -> a bare 500. Fixed with a single atomic INSERT ... ON CONFLICT
    // (id) DO UPDATE — Postgres itself resolves the race, so no
    // application-level lock/transaction is needed and no duplicate row
    // can ever be created (re-confirmed live under an 8-way concurrent
    // first-save race, see Hardening Report).
    const fields = Object.keys(data);
    const insertCols = ['id', ...fields, 'updated_by'];
    const insertPlaceholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
    const insertValues = [SETTINGS_ROW_ID, ...fields.map((f) => data[f]), req.user.id];
    const updateSql = [...fields.map((f) => `${f} = EXCLUDED.${f}`), 'updated_by = EXCLUDED.updated_by', 'updated_at = CURRENT_TIMESTAMP'].join(', ');
    const result = await pool.query(
      `INSERT INTO company_settings (${insertCols.join(', ')}) VALUES (${insertPlaceholders})
       ON CONFLICT (id) DO UPDATE SET ${updateSql} RETURNING *`,
      insertValues
    );

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
  // Content-sniffing validation (Future CR promoted to in-scope, Phase 10
  // Gap Audit) — see lib/fileSniff.js. diskStorage means the file is
  // already written by the time this handler runs; read it back to sniff.
  if (!sniffFileType(fs.readFileSync(req.file.path), req.file.mimetype)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: { message: 'File content does not match its claimed type.', code: 'VALIDATION' } });
  }
  try {
    const existing = await pool.query('SELECT * FROM company_settings WHERE id = $1', [SETTINGS_ROW_ID]);
    const before = existing.rows[0] || null;
    const oldPath = before?.logo_storage_path ? path.join(UPLOAD_DIR, before.logo_storage_path) : null;

    // Hardening H-S1 (same fix as PUT /company): atomic upsert, no
    // SELECT-then-branch race window on first-ever logo upload.
    const result = await pool.query(
      `INSERT INTO company_settings (id, logo_storage_path, logo_original_filename, logo_mime_type, updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET
         logo_storage_path = EXCLUDED.logo_storage_path, logo_original_filename = EXCLUDED.logo_original_filename,
         logo_mime_type = EXCLUDED.logo_mime_type, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [SETTINGS_ROW_ID, req.file.filename, req.file.originalname, req.file.mimetype, req.user.id]
    );

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

// GET /company/logo itself now lives at the TOP of this file (public,
// registered before the admin gate) — not duplicated here.

module.exports = router;
