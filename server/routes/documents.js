const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { putFile, getFileStream, fileExists, UPLOAD_DIR } = require('../lib/documentStorage');

const router = express.Router();

// Master Functional Completion Program — Phase 5: Document & File
// Management. Built strictly to GURMAD_V2_Phase5_Document_File_
// Implementation_Specification.md. Option B (file_objects/documents/
// document_attachments), ZERO module integration in MVP — no row is
// ever inserted into document_attachments by any route below.

const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier'];
const UPLOAD_ROLES = ['admin', 'gudoomiye'];
const ADMIN_ONLY = ['admin'];

// documents.category — LOCKED by explicit Business-Owner decision
// (Phase 5 Decisions Amendment). Exactly these 9 values. Never extend,
// rename, or accept free text.
const CATEGORY_VALUES = ['official', 'contract', 'certificate', 'report', 'financial', 'hr', 'procurement', 'operational', 'other'];

// MIME allowlist + the extension family each one is expected to carry —
// used for the extension/MIME cross-check (Implementation Spec §11).
const MIME_TO_EXTENSIONS = {
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.ms-excel': ['.xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'text/csv': ['.csv'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/jpg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
};
const ALLOWED_MIME = Object.keys(MIME_TO_EXTENSIONS);
const PREVIEWABLE_MIME = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.includes(file.mimetype)),
});

function parseStrictId(raw) {
  if (!/^\d+$/.test(String(raw ?? ''))) return null;
  return parseInt(raw, 10);
}

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

function generateStorageKey(extension) {
  return `${Date.now()}-${crypto.randomInt(1e9)}${extension}`;
}

function sanitizeDisplayFilename(originalname) {
  const stripped = String(originalname || 'file').replace(/[/\\]/g, '_').replace(/[\x00-\x1f]/g, '').trim();
  return (stripped || 'file').slice(0, 255);
}

function pickPublicFields(doc) {
  // Never expose storage_key. file_objects-derived display fields are
  // joined in by the caller before this is used.
  const { current_file_object_id, ...rest } = doc;
  return rest;
}

async function loadDocumentWithAccessCheck(user, docId, client = pool) {
  const r = await client.query(
    `SELECT d.*, f.original_filename, f.display_filename, f.mime_type, f.extension, f.file_size, f.checksum_sha256, f.storage_key
     FROM documents d JOIN file_objects f ON d.current_file_object_id = f.id
     WHERE d.id = $1`,
    [docId]
  );
  if (r.rows.length === 0) return { error: { status: 404, message: 'Document not found.', code: 'NOT_FOUND' } };
  const doc = r.rows[0];
  const myZoneId = await resolveUserZoneId(user);
  if (myZoneId !== null && doc.zone_id !== null && doc.zone_id !== myZoneId) {
    return { error: { status: 403, message: 'You do not have access to this document.', code: 'FORBIDDEN' } };
  }
  return { doc };
}

// ============================================================
// Upload
// ============================================================

router.post('/', authenticateToken, requireRole(...UPLOAD_ROLES), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: { message: 'A file is required, or its type is not allowed. Supported: PDF, DOC, DOCX, XLS, XLSX, CSV, JPG, PNG, WEBP.', code: 'VALIDATION' } });
  }
  const { title, category, description, zone_id } = req.body;
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: { message: 'title is required.', code: 'VALIDATION' } });
  }
  if (!CATEGORY_VALUES.includes(category)) {
    return res.status(400).json({ error: { message: `category must be one of: ${CATEGORY_VALUES.join(', ')}.`, code: 'VALIDATION' } });
  }

  // Extension/MIME cross-check — a file claiming an extension outside
  // its own validated MIME's expected family is rejected.
  const originalExt = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || [''])[0].toLowerCase();
  const expectedExts = MIME_TO_EXTENSIONS[req.file.mimetype] || [];
  if (!expectedExts.includes(originalExt)) {
    return res.status(400).json({ error: { message: 'File extension does not match its detected type.', code: 'VALIDATION' } });
  }

  const role = (req.user.role || '').toLowerCase();
  let targetZoneId = null;
  if (role === 'gudoomiye') {
    targetZoneId = await resolveUserZoneId(req.user);
    if (targetZoneId === null) return res.status(403).json({ error: { message: 'Your account has no resolvable zone.', code: 'FORBIDDEN' } });
  } else if (zone_id !== undefined && zone_id !== null && zone_id !== '') {
    const zid = parseStrictId(zone_id);
    if (zid === null) return res.status(400).json({ error: { message: 'Invalid zone_id.', code: 'VALIDATION' } });
    const zoneRes = await pool.query('SELECT id FROM zones WHERE id = $1', [zid]);
    if (zoneRes.rows.length === 0) return res.status(400).json({ error: { message: 'Invalid zone_id.', code: 'VALIDATION' } });
    targetZoneId = zid;
  }

  const storageKey = generateStorageKey(expectedExts[0]);
  const checksum = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const displayFilename = sanitizeDisplayFilename(req.file.originalname);

  const client = await pool.connect();
  let written = false;
  try {
    await putFile(req.file.buffer, storageKey);
    written = true;

    await client.query('BEGIN');
    const foRes = await client.query(
      `INSERT INTO file_objects (storage_key, original_filename, display_filename, mime_type, extension, file_size, checksum_sha256, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [storageKey, req.file.originalname.slice(0, 255), displayFilename, req.file.mimetype, expectedExts[0], req.file.size, checksum, req.user.id]
    );
    const fileObject = foRes.rows[0];
    const docRes = await client.query(
      `INSERT INTO documents (title, category, description, current_file_object_id, zone_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [String(title).trim(), category, description || null, fileObject.id, targetZoneId, req.user.id]
    );
    await client.query('COMMIT');
    const doc = docRes.rows[0];
    // storage_key is never included in the logged payload (Implementation
    // Specification §20) — doc itself has no such column (it lives on
    // file_objects), so this is a no-op guard, kept explicit in case a
    // future column rename ever put one there.
    const { storage_key: _omit, ...docForAudit } = doc;
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'document.create', entityType: 'document', entityId: doc.id, before: null, after: docForAudit });
    res.status(201).json({ data: { ...pickPublicFields(doc), file: { original_filename: fileObject.original_filename, display_filename: fileObject.display_filename, mime_type: fileObject.mime_type, file_size: fileObject.file_size } } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (written) {
      const { deleteFile } = require('../lib/documentStorage');
      await deleteFile(storageKey).catch(() => {});
    }
    res.status(500).json({ error: { message: 'Failed to upload document.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// ============================================================
// List / Detail
// ============================================================

router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const params = [];
    const filters = [];
    if (myZoneId !== null) { params.push(myZoneId); filters.push(`(d.zone_id = $${params.length} OR d.zone_id IS NULL)`); }
    filters.push(`d.status = $${params.push(req.query.status || 'active')}`);
    if (req.query.category) {
      if (!CATEGORY_VALUES.includes(req.query.category)) return res.status(400).json({ error: { message: 'Invalid category filter.', code: 'VALIDATION' } });
      filters.push(`d.category = $${params.push(req.query.category)}`);
    }
    if (req.query.uploaded_by) {
      const uid = parseStrictId(req.query.uploaded_by);
      if (uid === null) return res.status(400).json({ error: { message: 'Invalid uploaded_by.', code: 'VALIDATION' } });
      filters.push(`d.created_by = $${params.push(uid)}`);
    }
    if (req.query.title) {
      const q = req.query.title.trim();
      if (q.length >= 2) filters.push(`d.title ILIKE $${params.push(`%${q}%`)}`);
    }
    if (req.query.date_from) filters.push(`d.created_at >= $${params.push(req.query.date_from)}`);
    if (req.query.date_to) filters.push(`d.created_at <= $${params.push(req.query.date_to)}`);
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT d.*, f.original_filename, f.display_filename, f.mime_type, f.file_size, z.name AS zone_name
       FROM documents d JOIN file_objects f ON d.current_file_object_id = f.id
       LEFT JOIN zones z ON d.zone_id = z.id
       ${whereSql} ORDER BY d.created_at DESC`,
      params
    );
    res.json({ data: result.rows.map(pickPublicFields) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list documents.', code: 'INTERNAL' } });
  }
});

router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid document id.', code: 'VALIDATION' } });
  try {
    const access = await loadDocumentWithAccessCheck(req.user, id);
    if (access.error) return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } });
    res.json({ data: pickPublicFields(access.doc) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load document.', code: 'INTERNAL' } });
  }
});

// ============================================================
// Download / Preview
// ============================================================

router.get('/:id/file', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid document id.', code: 'VALIDATION' } });
  try {
    const access = await loadDocumentWithAccessCheck(req.user, id);
    if (access.error) return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } });
    const doc = access.doc;
    if (!fileExists(doc.storage_key)) {
      return res.status(404).json({ error: { message: 'File no longer exists on disk.', code: 'NOT_FOUND' } });
    }
    const action = req.query.download === '1' ? 'document.download' : 'document.preview';
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('Content-Disposition', `${disposition}; filename="${doc.display_filename.replace(/"/g, '')}"`);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action, entityType: 'document', entityId: id, before: null, after: null });
    getFileStream(doc.storage_key).on('error', () => { if (!res.headersSent) res.status(500).end(); }).pipe(res);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load document file.', code: 'INTERNAL' } });
  }
});

// ============================================================
// Metadata edit
// ============================================================

router.put('/:id', authenticateToken, requireRole(...UPLOAD_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid document id.', code: 'VALIDATION' } });
  const { title, category, description } = req.body;
  if (category !== undefined && !CATEGORY_VALUES.includes(category)) {
    return res.status(400).json({ error: { message: `category must be one of: ${CATEGORY_VALUES.join(', ')}.`, code: 'VALIDATION' } });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT * FROM documents WHERE id = $1 FOR UPDATE', [id]);
    if (before.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Document not found.', code: 'NOT_FOUND' } }); }
    const doc = before.rows[0];
    const role = (req.user.role || '').toLowerCase();
    if (role !== 'admin') {
      const myZoneId = await resolveUserZoneId(req.user);
      if (doc.zone_id === null || myZoneId === null || doc.zone_id !== myZoneId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: { message: 'You do not have access to edit this document.', code: 'FORBIDDEN' } });
      }
    }
    const fields = [];
    const params = [];
    if (title !== undefined) { if (!String(title).trim()) { await client.query('ROLLBACK'); return res.status(400).json({ error: { message: 'title cannot be empty.', code: 'VALIDATION' } }); } fields.push(`title = $${params.push(String(title).trim())}`); }
    if (category !== undefined) fields.push(`category = $${params.push(category)}`);
    if (description !== undefined) fields.push(`description = $${params.push(description || null)}`);
    if (fields.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: { message: 'No valid fields provided to update.', code: 'VALIDATION' } }); }
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(id);
    const updated = await client.query(`UPDATE documents SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'document.edit', entityType: 'document', entityId: id, before: doc, after: updated.rows[0] });
    res.json({ data: pickPublicFields(updated.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: { message: 'Failed to update document.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// ============================================================
// Replace (void-and-replace)
// ============================================================

router.post('/:id/replace', authenticateToken, requireRole(...UPLOAD_ROLES), upload.single('file'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid document id.', code: 'VALIDATION' } });
  if (!req.file) {
    return res.status(400).json({ error: { message: 'A file is required, or its type is not allowed. Supported: PDF, DOC, DOCX, XLS, XLSX, CSV, JPG, PNG, WEBP.', code: 'VALIDATION' } });
  }
  const originalExt = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || [''])[0].toLowerCase();
  const expectedExts = MIME_TO_EXTENSIONS[req.file.mimetype] || [];
  if (!expectedExts.includes(originalExt)) {
    return res.status(400).json({ error: { message: 'File extension does not match its detected type.', code: 'VALIDATION' } });
  }
  const { title, category, description } = req.body;
  if (category !== undefined && category !== '' && !CATEGORY_VALUES.includes(category)) {
    return res.status(400).json({ error: { message: `category must be one of: ${CATEGORY_VALUES.join(', ')}.`, code: 'VALIDATION' } });
  }

  const storageKey = generateStorageKey(expectedExts[0]);
  const checksum = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const displayFilename = sanitizeDisplayFilename(req.file.originalname);

  const client = await pool.connect();
  let written = false;
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT * FROM documents WHERE id = $1 FOR UPDATE', [id]);
    if (before.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Document not found.', code: 'NOT_FOUND' } }); }
    const original = before.rows[0];
    if (original.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: `Only an active document can be replaced (this one is ${original.status}).`, code: 'CONFLICT' } });
    }
    const role = (req.user.role || '').toLowerCase();
    if (role !== 'admin') {
      const myZoneId = await resolveUserZoneId(req.user);
      if (original.zone_id === null || myZoneId === null || original.zone_id !== myZoneId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: { message: 'You do not have access to replace this document.', code: 'FORBIDDEN' } });
      }
    }

    await putFile(req.file.buffer, storageKey);
    written = true;

    const foRes = await client.query(
      `INSERT INTO file_objects (storage_key, original_filename, display_filename, mime_type, extension, file_size, checksum_sha256, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [storageKey, req.file.originalname.slice(0, 255), displayFilename, req.file.mimetype, expectedExts[0], req.file.size, checksum, req.user.id]
    );
    const fileObject = foRes.rows[0];
    const newDocRes = await client.query(
      `INSERT INTO documents (title, category, description, current_file_object_id, zone_id, replaces_document_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        title !== undefined && String(title).trim() ? String(title).trim() : original.title,
        category !== undefined && category !== '' ? category : original.category,
        description !== undefined ? (description || null) : original.description,
        fileObject.id, original.zone_id, original.id, req.user.id,
      ]
    );
    const newDoc = newDocRes.rows[0];
    const voidedOriginal = await client.query(
      `UPDATE documents SET status = 'voided', voided_reason = $1, voided_by = $2, voided_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [`Replaced by document #${newDoc.id}`, req.user.id, original.id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'document.replace', entityType: 'document', entityId: newDoc.id, before: { id: original.id }, after: { replaces_document_id: original.id } });
    res.status(201).json({ data: pickPublicFields(newDoc), replaced: pickPublicFields(voidedOriginal.rows[0]) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (written) {
      const { deleteFile } = require('../lib/documentStorage');
      await deleteFile(storageKey).catch(() => {});
    }
    res.status(500).json({ error: { message: 'Failed to replace document.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// ============================================================
// Lifecycle: archive / restore / void
// ============================================================

router.put('/:id/archive', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid document id.', code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Document not found.', code: 'NOT_FOUND' } });
    if (before.rows[0].status !== 'active') return res.status(409).json({ error: { message: `Only an active document can be archived (this one is ${before.rows[0].status}).`, code: 'CONFLICT' } });
    const updated = await pool.query(`UPDATE documents SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [id]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'document.archive', entityType: 'document', entityId: id, before: before.rows[0], after: updated.rows[0] });
    res.json({ data: pickPublicFields(updated.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to archive document.', code: 'INTERNAL' } });
  }
});

router.put('/:id/restore', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid document id.', code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Document not found.', code: 'NOT_FOUND' } });
    if (before.rows[0].status !== 'archived') return res.status(409).json({ error: { message: `Only an archived document can be restored (this one is ${before.rows[0].status}).`, code: 'CONFLICT' } });
    const updated = await pool.query(`UPDATE documents SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [id]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'document.restore', entityType: 'document', entityId: id, before: before.rows[0], after: updated.rows[0] });
    res.json({ data: pickPublicFields(updated.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to restore document.', code: 'INTERNAL' } });
  }
});

router.put('/:id/void', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid document id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'A reason is required to void a document.', code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Document not found.', code: 'NOT_FOUND' } });
    if (before.rows[0].status === 'voided') return res.status(409).json({ error: { message: 'This document is already voided.', code: 'CONFLICT' } });
    const updated = await pool.query(
      `UPDATE documents SET status = 'voided', voided_reason = $1, voided_by = $2, voided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [reason, req.user.id, id]
    );
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'document.void', entityType: 'document', entityId: id, before: before.rows[0], after: updated.rows[0] });
    res.json({ data: pickPublicFields(updated.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to void document.', code: 'INTERNAL' } });
  }
});

module.exports = router;
