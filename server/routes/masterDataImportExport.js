const express = require('express');
const multer = require('multer');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  MAX_FILE_SIZE, MAX_ROWS, parseCsv, validateHeaders, toCsv, sha256, issueValidationToken, verifyValidationToken,
} = require('../lib/csvImportExport');
const { IMPORT_ENTITIES, EXPORT_ENTITIES, resolveUserZoneId } = require('../lib/masterDataEntities');
const { sniffFileType } = require('../lib/fileSniff');

const router = express.Router();

// Master Functional Completion Program — Phase 6: Import/Export + Master
// Data Governance. Built strictly to GURMAD_V2_Phase6_..._Implementation_
// Specification.md. Entity allowlist lives entirely in
// lib/masterDataEntities.js — this file trusts nothing about `:entity`
// beyond what that registry defines (no generic pass-through).

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });

function parseStrictId(raw) {
  if (!/^\d+$/.test(String(raw ?? ''))) return null;
  return parseInt(raw, 10);
}

// ---------- Row-level field validation (layer 3) ----------
function validateFieldTypes(row, entityDef) {
  const errors = [];
  for (const f of entityDef.importFields) {
    const raw = row[f.csvColumn];
    const present = raw !== undefined && String(raw).trim() !== '';
    if (f.required && !present) {
      errors.push({ field: f.csvColumn, code: 'REQUIRED_FIELD_MISSING', message: `${f.csvColumn} is required.` });
      continue;
    }
    if (!present) continue;
    if (f.type === 'number' && isNaN(Number(raw))) {
      errors.push({ field: f.csvColumn, code: 'INVALID_FORMAT', message: `${f.csvColumn} must be a number.` });
    }
    if (f.type === 'date' && isNaN(Date.parse(raw))) {
      errors.push({ field: f.csvColumn, code: 'INVALID_FORMAT', message: `${f.csvColumn} must be a valid date.` });
    }
  }
  return errors;
}

// ---------- Layer 4: canonical-key validation ----------
function validateCanonicalKey(row, entityDef) {
  if (!entityDef.canonicalKey) return []; // customers: server-generated, no client key to validate
  const val = row[entityDef.canonicalKey];
  if (!val || !String(val).trim()) {
    return [{ field: entityDef.canonicalKey, code: 'REQUIRED_FIELD_MISSING', message: `${entityDef.canonicalKey} is required and is this entity's canonical key.` }];
  }
  return [];
}

// ---------- Layer 5: duplicate validation (within-file) ----------
function validateWithinFileDuplicates(rows, entityDef) {
  if (!entityDef.canonicalKey) return {};
  const seen = new Map();
  const perRowErrors = {};
  rows.forEach((row, i) => {
    const key = row[entityDef.canonicalKey];
    if (!key) return;
    if (seen.has(key)) {
      const firstRow = seen.get(key);
      (perRowErrors[i] = perRowErrors[i] || []).push({ field: entityDef.canonicalKey, code: 'DUPLICATE_IN_FILE', message: `This ${entityDef.canonicalKey} also appears in row ${firstRow + 1}.` });
    } else {
      seen.set(key, i);
    }
  });
  return perRowErrors;
}

// ---------- Full pipeline (layers 1-8; layer 9 is the actual INSERT at commit time only) ----------
async function runValidationPipeline({ client, entity, entityDef, buffer, actor, zoneId, companyWide }) {
  // Layer 1: file validation (size already enforced by multer; here we
  // check row count post-parse, per Spec §23 — row count can only be
  // known after parsing).
  const parsed = parseCsv(buffer);
  if (parsed.error) return { valid: false, rowCount: 0, errors: [{ row: null, field: null, ...parsed.error }] };

  // Layer 2: structural validation.
  const headerErrors = validateHeaders(parsed.headers, entityDef);
  if (headerErrors.length) return { valid: false, rowCount: parsed.rows.length, errors: headerErrors.map((e) => ({ row: null, ...e })) };

  // Layer 7: zone authorization (request-level, not per-row — checked
  // once for the whole file, per Spec §9/§12).
  const zoneErrors = [];
  if (entityDef.zoneScoped) {
    const role = (actor.role || '').toLowerCase();
    if (['gudoomiye', 'zone_accountant'].includes(role)) {
      // Server-resolved — any client zoneId/companyWide request is ignored, never an error, just overridden.
    } else if (role === 'admin') {
      if (!companyWide && zoneId === null) {
        zoneErrors.push({ row: null, field: 'zone_id', code: 'VALIDATION', message: 'A target zone_id (or company_wide) is required for this entity.' });
      }
      if (zoneId !== null) {
        const z = await client.query('SELECT id, status FROM zones WHERE id = $1', [zoneId]);
        if (z.rows.length === 0) zoneErrors.push({ row: null, field: 'zone_id', code: 'NOT_FOUND', message: 'Target zone does not exist.' });
        else if (z.rows[0].status !== 'active') zoneErrors.push({ row: null, field: 'zone_id', code: 'INACTIVE_REFERENCE', message: 'Target zone is not active.' });
      }
    }
  }
  if (zoneErrors.length) return { valid: false, rowCount: parsed.rows.length, errors: zoneErrors };

  // Layer 5 (within-file): computed once for the whole row set.
  const withinFileDupErrors = validateWithinFileDuplicates(parsed.rows, entityDef);

  const perRow = [];
  for (let i = 0; i < parsed.rows.length; i++) {
    const row = parsed.rows[i];
    const rowErrors = [];
    // Layer 3.
    rowErrors.push(...validateFieldTypes(row, entityDef));
    // Layer 4.
    rowErrors.push(...validateCanonicalKey(row, entityDef));
    // Layer 5 (within-file).
    if (withinFileDupErrors[i]) rowErrors.push(...withinFileDupErrors[i]);
    // Layer 5 (against-DB) + Layer 6 (FK) — entity-specific, via insert()'s
    // own dry-check path. To avoid actually inserting during dry-run, we
    // reuse the same duplicate/FK logic the insert() function itself runs,
    // but wrapped so it never writes: each entity's insert() is called
    // inside a SAVEPOINT that is always rolled back when `dryRun: true`.
    perRow.push({ row: i, csvRow: row, errors: rowErrors });
  }

  // Layers 5(DB)/6/8 — run each row's own entity-specific insert logic
  // inside a savepoint that is unconditionally rolled back for dry-run,
  // and left to actually commit (advancing to layer 9) only when this
  // function is called from the commit path with dryRun:false.
  for (const item of perRow) {
    if (item.errors.length > 0) continue; // already failed layers 1-5(file)/4 — skip DB round-trip for an already-doomed row, but still report it
    await client.query('SAVEPOINT row_check');
    try {
      const result = await entityDef.insert(client, item.csvRow, { actorId: actor.id, zoneId: entityDef.zoneScoped ? zoneId : null });
      if (!result.ok) {
        item.errors.push({ field: result.field || null, code: result.code, message: result.message });
      } else {
        item.insertedId = result.id;
      }
    } catch (err) {
      if (err.code === '23505') {
        item.errors.push({ field: entityDef.canonicalKey || null, code: 'DUPLICATE_IN_DATABASE', message: 'This row conflicts with a record created by a concurrent request.' });
      } else {
        item.errors.push({ field: null, code: 'DB_ERROR', message: 'Database rejected this row: ' + err.message });
      }
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT row_check');
    }
  }

  const errors = [];
  for (const item of perRow) {
    for (const e of item.errors) errors.push({ row: item.row + 1, field: e.field, code: e.code, message: e.message });
  }

  return { valid: errors.length === 0, rowCount: parsed.rows.length, errors, parsedRows: parsed.rows };
}

// ============================================================
// POST /:entity/import/validate — dry-run, zero mutation
// ============================================================

router.post('/:entity/import/validate', authenticateToken, async (req, res, next) => {
  const entity = req.params.entity;
  const entityDef = IMPORT_ENTITIES[entity];
  if (!entityDef) return res.status(404).json({ error: { message: 'Unknown import entity.', code: 'NOT_FOUND' } });
  requireRole(...entityDef.importRoles)(req, res, next);
}, upload.single('file'), async (req, res) => {
  const entity = req.params.entity;
  const entityDef = IMPORT_ENTITIES[entity];
  if (!req.file) return res.status(400).json({ error: { message: 'A CSV file is required.', code: 'VALIDATION' } });
  if (!req.file.mimetype.includes('csv') && !req.file.originalname.toLowerCase().endsWith('.csv') && req.file.mimetype !== 'text/plain' && req.file.mimetype !== 'application/vnd.ms-excel') {
    return res.status(400).json({ error: { message: 'Only .csv files are accepted.', code: 'VALIDATION' } });
  }
  // Content-sniffing validation (Future CR promoted to in-scope, Phase 10
  // Gap Audit) — see lib/fileSniff.js. The commit endpoint re-checks this
  // same file's hash against the token minted here (§ existing FILE_CHANGED
  // check), so sniffing here alone covers both steps.
  if (!sniffFileType(req.file.buffer, 'text/csv')) {
    return res.status(400).json({ error: { message: 'File content does not look like a valid CSV/text file.', code: 'VALIDATION' } });
  }

  const role = (req.user.role || '').toLowerCase();
  let zoneId = null; let companyWide = false;
  if (entityDef.zoneScoped) {
    if (['gudoomiye', 'zone_accountant'].includes(role)) {
      zoneId = await resolveUserZoneId(req.user);
      if (zoneId === null) return res.status(403).json({ error: { message: 'Your account has no resolvable zone.', code: 'FORBIDDEN' } });
    } else {
      companyWide = req.body.company_wide === 'true' || req.body.company_wide === true;
      if (!companyWide) {
        const z = parseStrictId(req.body.zone_id);
        if (z === null) return res.status(400).json({ error: { message: 'zone_id (or company_wide) is required.', code: 'VALIDATION' } });
        zoneId = z;
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await runValidationPipeline({ client, entity, entityDef, buffer: req.file.buffer, actor: req.user, zoneId, companyWide });
    await client.query('ROLLBACK'); // dry-run NEVER commits, regardless of outcome — §13 of the Specification

    if (!result.valid) {
      return res.json({ data: { valid: false, rowCount: result.rowCount, errors: result.errors } });
    }
    const fileHash = sha256(req.file.buffer);
    const validationToken = issueValidationToken({ entity, fileHash, actorId: req.user.id, zoneId, companyWide });
    res.json({ data: { valid: true, rowCount: result.rowCount, validationToken, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), errors: [] } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: { message: 'Failed to validate import file.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// ============================================================
// POST /:entity/import/commit — atomic, re-validates fully
// ============================================================

router.post('/:entity/import/commit', authenticateToken, async (req, res, next) => {
  const entity = req.params.entity;
  const entityDef = IMPORT_ENTITIES[entity];
  if (!entityDef) return res.status(404).json({ error: { message: 'Unknown import entity.', code: 'NOT_FOUND' } });
  requireRole(...entityDef.importRoles)(req, res, next);
}, upload.single('file'), async (req, res) => {
  const entity = req.params.entity;
  const entityDef = IMPORT_ENTITIES[entity];
  if (!req.file) return res.status(400).json({ error: { message: 'A CSV file is required.', code: 'VALIDATION' } });
  const { validationToken } = req.body;
  if (!validationToken) return res.status(400).json({ error: { message: 'validationToken is required.', code: 'VALIDATION' } });

  const tokenCheck = verifyValidationToken(validationToken);
  if (!tokenCheck.ok) return res.status(409).json({ error: { message: tokenCheck.message, code: tokenCheck.code } });

  const fileHash = sha256(req.file.buffer);
  if (tokenCheck.payload.fileHash !== fileHash) {
    return res.status(409).json({ error: { message: 'The uploaded file has changed since it was validated. Please re-validate.', code: 'FILE_CHANGED' } });
  }
  if (tokenCheck.payload.entity !== entity) {
    return res.status(409).json({ error: { message: 'This validation token was issued for a different entity.', code: 'ENTITY_MISMATCH' } });
  }
  if (tokenCheck.payload.actorId !== req.user.id) {
    return res.status(403).json({ error: { message: 'This validation token was not issued to you.', code: 'FORBIDDEN' } });
  }

  const zoneId = tokenCheck.payload.zoneId;
  const companyWide = tokenCheck.payload.companyWide;
  // Re-check zone authorization live (do not trust the token's own zoneId
  // claim as still valid — re-derive/re-verify it matches what the actor
  // is currently permitted, per Spec §12 "never trust the token alone").
  const role = (req.user.role || '').toLowerCase();
  if (entityDef.zoneScoped && ['gudoomiye', 'zone_accountant'].includes(role)) {
    const liveZoneId = await resolveUserZoneId(req.user);
    if (liveZoneId !== zoneId) {
      return res.status(403).json({ error: { message: 'Your zone assignment has changed since validation; please re-validate.', code: 'FORBIDDEN' } });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Full 9-layer re-validation, from scratch, inside the commit transaction.
    const result = await runValidationPipeline({ client, entity, entityDef, buffer: req.file.buffer, actor: req.user, zoneId, companyWide });
    if (!result.valid) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'Validation failed at commit time; no rows were created.', code: 'VALIDATION_FAILED' }, data: { errors: result.errors } });
    }

    // Layer 9: the actual inserts, for real this time (not inside a
    // savepoint-then-rollback — this is the one code path where insert()
    // results are kept).
    //
    // Hardening fix: each entity's own insert() does a SELECT-then-INSERT
    // duplicate pre-check, which is not atomic against a second, truly
    // concurrent transaction that has not committed yet (both see "no
    // duplicate" under READ COMMITTED). The loser's real INSERT then
    // throws a raw Postgres 23505 unique-violation, which previously
    // propagated uncaught to the outer catch block and returned a bare
    // 500 instead of the correct 409 — found live via a 3x-repeated
    // concurrent-commit-on-the-same-canonical-key test (2 of 3 runs
    // produced 201/500 instead of the required 201/409). Fixed by
    // catching 23505 here and translating it into the same
    // DUPLICATE_IN_DATABASE error shape the pre-check already produces,
    // so a genuine database-level race is reported identically to a
    // pipeline-detected one — no business-rule change, purely a
    // concurrency-safety fix.
    let created = 0;
    for (const row of result.parsedRows) {
      let insertResult;
      try {
        insertResult = await entityDef.insert(client, row, { actorId: req.user.id, zoneId });
      } catch (insertErr) {
        if (insertErr.code === '23505') {
          insertResult = { ok: false, code: 'DUPLICATE_IN_DATABASE', field: entityDef.canonicalKey || null, message: 'This row conflicts with a record created by a concurrent request. Please re-validate and retry.' };
        } else {
          throw insertErr;
        }
      }
      if (!insertResult.ok) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message: 'A row failed at commit time; the entire import was rolled back.', code: 'VALIDATION_FAILED' }, data: { errors: [{ field: insertResult.field, code: insertResult.code, message: insertResult.message }] } });
      }
      created++;
    }

    await logAudit({
      actorId: req.user.id, actorUsername: req.user.username,
      action: 'master_data.import', entityType: entity, entityId: null,
      before: null, after: { entity, zoneId, rowCount: created, filename: (req.file.originalname || '').slice(0, 255) },
    });
    await client.query('COMMIT');
    res.status(201).json({ data: { entity, created } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: { message: 'Failed to commit import.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// ============================================================
// GET /:entity/export
// ============================================================

router.get('/:entity/export', authenticateToken, async (req, res, next) => {
  const entity = req.params.entity;
  const entityDef = EXPORT_ENTITIES[entity];
  if (!entityDef) return res.status(404).json({ error: { message: 'Unknown export entity.', code: 'NOT_FOUND' } });
  requireRole(...entityDef.exportRoles)(req, res, next);
}, async (req, res) => {
  const entity = req.params.entity;
  const entityDef = EXPORT_ENTITIES[entity];
  try {
    let zoneId = null;
    if (entityDef.zoneScoped) {
      const resolved = await resolveUserZoneId(req.user);
      if (resolved !== null) {
        zoneId = resolved; // zone-scoped role — always forced to own zone, request param ignored
      } else if (req.query.zone_id) {
        const z = parseStrictId(req.query.zone_id);
        if (z === null) return res.status(400).json({ error: { message: 'Invalid zone_id.', code: 'VALIDATION' } });
        zoneId = z; // company-wide role optionally filtering
      }
    }
    const filters = { status: req.query.status, category: req.query.category, customer_type: req.query.customer_type, employee_type: req.query.employee_type, group_id: parseStrictId(req.query.group_id) || undefined };
    const rows = await entityDef.query(pool, { zoneId, filters });
    const csv = toCsv(rows, entityDef.columns);

    await logAudit({
      actorId: req.user.id, actorUsername: req.user.username,
      action: 'master_data.export', entityType: entity, entityId: null,
      before: null, after: { entity, zoneId, filters, rowCount: rows.length },
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${entity}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to export data.', code: 'INTERNAL' } });
  }
});

module.exports = router;
