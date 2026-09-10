const crypto = require('crypto');
const { parse } = require('csv-parse/sync');

// Master Functional Completion Program — Phase 6: Import/Export + Master
// Data Governance. Shared, entity-agnostic mechanics ONLY — no entity
// business logic and no entity allowlist lives here (that is
// masterDataEntities.js's job, per the Implementation Specification §4's
// explicit anti-genericity requirement). This file is the shared
// *mechanism*, never a generic "import anything" surface.

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB — Decisions §18, NOT Phase 5's 15MB
const MAX_ROWS = 5000; // Decisions §18

// ---------- CSV parsing (server-side only, RFC 4180) ----------
// Implementation Specification §10/§21: csv-parse handles quoted fields
// with embedded commas/newlines/escaped-quotes correctly, which a naive
// split(',') cannot. Synchronous API (csv-parse/sync) is used since Phase
// 6 imports run inside one request/response cycle (Spec §23 — no
// background job queue in MVP).
function parseCsv(buffer) {
  // Strip UTF-8 BOM if present (Spec §10).
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let records;
  try {
    records = parse(text, {
      columns: true, // first row is header; each record becomes {header: value}
      skip_empty_lines: true, // blank rows skipped silently, Spec §10
      trim: false, // do not silently trim — field-level validation (layer 3) decides
      relax_column_count: false, // ragged rows (different column count than header) are malformed CSV
      bom: false, // already stripped above
    });
  } catch (err) {
    return { error: { code: 'MALFORMED_CSV', message: 'The uploaded file is not valid CSV: ' + err.message } };
  }

  if (records.length === 0) {
    return { error: { code: 'MALFORMED_CSV', message: 'The uploaded file contains no data rows.' } };
  }
  if (records.length > MAX_ROWS) {
    return { error: { code: 'TOO_MANY_ROWS', message: `File contains ${records.length} rows; the maximum is ${MAX_ROWS}.` } };
  }

  // Duplicate header detection: csv-parse's `columns: true` silently keeps
  // only the LAST occurrence of a repeated header name, which would hide
  // a real ambiguity. Re-parse the raw header line ourselves to check.
  const headerLine = text.split(/\r\n|\n/, 1)[0];
  const rawHeaders = parse(headerLine, { columns: false, skip_empty_lines: true })[0] || [];
  const seen = new Set();
  for (const h of rawHeaders) {
    if (seen.has(h)) {
      return { error: { code: 'MALFORMED_CSV', message: `Duplicate column header "${h}" is not allowed.` } };
    }
    seen.add(h);
  }

  return { headers: rawHeaders, rows: records };
}

// ---------- Structural validation: header set vs. entity's registry allowlist ----------
function validateHeaders(headers, entityDef) {
  const errors = [];
  const allowed = new Set(entityDef.importFields.map((f) => f.csvColumn));
  const required = entityDef.importFields.filter((f) => f.required).map((f) => f.csvColumn);

  for (const h of headers) {
    if (!allowed.has(h)) {
      errors.push({ row: null, field: h, code: 'UNRECOGNIZED_COLUMN', message: `Column "${h}" is not a recognized field for this entity.` });
    }
  }
  for (const r of required) {
    if (!headers.includes(r)) {
      errors.push({ row: null, field: r, code: 'MISSING_COLUMN', message: `Required column "${r}" is missing.` });
    }
  }
  return errors;
}

// ---------- CSV formula-injection sanitization (Decisions §26 — ADAPT of audit.js's own H-A1 fix; audit.js is CLOSED and not imported from) ----------
const FORMULA_LEAD_RE = /^[=+\-@]/;
function csvFormulaSafe(value) {
  if (typeof value !== 'string') return value;
  return FORMULA_LEAD_RE.test(value) ? `'${value}` : value;
}

// ---------- CSV serialization (export) — same shape/behavior as the existing, unmodified lib/reportsCalculations.js:toCsv(), duplicated here rather than imported since that module is CLOSED and never exposed toCsv as a cross-phase shared export contract. ----------
function toCsv(rows, columns) {
  const header = columns.map((c) => `"${c.label.replace(/"/g, '""')}"`).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => {
      const v = csvFormulaSafe(row[c.key]);
      const s = v == null ? '' : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    }).join(',')
  );
  return [header, ...lines].join('\r\n');
}

// ---------- Validation token (dry-run -> commit binding) ----------
// Implementation Specification §12: HMAC-signed, bound to the exact file
// bytes (via hash), the entity, the actor, and the resolved zone/scope —
// never a bare boolean flag. Uses a dedicated secret derived from
// JWT_SECRET (never reuses the raw auth secret verbatim as a distinct
// HMAC key, to keep the two token types cryptographically independent).
const TOKEN_SECRET = crypto.createHash('sha256').update(String(process.env.JWT_SECRET || '') + ':phase6-import-token').digest();
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough to review a dry-run report, short enough to keep the binding meaningful

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function issueValidationToken({ entity, fileHash, actorId, zoneId, companyWide }) {
  const payload = { entity, fileHash, actorId, zoneId: zoneId ?? null, companyWide: !!companyWide, issuedAt: Date.now(), expiresAt: Date.now() + TOKEN_TTL_MS };
  const json = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(json).digest('hex');
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url');
}

// Returns { ok: true, payload } or { ok: false, code, message } — never
// throws. Signature and expiry are checked here; the CALLER (route
// handler) is still responsible for re-comparing fileHash/entity/actor/
// zone against the live request, per Spec §12 — this function alone is
// not "proof of validation," it only proves the token wasn't forged/
// tampered/expired.
function verifyValidationToken(token) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch (e) {
    return { ok: false, code: 'INVALID_TOKEN', message: 'Validation token is malformed.' };
  }
  const { payload, sig } = parsed || {};
  if (!payload || !sig) return { ok: false, code: 'INVALID_TOKEN', message: 'Validation token is malformed.' };
  const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(JSON.stringify(payload)).digest('hex');
  // Constant-time compare.
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expectedSig, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, code: 'INVALID_TOKEN', message: 'Validation token signature is invalid.' };
  }
  if (Date.now() > payload.expiresAt) {
    return { ok: false, code: 'TOKEN_EXPIRED', message: 'Validation token has expired; please re-validate the file.' };
  }
  return { ok: true, payload };
}

module.exports = {
  MAX_FILE_SIZE, MAX_ROWS,
  parseCsv, validateHeaders, csvFormulaSafe, toCsv,
  sha256, issueValidationToken, verifyValidationToken,
};
