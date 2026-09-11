const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { applyBatchCustomerStatusChange } = require('../lib/collectionValidation');
const { sniffFileType } = require('../lib/fileSniff');
const { putFile, getFileStream, fileExists } = require('../lib/documentStorage');
const logger = require('../lib/logger');

const router = express.Router();

// Offline/Sync — Wave 1. New, additive module. Reuses:
//   - authenticateToken/requireRole (unmodified, UAA-owned)
//   - applyBatchCustomerStatusChange (the canonical, extracted status-
//     transition function — Collection Operations CR, commit 8e9ac5a)
//   - logAudit()/v2_audit_log (unmodified, Audit Center-owned)
// Introduces NO schema change. Idempotency dedup is implemented by
// querying the existing v2_audit_log's after_data JSONB for a previously
// recorded action_uuid — see applyStatusChangeAction() below for the
// disclosed limitation this implies under true concurrency.
router.use(authenticateToken);

// ---------- Shared identity resolution (deliberately duplicated) ----------
//
// Both resolveEmployeeIdForUser and the task_resources ownership check
// below are copied, verbatim in behavior, from the equivalent private
// helpers already used by routes/batches.js's own PUT .../status route.
// This is a deliberate, explicitly-justified duplication of two TRIVIAL,
// non-decisional, single-statement existence lookups (no branching, no
// policy) — NOT a duplication of the actual status-transition BUSINESS
// RULE, which is not re-implemented here; it is reused, unmodified, via
// applyBatchCustomerStatusChange(). This mirrors the Offline/Sync
// Implementation Specification's own §L justification for the identical
// treatment of resolveEmployeeIdForUser in the Assignments endpoint.
async function resolveEmployeeIdForUser(user) {
  const r = await pool.query('SELECT id FROM employees WHERE user_id = $1', [user.id]);
  return r.rows[0]?.id ?? null;
}

async function collectorOwnsTask(taskId, employeeId) {
  const r = await pool.query(
    `SELECT 1 FROM task_resources WHERE task_id = $1 AND resource_type = 'collector' AND resource_id = $2 LIMIT 1`,
    [taskId, employeeId]
  );
  return r.rows.length > 0;
}

function parsePositiveInt(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------- GET /my-assignments — Decision 10, fully specified, unblocked ----------
//
// JWT-identity-scoped (never a client-supplied employee id), minimized
// response fields (no billing/financial data), zero schema change.
router.get('/my-assignments', requireRole('collector', 'admin'), async (req, res) => {
  try {
    const employeeId = await resolveEmployeeIdForUser(req.user);
    if (employeeId === null) {
      return res.json({ data: { batches: [] } }); // not a collector-linked account — an empty, valid result, not an error
    }
    const result = await pool.query(
      `SELECT
         b.id AS batch_id, b.batch_code, b.status AS batch_status, b.zone_id, b.cycle_id,
         t.id AS task_id, t.status AS task_status,
         c.id AS customer_id, c.customer_number, c.name, c.business_name, c.phone, c.address_line, c.customer_type,
         c.lat, c.lng,
         z.name AS zone_name, COALESCE(g.name, g.code) AS group_name, COALESCE(r.name, r.code) AS route_name,
         bc.status AS customer_status
       FROM task_resources tr
       JOIN tasks t ON t.id = tr.task_id
       JOIN batches b ON b.id = t.batch_id
       JOIN batch_customers bc ON bc.batch_id = b.id
       JOIN customers c ON c.id = bc.customer_id
       LEFT JOIN zones z ON z.id = c.zone_id
       LEFT JOIN groups g ON g.id = c.group_id
       LEFT JOIN routes r ON r.id = c.route_id
       WHERE tr.resource_type = 'collector' AND tr.resource_id = $1
         AND b.status IN ('assigned', 'in_progress')
       ORDER BY b.id, c.name`,
      [employeeId]
    );

    // Shape into { batches: [ { ...batch fields, customers: [...] } ] } —
    // minimized fields only, no financial data. lat/lng ARE included
    // (user-requested, Phase 10) — this is the customer's own registered
    // location (the same field CustomerFormModal.jsx now captures at
    // registration, and the Staff Map already plots), needed here so the
    // collector can actually navigate to the site they're assigned to.
    // Distinct from the "no raw GPS fed back" guarantee this comment
    // originally referred to, which is about never exposing a COLLECTION
    // EVENT's own captured GPS (where a collector stood when marking a
    // visit — a hard, out-of-band privacy boundary per the Map module's
    // own design) — that boundary is untouched; this is static customer
    // master data, already visible here via address_line/phone/name.
    const batches = new Map();
    for (const row of result.rows) {
      if (!batches.has(row.batch_id)) {
        batches.set(row.batch_id, {
          id: row.batch_id, batch_code: row.batch_code, status: row.batch_status,
          zone_id: row.zone_id, cycle_id: row.cycle_id, customers: [],
        });
      }
      batches.get(row.batch_id).customers.push({
        customer_id: row.customer_id, customer_number: row.customer_number,
        name: row.name, business_name: row.business_name, phone: row.phone,
        address_line: row.address_line, customer_type: row.customer_type,
        lat: row.lat, lng: row.lng,
        zone_name: row.zone_name, group_name: row.group_name, route_name: row.route_name,
        status: row.customer_status, task_id: row.task_id, task_status: row.task_status,
      });
    }
    res.json({ data: { batches: Array.from(batches.values()) } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load assignments.', code: 'INTERNAL' } });
  }
});

// ---------- POST /replay — sync-submission endpoint ----------
//
// Accepts a batch of offline-captured actions, processes EACH ONE
// independently (Decision 6 — hybrid/per-action, never a false aggregate
// success), and returns one explicit outcome per action.
//
// Authentication/reauthentication: enforced ONCE for the whole request by
// the existing authenticateToken middleware (router.use, above) — a
// request carrying an expired or tokenVersion-revoked token never reaches
// this handler at all (401, before any action is processed). This is the
// server-side half of Decision 2's "sync requires reauthentication"
// rule — the client's own responsibility is to hold queued actions locally
// and only attempt this endpoint after obtaining a fresh token. Per-action
// `requires_reauthentication` therefore does not occur WITHIN a single
// accepted request in this implementation (disclosed explicitly, not
// silently omitted — see Implementation Report §7).
router.post('/replay', requireRole('collector', 'admin'), async (req, res) => {
  const actions = Array.isArray(req.body?.actions) ? req.body.actions : null;
  if (!actions || actions.length === 0) {
    return res.status(400).json({ error: { message: 'actions must be a non-empty array.', code: 'VALIDATION' } });
  }

  const employeeId = await resolveEmployeeIdForUser(req.user).catch(() => null);
  const results = [];

  for (const action of actions) {
    results.push(await processOneAction(action, req.user, employeeId));
  }

  // Per-action results only — NEVER a single boolean "success". The client
  // reconciles each action_uuid independently against its own local queue.
  res.json({ results });
});

async function processOneAction(action, user, employeeId) {
  const action_uuid = typeof action?.action_uuid === 'string' ? action.action_uuid : null;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!action_uuid || !UUID_RE.test(action_uuid)) {
    return { action_uuid: action_uuid || null, outcome: 'rejected_invalid_state', retryable: false, message: 'action_uuid must be a valid UUID.' };
  }
  if (action.action_type !== 'batch_customer.status_change') {
    return { action_uuid, outcome: 'rejected_invalid_state', retryable: false, message: `Unsupported action_type "${action.action_type}".` };
  }

  const batchId = parsePositiveInt(action.batch_id);
  const customerId = parsePositiveInt(action.customer_id);
  if (batchId === null || customerId === null) {
    return { action_uuid, outcome: 'rejected_invalid_state', retryable: false, message: 'batch_id and customer_id must be positive integers.' };
  }

  // Idempotency check (§F of the Specification): only ACCEPTED outcomes
  // are deduplicated — a rejected attempt mutated nothing, so recomputing
  // it fresh is safe and gives the client current information rather than
  // a stale cached rejection. DISCLOSED LIMITATION: this check and the
  // eventual write are not atomic with each other (no unique constraint
  // backs this, since no new schema was authorized) — under TRUE
  // concurrent replay of the identical action_uuid, the underlying
  // SELECT...FOR UPDATE row lock inside applyBatchCustomerStatusChange
  // still guarantees the mutation itself can never execute twice, but the
  // *second* racing request could receive `rejected_stale` instead of
  // `already_applied` in that narrow window. No duplicate mutation is
  // possible either way. See Implementation Report §6/§20.
  //
  // HARDENING FIX (H-1, P1): the dedup lookup MUST be scoped to the
  // requesting actor (actor_id). Without this scope, a different
  // authenticated identity submitting the identical action_uuid (a
  // guessed/replayed/coincidentally-colliding UUID) would receive
  // `already_applied` carrying the ORIGINAL actor's full result payload —
  // a cross-identity data leak that also bypasses the DR-1 ownership
  // check entirely, since this lookup runs before it. Scoping by
  // actor_id closes this: a different identity replaying someone else's
  // action_uuid now falls through to the normal ownership/state-machine
  // path below and is rejected on its own merits, never short-circuited
  // into seeing another actor's data. Verified via a live cross-identity
  // replay test — see Hardening Report §3.
  const priorRes = await pool.query(
    `SELECT after_data FROM v2_audit_log WHERE action = 'collection_sync.accepted' AND actor_id = $1 AND after_data->>'action_uuid' = $2 LIMIT 1`,
    [user.id, action_uuid]
  );
  if (priorRes.rows.length > 0) {
    return { action_uuid, outcome: 'already_applied', retryable: false, data: priorRes.rows[0].after_data };
  }

  // DR-1 ownership re-check — duplicated trivial existence check (see file
  // header), NOT a duplicated business rule; the actual state-transition
  // rule is enforced exclusively by applyBatchCustomerStatusChange below.
  if ((user.role || '').toLowerCase() === 'collector') {
    const taskId = parsePositiveInt(action.task_id);
    if (taskId === null) {
      return { action_uuid, outcome: 'rejected_invalid_state', retryable: false, message: 'task_id is required.' };
    }
    const owns = employeeId !== null && (await collectorOwnsTask(taskId, employeeId));
    if (!owns) {
      await logAudit({
        actorId: user.id, actorUsername: user.username, action: 'collection_sync.rejected_invalid_state',
        entityType: 'batch_customer', entityId: null,
        before: null, after: { action_uuid, batch_id: batchId, customer_id: customerId, reason: 'not_owned' },
      });
      return { action_uuid, outcome: 'rejected_invalid_state', retryable: false, message: 'This task is not assigned to you.' };
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Canonical, unmodified, reused status-transition logic — the exact
    // same function the online route calls (Collection Operations CR,
    // commit 8e9ac5a). Server state is revalidated here regardless of
    // what the offline client believed was true at capture time.
    const result = await applyBatchCustomerStatusChange(client, {
      batchId, customerId,
      status: action.status, reason: action.reason, note: action.note,
      lat: action.lat, lng: action.lng,
    });

    if (!result.ok) {
      await client.query('ROLLBACK');
      const outcome = result.code === 'CONFLICT' ? 'rejected_stale' : 'rejected_invalid_state';
      await logAudit({
        actorId: user.id, actorUsername: user.username, action: `collection_sync.${outcome}`,
        entityType: 'batch_customer', entityId: null,
        before: null, after: { action_uuid, batch_id: batchId, customer_id: customerId, reason: result.error },
      });
      return { action_uuid, outcome, retryable: false, message: result.error };
    }

    await client.query('COMMIT');
    const afterWithKey = { ...result.after, action_uuid };
    await logAudit({
      actorId: user.id, actorUsername: user.username, action: 'collection_sync.accepted',
      entityType: 'batch_customer', entityId: result.before.id,
      before: result.before, after: afterWithKey,
    });
    return { action_uuid, outcome: 'accepted', retryable: false, data: afterWithKey };
  } catch (err) {
    await client.query('ROLLBACK');
    // Technical/infrastructure failure — NOT one of the 5 business outcomes
    // (accepted/already_applied/rejected_stale/rejected_invalid_state/
    // requires_reauthentication). Disclosed explicitly: the Retry Model
    // requires distinguishing retryable technical failures from
    // non-retryable business rejections, which the 5 business-shaped
    // outcomes alone cannot represent — this minimal, clearly-labeled
    // addition (retryable:true, outcome:'technical_error') is the
    // mechanism, logged via the existing structured logger, not audited
    // as a business event (nothing state-changing happened).
    logger.error('collection_sync_technical_failure', { action_uuid, message: err.message });
    return { action_uuid, outcome: 'technical_error', retryable: true, message: 'A technical error occurred; this action may be retried.' };
  } finally {
    client.release();
  }
}

// ---------- POST /photo — Serviced-visit photo evidence ----------
//
// Future CR promoted to in-scope, Phase 10 Gap Audit follow-up (High
// priority, from the consolidated Future CR register). The client's own
// "Serviced requires a photo" rule (CollectionActionScreen.jsx §15) had
// no backend counterpart — the photo was captured only as a camera-
// permission proof-of-access, never actually uploaded. Fixed here as a
// SEPARATE endpoint from /replay, not folded into it, because a photo is
// binary multipart data and the offline action queue itself carries only
// JSON (§14) — the client is expected to call this once its /replay call
// for the matching action_uuid comes back `accepted`.
//
// Reuses, unmodified: the exact same idempotency-lookup + ownership
// pattern already proven in processOneAction() above; documentStorage.js
// (Phase 5's storage seam, unmodified — the SAME upload directory
// Documents already uses, no new one created); fileSniff.js (Phase 10's
// content-sniffing fix, applied here too, not skipped). ZERO schema
// change: batch_customers.status_photo already exists (added by the
// original Collection Operations CR, commit 8e9ac5a) and was simply
// never written to by any route until now — this is "wire up an
// existing dead column," not a new column.
const PHOTO_ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const uploadPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // a phone camera photo, not a general document — same order of magnitude as Settings' logo limit, not Documents' 15MB
  fileFilter: (req, file, cb) => cb(null, PHOTO_ALLOWED_MIME.includes(file.mimetype)),
});

router.post('/photo', requireRole('collector', 'admin'), uploadPhoto.single('photo'), async (req, res) => {
  const action_uuid = typeof req.body?.action_uuid === 'string' ? req.body.action_uuid : null;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!action_uuid || !UUID_RE.test(action_uuid)) {
    return res.status(400).json({ error: { message: 'action_uuid must be a valid UUID.', code: 'VALIDATION' } });
  }
  if (!req.file) {
    return res.status(400).json({ error: { message: 'A photo file is required (JPEG, PNG, or WEBP, max 8MB).', code: 'VALIDATION' } });
  }
  if (!sniffFileType(req.file.buffer, req.file.mimetype)) {
    return res.status(400).json({ error: { message: 'Photo content does not match its claimed type.', code: 'VALIDATION' } });
  }

  // The photo may only be attached to an action THIS actor already got
  // `accepted` for — same actor_id scoping rationale as H-1 above (never
  // trust a client-supplied batch_customer id directly).
  const priorRes = await pool.query(
    `SELECT entity_id, after_data FROM v2_audit_log WHERE action = 'collection_sync.accepted' AND actor_id = $1 AND after_data->>'action_uuid' = $2 LIMIT 1`,
    [req.user.id, action_uuid]
  );
  if (priorRes.rows.length === 0) {
    return res.status(409).json({ error: { message: 'No accepted status-change was found for this action_uuid. Sync the status change first.', code: 'CONFLICT' } });
  }
  const batchCustomerId = priorRes.rows[0].entity_id;
  if (priorRes.rows[0].after_data?.status !== 'serviced') {
    return res.status(400).json({ error: { message: 'A photo may only be attached to a Serviced status change.', code: 'VALIDATION' } });
  }

  const ext = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[req.file.mimetype];
  const storageKey = `visit-${Date.now()}-${crypto.randomInt(1e9)}${ext}`;

  try {
    // One-shot, like every other status_* column on this row — a second
    // photo for the same visit is rejected, not silently overwritten,
    // matching how status/status_reason/status_note are already immutable
    // once the visit is recorded.
    const updateRes = await pool.query(
      `UPDATE batch_customers SET status_photo = $1 WHERE id = $2 AND status_photo IS NULL RETURNING id`,
      [storageKey, batchCustomerId]
    );
    if (updateRes.rows.length === 0) {
      return res.status(409).json({ error: { message: 'A photo has already been recorded for this visit.', code: 'CONFLICT' } });
    }
    await putFile(req.file.buffer, storageKey);
    await logAudit({
      actorId: req.user.id, actorUsername: req.user.username, action: 'collection_sync.photo_attached',
      entityType: 'batch_customer', entityId: batchCustomerId, before: null, after: { action_uuid },
    });
    res.status(201).json({ data: { batch_customer_id: batchCustomerId, uploaded: true } });
  } catch (err) {
    logger.error('collection_sync_photo_failure', { action_uuid, message: err.message });
    res.status(500).json({ error: { message: 'Failed to save photo; this may be retried.', code: 'INTERNAL' } });
  }
});

// ---------- GET /photo/:batchCustomerId — stream a visit photo ----------
//
// Same VIEW_ROLES as batches.js's own GET routes; zone-scoped the same
// way (gudoomiye/zone_accountant restricted to their own zone's batch).
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'collector'];
router.get('/photo/:batchCustomerId', requireRole(...VIEW_ROLES), async (req, res) => {
  const id = /^\d+$/.test(String(req.params.batchCustomerId)) ? parseInt(req.params.batchCustomerId, 10) : null;
  if (id === null) return res.status(400).json({ error: { message: 'Invalid id.', code: 'VALIDATION' } });

  const r = await pool.query(
    `SELECT bc.status_photo, b.zone_id FROM batch_customers bc JOIN batches b ON b.id = bc.batch_id WHERE bc.id = $1`,
    [id]
  );
  if (r.rows.length === 0 || !r.rows[0].status_photo) {
    return res.status(404).json({ error: { message: 'No photo found for this visit.', code: 'NOT_FOUND' } });
  }
  const role = (req.user.role || '').toLowerCase();
  if (['gudoomiye', 'zone_accountant'].includes(role)) {
    const zoneRes = await pool.query('SELECT id FROM zones WHERE name = $1', [req.user.zone]);
    const myZoneId = zoneRes.rows[0]?.id ?? null;
    if (myZoneId === null || r.rows[0].zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this photo.', code: 'FORBIDDEN' } });
    }
  }
  const storageKey = r.rows[0].status_photo;
  if (!fileExists(storageKey)) {
    return res.status(404).json({ error: { message: 'Photo file is missing.', code: 'NOT_FOUND' } });
  }
  const extToMime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  const ext = (storageKey.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  res.type(extToMime[ext] || 'application/octet-stream');
  getFileStream(storageKey).pipe(res);
});

module.exports = router;
