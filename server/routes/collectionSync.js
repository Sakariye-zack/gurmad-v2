const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { applyBatchCustomerStatusChange } = require('../lib/collectionValidation');
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
         bc.status AS customer_status
       FROM task_resources tr
       JOIN tasks t ON t.id = tr.task_id
       JOIN batches b ON b.id = t.batch_id
       JOIN batch_customers bc ON bc.batch_id = b.id
       JOIN customers c ON c.id = bc.customer_id
       WHERE tr.resource_type = 'collector' AND tr.resource_id = $1
         AND b.status IN ('assigned', 'in_progress')
       ORDER BY b.id, c.name`,
      [employeeId]
    );

    // Shape into { batches: [ { ...batch fields, customers: [...] } ] } —
    // minimized fields only, no raw GPS fed back, no financial data.
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

module.exports = router;
