const { pool, logAudit, logPortalAudit } = require('../db');
const { createPortalNotification } = require('./portalNotifications');

// Phase 5 — Complaints. The ONE shared implementation, imported directly by
// BOTH routes/complaints.js (staff) and the 3 new routes on
// routes/customerPortal.js (customer) — per the approved contract
// (Implementation Spec §5), no business logic is duplicated between the
// two API surfaces.

const LEGAL_TRANSITIONS = {
  pending: ['in_progress'],
  in_progress: ['resolved'],
  resolved: ['closed'],
  closed: [],
};

// Only Admin/Gudoomiye may transition status, assign, set priority, or
// reply — derived directly from the approved RBAC matrix (every other role
// is explicitly read-only or no-access), reconfirmed explicitly for the
// Closed transition by the user's own Clarification 1.
const MANAGEMENT_ROLES = ['admin', 'gudoomiye'];

async function createComplaint({ customerId, title, description, priority = 'medium', source = 'customer', createdBy = null }, client = pool) {
  const r = await client.query(
    `INSERT INTO complaints (customer_id, title, description, priority, source, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [customerId, title, description, priority, source, createdBy]
  );
  const complaint = r.rows[0];
  if (source === 'staff') {
    await logAudit({ actorId: createdBy, action: 'create', entityType: 'complaint', entityId: complaint.id, after: complaint });
  } else {
    await logPortalAudit({ customerId, action: 'complaint_submitted', details: { complaintId: complaint.id } });
  }
  return complaint;
}

async function getComplaintsForCustomer({ customerId, limit = 100, offset = 0 }, client = pool) {
  const r = await client.query(
    `SELECT id, title, description, status, priority, admin_reply, replied_at, created_at
     FROM complaints WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [customerId, limit, offset]
  );
  return r.rows;
}

// Ownership enforced INSIDE the query — a mismatched customerId returns
// null (the caller maps this to 404), never assembling another customer's
// row, matching the exact pattern getCollectionDetail()/getInvoiceBalance()
// already established.
async function getComplaintDetail({ complaintId, customerId }, client = pool) {
  const r = await client.query(
    `SELECT c.*, e.name AS assigned_to_name,
            (SELECT json_agg(json_build_object('id', a.id, 'original_filename', a.original_filename, 'mime_type', a.mime_type, 'uploaded_at', a.uploaded_at))
             FROM complaint_attachments a WHERE a.complaint_id = c.id) AS attachments
     FROM complaints c
     LEFT JOIN employees e ON e.id = c.assigned_to
     WHERE c.id = $1 AND c.customer_id = $2`,
    [complaintId, customerId]
  );
  return r.rows[0] || null;
}

// Staff list — RBAC/zone-scoped per the approved matrix. `scope` shapes the
// WHERE clause: { zoneId } for gudoomiye/zone_accountant, {} (no filter)
// for admin/head_of_cashiers.
async function getComplaintsForStaff({ zoneId = null, status = null, limit = 100, offset = 0 }, client = pool) {
  const clauses = [];
  const params = [];
  if (zoneId !== null) { params.push(zoneId); clauses.push(`cust.zone_id = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`c.status = $${params.length}`); }
  params.push(limit, offset);
  const r = await client.query(
    `SELECT c.id, c.title, c.status, c.priority, c.source, c.created_at,
            cust.name AS customer_name, cust.customer_number, e.name AS assigned_to_name
     FROM complaints c
     JOIN customers cust ON cust.id = c.customer_id
     LEFT JOIN employees e ON e.id = c.assigned_to
     ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
     ORDER BY c.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return r.rows;
}

async function getComplaintDetailForStaff({ complaintId, zoneId = null }, client = pool) {
  const clauses = ['c.id = $1'];
  const params = [complaintId];
  if (zoneId !== null) { params.push(zoneId); clauses.push(`cust.zone_id = $${params.length}`); }
  const r = await client.query(
    `SELECT c.*, cust.name AS customer_name, cust.customer_number, cust.zone_id,
            e.name AS assigned_to_name,
            (SELECT json_agg(json_build_object('id', a.id, 'original_filename', a.original_filename, 'mime_type', a.mime_type, 'uploaded_at', a.uploaded_at))
             FROM complaint_attachments a WHERE a.complaint_id = c.id) AS attachments
     FROM complaints c
     JOIN customers cust ON cust.id = c.customer_id
     LEFT JOIN employees e ON e.id = c.assigned_to
     WHERE ${clauses.join(' AND ')}`,
    params
  );
  return r.rows[0] || null;
}

// Transition authorization: only MANAGEMENT_ROLES may call this at all
// (enforced by the route's own requireRole, not re-checked here); this
// function enforces the LEGAL sequence itself — no skip, no backward move,
// per the approved linear lifecycle.
async function updateComplaintStatus({ complaintId, newStatus, actorId }, client = pool) {
  const current = await client.query('SELECT status, customer_id FROM complaints WHERE id = $1', [complaintId]);
  if (current.rows.length === 0) return { error: 'NOT_FOUND' };
  const before = current.rows[0].status;
  const legal = LEGAL_TRANSITIONS[before] || [];
  if (!legal.includes(newStatus)) return { error: 'ILLEGAL_TRANSITION', before };

  const extra = newStatus === 'resolved' ? ', resolved_at = NOW()' : newStatus === 'closed' ? ', closed_at = NOW()' : '';
  const r = await client.query(
    `UPDATE complaints SET status = $1, updated_at = NOW()${extra} WHERE id = $2 RETURNING *`,
    [newStatus, complaintId]
  );
  const complaint = r.rows[0];
  await logAudit({ actorId, action: 'status_change', entityType: 'complaint', entityId: complaintId, before: { status: before }, after: { status: newStatus } });

  // Customer notification — ONLY on reaching 'resolved', per the approved
  // trigger scope. No call site exists for in_progress/closed/any other
  // transition — a structural guarantee, not a runtime filter.
  if (newStatus === 'resolved') {
    await createPortalNotification({
      customerId: complaint.customer_id, type: 'complaint_status', title: 'Your complaint has been resolved',
      body: complaint.title, actionType: 'complaint', actionId: complaint.id,
    });
  }
  return { data: complaint };
}

// Assignment eligibility: active + approved office-type + same zone as the
// complaint's customer — all 3 enforced server-side here, not just via a
// filtered dropdown in the UI. Collector-type is structurally excluded by
// the employee_type='office' check alone.
async function assignComplaint({ complaintId, employeeId, actorId }, client = pool) {
  const complaintRes = await client.query(
    `SELECT c.id, cust.zone_id AS customer_zone_id FROM complaints c JOIN customers cust ON cust.id = c.customer_id WHERE c.id = $1`,
    [complaintId]
  );
  if (complaintRes.rows.length === 0) return { error: 'NOT_FOUND' };
  const customerZoneId = complaintRes.rows[0].customer_zone_id;

  const empRes = await client.query('SELECT id, status, employee_type, zone_id FROM employees WHERE id = $1', [employeeId]);
  if (empRes.rows.length === 0) return { error: 'EMPLOYEE_NOT_FOUND' };
  const emp = empRes.rows[0];
  if (emp.status !== 'active') return { error: 'EMPLOYEE_INACTIVE' };
  if (emp.employee_type !== 'office') return { error: 'EMPLOYEE_INELIGIBLE_TYPE' };
  if (customerZoneId !== null && emp.zone_id !== customerZoneId) return { error: 'EMPLOYEE_WRONG_ZONE' };

  const r = await client.query(
    'UPDATE complaints SET assigned_to = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [employeeId, complaintId]
  );
  await logAudit({ actorId, action: 'assign', entityType: 'complaint', entityId: complaintId, after: { assigned_to: employeeId } });
  return { data: r.rows[0] };
}

async function replyToComplaint({ complaintId, reply, actorId }, client = pool) {
  const r = await client.query(
    'UPDATE complaints SET admin_reply = $1, replied_at = NOW(), updated_at = NOW() WHERE id = $2 RETURNING *',
    [reply, complaintId]
  );
  if (r.rows.length === 0) return { error: 'NOT_FOUND' };
  const complaint = r.rows[0];
  await logAudit({ actorId, action: 'reply', entityType: 'complaint', entityId: complaintId, after: { admin_reply: reply } });

  // Customer notification — the second (and only other) approved trigger.
  await createPortalNotification({
    customerId: complaint.customer_id, type: 'complaint_reply', title: 'You have a reply on your complaint',
    body: complaint.title, actionType: 'complaint', actionId: complaint.id,
  });
  return { data: complaint };
}

async function setComplaintPriority({ complaintId, priority, actorId }, client = pool) {
  const r = await client.query(
    'UPDATE complaints SET priority = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [priority, complaintId]
  );
  if (r.rows.length === 0) return { error: 'NOT_FOUND' };
  await logAudit({ actorId, action: 'priority_change', entityType: 'complaint', entityId: complaintId, after: { priority } });
  return { data: r.rows[0] };
}

module.exports = {
  MANAGEMENT_ROLES, LEGAL_TRANSITIONS,
  createComplaint, getComplaintsForCustomer, getComplaintDetail,
  getComplaintsForStaff, getComplaintDetailForStaff,
  updateComplaintStatus, assignComplaint, replyToComplaint, setComplaintPriority,
};
