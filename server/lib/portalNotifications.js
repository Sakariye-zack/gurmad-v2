const { pool } = require('../db');

// Customer Portal Rebuild — the ONE shared write path into
// customer_portal_notifications (Implementation Spec §8), so every future
// producer (invoices, payments, collections, Complaints once Phase 5
// exists, account/security events) writes through the same function
// rather than each inventing its own insert. No producer calls this yet
// in this pass — the table/read-side is built now per the approved
// "infrastructure now, not a UI shell" decision; wiring in a live
// producer is out of scope until that producer (e.g. Phase 5 Complaints)
// itself exists.
async function createPortalNotification(
  { customerId, type, title, body = null, actionType = null, actionId = null },
  client = pool
) {
  const r = await client.query(
    `INSERT INTO customer_portal_notifications (customer_id, type, title, body, action_type, action_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [customerId, type, title, body, actionType, actionId]
  );
  return r.rows[0];
}

module.exports = { createPortalNotification };
