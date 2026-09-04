const express = require('express');
const { pool } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { redactAuditRow } = require('../lib/auditRedaction');
const { classify, VALID_CATEGORIES, VALID_SEVERITIES } = require('../lib/auditTaxonomy');
const { toCsv } = require('../lib/reportsCalculations');

const router = express.Router();

// Audit & Security Center — Implementation Spec (Phase 1). Admin-only,
// company-wide, read-only over the EXISTING v2_audit_log (no second audit
// table, no second writer — logAudit() in db.js is untouched by this
// file). No zone_id column/filter exists here (D2, Spec §16) — this is a
// deliberate absence, not an oversight. No IP field/filter exists here
// either (Spec §16) — v2_audit_log has no ip_address column and none is
// added by this CR.
router.use(authenticateToken, requireRole('admin'));

function parseStrictId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!/^\d+$/.test(String(raw))) return null;
  return parseInt(raw, 10);
}

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d; // undefined = invalid (distinct from null = absent)
}

// Shared query-builder — used by BOTH the list endpoint and the export
// endpoint (Spec §6/§12), so export can never see more than the list view
// itself would show for the same filters ("no export bypass").
function buildWhere(query) {
  const where = [];
  const params = [];
  const errors = [];

  if (query.actor) {
    params.push(`%${String(query.actor).trim()}%`);
    where.push(`actor_username ILIKE $${params.length}`);
  }
  if (query.action) {
    params.push(String(query.action).trim());
    where.push(`action = $${params.length}`);
  }
  if (query.entity_type) {
    params.push(String(query.entity_type).trim());
    where.push(`entity_type = $${params.length}`);
  }
  if (query.entity_id) {
    const eid = parseStrictId(query.entity_id);
    if (eid === null) errors.push('Invalid entity_id filter.');
    else { params.push(eid); where.push(`entity_id = $${params.length}`); }
  }
  if (query.date_from) {
    const d = parseDate(query.date_from);
    if (d === undefined) errors.push('Invalid date_from.');
    else { params.push(d); where.push(`created_at >= $${params.length}`); }
  }
  if (query.date_to) {
    const d = parseDate(query.date_to);
    if (d === undefined) errors.push('Invalid date_to.');
    else { params.push(d); where.push(`created_at <= $${params.length}`); }
  }
  if (query.q) {
    params.push(`%${String(query.q).trim()}%`);
    const i = params.length;
    where.push(`(actor_username ILIKE $${i} OR action ILIKE $${i} OR entity_type ILIKE $${i})`);
  }
  // category/severity/success are server-derived from `action` (Spec §9),
  // not stored columns — applied as a post-filter on the classified action
  // set rather than a SQL WHERE clause, since there is no column to match
  // against directly. Validated here; applied after the DB query returns.
  if (query.category !== undefined && !VALID_CATEGORIES.includes(query.category) && query.category !== 'Uncategorized') {
    errors.push(`category must be one of: ${VALID_CATEGORIES.join(', ')}, Uncategorized.`);
  }
  if (query.severity !== undefined && !VALID_SEVERITIES.includes(query.severity)) {
    errors.push(`severity must be one of: ${VALID_SEVERITIES.join(', ')}.`);
  }
  if (query.success !== undefined && !['true', 'false'].includes(query.success)) {
    errors.push('success must be "true" or "false".');
  }

  return { where, params, errors };
}

function applyClassificationFilters(rows, query) {
  return rows.filter((row) => {
    const c = classify(row.action);
    if (query.category !== undefined && c.category !== query.category) return false;
    if (query.severity !== undefined && c.severity !== query.severity) return false;
    if (query.success !== undefined && String(c.success) !== query.success) return false;
    return true;
  });
}

function shapeRow(row) {
  const c = classify(row.action);
  return redactAuditRow({ ...row, category: c.category, severity: c.severity, success: c.success });
}

// GET /api/v2/audit — list. requireRole('admin') above runs BEFORE this
// handler body, so no query ever executes for a non-admin caller.
router.get('/', async (req, res) => {
  const { where, params, errors } = buildWhere(req.query);
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });

  try {
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // category/severity/success are classification-based, not a SQL
    // predicate — over-fetch a page-sized+buffer window is impractical to
    // do "correctly" without either duplicating the taxonomy in SQL
    // (rejected — single source of truth stays in auditTaxonomy.js) or a
    // GENERATED column (a schema change beyond the one approved index,
    // out of scope this phase). When any classification filter is
    // present, fetch the full matching set (bounded by date/other filters,
    // which every real query is expected to include) and paginate
    // in-memory; when none is present, paginate in SQL as normal — the
    // common, unfiltered-by-classification case remains a single indexed
    // query with no over-fetch.
    const hasClassificationFilter = req.query.category !== undefined || req.query.severity !== undefined || req.query.success !== undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    if (!hasClassificationFilter) {
      const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM v2_audit_log ${whereSql}`, params);
      const dataParams = [...params, limit, offset];
      const result = await pool.query(
        `SELECT * FROM v2_audit_log ${whereSql} ORDER BY created_at DESC LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
        dataParams
      );
      return res.json({ data: result.rows.map(shapeRow), meta: { total: countResult.rows[0].total, limit, offset } });
    }

    const full = await pool.query(`SELECT * FROM v2_audit_log ${whereSql} ORDER BY created_at DESC`, params);
    const filtered = applyClassificationFilters(full.rows, req.query);
    const page = filtered.slice(offset, offset + limit);
    res.json({ data: page.map(shapeRow), meta: { total: filtered.length, limit, offset } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list audit records.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/audit/export — CSV. Same buildWhere()/classification logic
// as the list above (Spec §6/§12: "no export bypass"). before_data/
// after_data deliberately excluded from CSV columns (Spec §6's own
// documented design choice) — full (redacted) detail remains available
// via GET /:id for any single record.
router.get('/export', async (req, res) => {
  const { where, params, errors } = buildWhere(req.query);
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  try {
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(`SELECT * FROM v2_audit_log ${whereSql} ORDER BY created_at DESC`, params);
    const hasClassificationFilter = req.query.category !== undefined || req.query.severity !== undefined || req.query.success !== undefined;
    const rows = (hasClassificationFilter ? applyClassificationFilters(result.rows, req.query) : result.rows).map(shapeRow);
    const csv = toCsv(rows, [
      { key: 'id', label: 'ID' },
      { key: 'created_at', label: 'Timestamp' },
      { key: 'actor_username', label: 'Actor' },
      { key: 'action', label: 'Action' },
      { key: 'category', label: 'Category' },
      { key: 'severity', label: 'Severity' },
      { key: 'success', label: 'Success' },
      { key: 'entity_type', label: 'Entity Type' },
      { key: 'entity_id', label: 'Entity ID' },
    ]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to export audit log.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/audit/:id — detail. Registered AFTER '/export' so Express's
// declaration-order matching doesn't swallow the literal '/export' path
// as if it were an :id value (same precedent already used in cashouts.js
// for '/reconciliation-preview').
router.get('/:id', async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid audit record id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query('SELECT * FROM v2_audit_log WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Audit record not found.', code: 'NOT_FOUND' } });
    res.json({ data: shapeRow(result.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load audit record.', code: 'INTERNAL' } });
  }
});

module.exports = router;
