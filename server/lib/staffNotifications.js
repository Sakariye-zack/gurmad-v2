const { pool } = require('../db');
const logger = require('./logger');

// Staff Notifications — Implementation Spec §5/§6. The ONE shared write
// path into v2_staff_notifications, mirroring lib/portalNotifications.js's
// own exact calling convention — the one significant structural
// difference being the recipient column (v2_users, not customers),
// per Decisions §12's explicit instruction not to reuse that table's FK
// shape. Every one of the 3 approved trigger call sites in
// routes/batches.js calls this same function; no producer invents its
// own insert.

// Recipient resolution (Spec §6) — a single, trivial, non-decisional
// lookup (employees.user_id), the same category of duplicated-but-
// justified one-line query already precedented by
// resolveEmployeeIdForUser in routes/batches.js/collectionSync.js — NOT
// a business rule, just an identity-mapping lookup. Returns null if the
// employee has no linked v2_users account (not yet migrated/no login) —
// a locked, non-error "no notification" outcome (Spec §6), never an
// invented fallback recipient.
async function resolveRecipientForEmployee(employeeId, client = pool) {
  if (employeeId == null) return null;
  const r = await client.query('SELECT user_id FROM employees WHERE id = $1', [employeeId]);
  return r.rows[0]?.user_id ?? null;
}

// Spec §8 — the batch.cancel special case: a collector can be assigned to
// more than one task within the same batch. SELECT DISTINCT is the
// data-layer fix (not frontend dedup) that guarantees exactly one
// resolved recipient per distinct collector for a single cancellation
// event, regardless of how many of the batch's tasks they're on.
async function resolveDistinctCollectorRecipientsForBatch(batchId, client = pool) {
  const r = await client.query(
    `SELECT DISTINCT e.user_id
     FROM task_resources tr
     JOIN tasks tk ON tk.id = tr.task_id
     JOIN employees e ON e.id = tr.resource_id
     WHERE tk.batch_id = $1 AND tr.resource_type = 'collector' AND e.user_id IS NOT NULL`,
    [batchId]
  );
  return r.rows.map((row) => row.user_id);
}

// Notification creation itself — a plain, parameterized INSERT, no
// transaction ownership of its own (Spec §10: the CALLER decides when
// this runs relative to its own business transaction; this function
// never opens/commits/rolls back anything).
async function createStaffNotification({ recipientId, eventType, title, body = null, entityType = null, entityId = null }, client = pool) {
  const r = await client.query(
    `INSERT INTO v2_staff_notifications (recipient_id, event_type, title, body, entity_type, entity_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [recipientId, eventType, title, body, entityType, entityId]
  );
  return r.rows[0];
}

// Structured (non-audit) logging for a notification-side-effect failure —
// never thrown further, per Spec §10/§20: a failure here must never
// corrupt or roll back the already-successful business operation it
// describes.
function logNotificationFailure(context, err) {
  // Reuses the existing structured logger, exactly as every other
  // technical (non-business) failure in this codebase already does.
  logger.error('staff_notification_failed', { context, message: err.message });
}

module.exports = {
  resolveRecipientForEmployee,
  resolveDistinctCollectorRecipientsForBatch,
  createStaffNotification,
  logNotificationFailure,
};
