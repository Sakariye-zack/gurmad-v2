const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { resolveEmployeeIdForRequestUser } = require('../lib/hrCalculations');

const router = express.Router();

const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant'];
const APPROVE_ROLES = ['admin', 'gudoomiye'];

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

async function assertEmployeeInScope(user, employeeId, client = pool) {
  const myZoneId = await resolveUserZoneId(user);
  if (myZoneId === null) return true;
  const r = await client.query('SELECT zone_id FROM employees WHERE id = $1', [employeeId]);
  if (r.rows.length === 0) return false;
  return r.rows[0].zone_id === myZoneId;
}

// GET / — list, zone-scoped. Spec §19/§13.
router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const params = [];
    const filters = [];
    if (myZoneId !== null) { params.push(myZoneId); filters.push(`e.zone_id = $${params.length}`); }
    if (req.query.employee_id) {
      const eid = parseStrictId(req.query.employee_id);
      if (eid === null) return res.status(400).json({ error: { message: 'Invalid employee_id.', code: 'VALIDATION' } });
      params.push(eid); filters.push(`lr.employee_id = $${params.length}`);
    }
    if (req.query.leave_type_id) {
      const ltid = parseStrictId(req.query.leave_type_id);
      if (ltid === null) return res.status(400).json({ error: { message: 'Invalid leave_type_id.', code: 'VALIDATION' } });
      params.push(ltid); filters.push(`lr.leave_type_id = $${params.length}`);
    }
    if (req.query.status) { params.push(req.query.status); filters.push(`lr.status = $${params.length}`); }
    if (req.query.date_from) { params.push(req.query.date_from); filters.push(`lr.end_date >= $${params.length}`); }
    if (req.query.date_to) { params.push(req.query.date_to); filters.push(`lr.start_date <= $${params.length}`); }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT lr.*, e.name AS employee_name, e.zone_id, lt.label AS leave_type_label
       FROM leave_requests lr
       JOIN employees e ON lr.employee_id = e.id
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       ${whereSql} ORDER BY lr.created_at DESC`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list leave requests.', code: 'INTERNAL' } });
  }
});

// GET /me — own-record. Spec §15.
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const myEmployeeId = await resolveEmployeeIdForRequestUser(req.user);
    if (myEmployeeId === null) return res.status(403).json({ error: { message: 'No employee record is linked to your account.', code: 'FORBIDDEN' } });
    const result = await pool.query(
      `SELECT lr.*, lt.label AS leave_type_label FROM leave_requests lr
       JOIN leave_types lt ON lr.leave_type_id = lt.id
       WHERE lr.employee_id = $1 ORDER BY lr.created_at DESC`,
      [myEmployeeId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load leave requests.', code: 'INTERNAL' } });
  }
});

async function createLeaveRequest({ employeeId, leaveTypeId, startDate, endDate, reason, createdBy }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock any existing overlapping requests for this employee first —
    // Spec §1.3/§21, same deterministic-lock-then-check pattern payments.js
    // already uses for invoices.
    const overlap = await client.query(
      `SELECT id FROM leave_requests WHERE employee_id = $1 AND status IN ('pending','approved')
       AND NOT (end_date < $2 OR start_date > $3) FOR UPDATE`,
      [employeeId, startDate, endDate]
    );
    if (overlap.rows.length > 0) {
      await client.query('ROLLBACK');
      return { conflict: true };
    }
    const inserted = await client.query(
      `INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [employeeId, leaveTypeId, startDate, endDate, reason || null, createdBy]
    );
    await client.query('COMMIT');
    return { record: inserted.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// POST / — staff creating on behalf of an employee (admin/gudoomiye).
router.post('/', authenticateToken, requireRole(...APPROVE_ROLES), async (req, res) => {
  const { employee_id, leave_type_id, start_date, end_date, reason } = req.body;
  const empId = parseStrictId(employee_id);
  const typeId = parseStrictId(leave_type_id);
  if (empId === null) return res.status(400).json({ error: { message: 'employee_id is required.', code: 'VALIDATION' } });
  if (typeId === null) return res.status(400).json({ error: { message: 'leave_type_id is required.', code: 'VALIDATION' } });
  if (!start_date || !end_date) return res.status(400).json({ error: { message: 'start_date and end_date are required.', code: 'VALIDATION' } });
  if (new Date(end_date) < new Date(start_date)) return res.status(400).json({ error: { message: 'end_date must not be before start_date.', code: 'VALIDATION' } });
  try {
    const inScope = await assertEmployeeInScope(req.user, empId);
    if (!inScope) return res.status(403).json({ error: { message: 'You cannot file leave for an employee outside your zone.', code: 'FORBIDDEN' } });
    const result = await createLeaveRequest({ employeeId: empId, leaveTypeId: typeId, startDate: start_date, endDate: end_date, reason, createdBy: req.user.id });
    if (result.conflict) return res.status(409).json({ error: { message: 'This employee already has an overlapping leave request.', code: 'CONFLICT' } });
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'leave_request.create', entityType: 'leave_request', entityId: result.record.id, before: null, after: result.record });
    res.status(201).json({ data: result.record });
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: { message: 'Invalid leave_type_id.', code: 'VALIDATION' } });
    res.status(500).json({ error: { message: 'Failed to create leave request.', code: 'INTERNAL' } });
  }
});

// POST /me — employee self-service filing.
router.post('/me', authenticateToken, async (req, res) => {
  const { leave_type_id, start_date, end_date, reason } = req.body;
  const typeId = parseStrictId(leave_type_id);
  if (typeId === null) return res.status(400).json({ error: { message: 'leave_type_id is required.', code: 'VALIDATION' } });
  if (!start_date || !end_date) return res.status(400).json({ error: { message: 'start_date and end_date are required.', code: 'VALIDATION' } });
  if (new Date(end_date) < new Date(start_date)) return res.status(400).json({ error: { message: 'end_date must not be before start_date.', code: 'VALIDATION' } });
  try {
    const myEmployeeId = await resolveEmployeeIdForRequestUser(req.user);
    if (myEmployeeId === null) return res.status(403).json({ error: { message: 'No employee record is linked to your account.', code: 'FORBIDDEN' } });
    const result = await createLeaveRequest({ employeeId: myEmployeeId, leaveTypeId: typeId, startDate: start_date, endDate: end_date, reason, createdBy: req.user.id });
    if (result.conflict) return res.status(409).json({ error: { message: 'You already have an overlapping leave request.', code: 'CONFLICT' } });
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'leave_request.create', entityType: 'leave_request', entityId: result.record.id, before: null, after: result.record });
    res.status(201).json({ data: result.record });
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: { message: 'Invalid leave_type_id.', code: 'VALIDATION' } });
    res.status(500).json({ error: { message: 'Failed to create leave request.', code: 'INTERNAL' } });
  }
});

// PUT /:id/status — approve/reject. Spec §4.
router.put('/:id/status', authenticateToken, requireRole(...APPROVE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid leave request id.', code: 'VALIDATION' } });
  const { status } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: { message: "status must be 'approved' or 'rejected'.", code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM leave_requests WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Leave request not found.', code: 'NOT_FOUND' } });
    if (before.rows[0].status !== 'pending') return res.status(409).json({ error: { message: `Leave request is already ${before.rows[0].status}.`, code: 'CONFLICT' } });
    const inScope = await assertEmployeeInScope(req.user, before.rows[0].employee_id);
    if (!inScope) return res.status(403).json({ error: { message: 'You cannot act on leave for an employee outside your zone.', code: 'FORBIDDEN' } });
    // Phase 7 Approval Engine Discovery/Decisions — Future CR promoted to
    // in-scope: self-approval prevention, mirroring the exact pattern
    // already proven in Procurement and Inventory Adjustments. The ONE
    // explicitly-authorized narrow addition to this route.
    const myEmployeeIdForApproval = await resolveEmployeeIdForRequestUser(req.user);
    if (myEmployeeIdForApproval !== null && myEmployeeIdForApproval === before.rows[0].employee_id) {
      return res.status(403).json({ error: { message: 'You cannot approve or reject your own leave request.', code: 'FORBIDDEN' } });
    }

    const updated = await pool.query(
      `UPDATE leave_requests SET status = $1, approved_by = $2, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [status, req.user.id, id]
    );
    const record = updated.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: `leave_request.${status}`, entityType: 'leave_request', entityId: record.id, before: before.rows[0], after: record });
    res.json({ data: record });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update leave request.', code: 'INTERNAL' } });
  }
});

// PUT /:id/cancel — Spec §4: admin/gudoomiye any approved request;
// the employee themselves only their own still-pending request.
router.put('/:id/cancel', authenticateToken, async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid leave request id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'A reason is required to cancel a leave request.', code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM leave_requests WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Leave request not found.', code: 'NOT_FOUND' } });
    const record = before.rows[0];
    if (!['pending', 'approved'].includes(record.status)) {
      return res.status(409).json({ error: { message: `Leave request is already ${record.status}.`, code: 'CONFLICT' } });
    }

    const role = (req.user.role || '').toLowerCase();
    const isStaffApprover = APPROVE_ROLES.includes(role);
    if (isStaffApprover) {
      const inScope = await assertEmployeeInScope(req.user, record.employee_id);
      if (!inScope) return res.status(403).json({ error: { message: 'You cannot cancel leave for an employee outside your zone.', code: 'FORBIDDEN' } });
    } else {
      const myEmployeeId = await resolveEmployeeIdForRequestUser(req.user);
      if (myEmployeeId === null || myEmployeeId !== record.employee_id) {
        return res.status(403).json({ error: { message: 'You can only cancel your own leave request.', code: 'FORBIDDEN' } });
      }
      if (record.status !== 'pending') {
        return res.status(403).json({ error: { message: 'You can only cancel your own still-pending request.', code: 'FORBIDDEN' } });
      }
    }

    const updated = await pool.query(
      `UPDATE leave_requests SET status = 'cancelled', cancelled_by = $1, cancelled_at = CURRENT_TIMESTAMP,
         cancellation_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [req.user.id, reason, id]
    );
    const updatedRecord = updated.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'leave_request.cancel', entityType: 'leave_request', entityId: updatedRecord.id, before: record, after: updatedRecord });
    res.json({ data: updatedRecord });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to cancel leave request.', code: 'INTERNAL' } });
  }
});

module.exports = router;
