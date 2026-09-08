const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { resolveEmployeeIdForRequestUser } = require('../lib/hrCalculations');

const router = express.Router();

// Phase 1 HR & Payroll — Spec §3/§13. Same zone-scope pattern as every
// other V2 module.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant'];
const WRITE_ROLES = ['admin', 'gudoomiye'];
const VALID_STATUSES = ['present', 'absent', 'late', 'on_leave', 'half_day'];

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

// A Gudoomiye may only mark/correct attendance for employees in their
// own zone — verified against the live employees table, never trusted
// from the request body.
async function assertEmployeeInScope(user, employeeId) {
  const myZoneId = await resolveUserZoneId(user);
  if (myZoneId === null) return true; // admin, company-wide
  const r = await pool.query('SELECT zone_id FROM employees WHERE id = $1', [employeeId]);
  if (r.rows.length === 0) return false;
  return r.rows[0].zone_id === myZoneId;
}

// GET / — list, zone-scoped, filterable. Spec §19.
router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    // Latest row per (employee_id, attendance_date) via DISTINCT ON —
    // returns a correction if one exists, else the original (Spec §3).
    const params = [];
    const filters = [];
    if (myZoneId !== null) { params.push(myZoneId); filters.push(`e.zone_id = $${params.length}`); }
    if (req.query.employee_id) {
      const eid = parseStrictId(req.query.employee_id);
      if (eid === null) return res.status(400).json({ error: { message: 'Invalid employee_id.', code: 'VALIDATION' } });
      params.push(eid); filters.push(`ar.employee_id = $${params.length}`);
    }
    if (req.query.status && VALID_STATUSES.includes(req.query.status)) {
      params.push(req.query.status); filters.push(`ar.status = $${params.length}`);
    }
    if (req.query.date_from) { params.push(req.query.date_from); filters.push(`ar.attendance_date >= $${params.length}`); }
    if (req.query.date_to) { params.push(req.query.date_to); filters.push(`ar.attendance_date <= $${params.length}`); }
    const whereSql = filters.length ? `AND ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT DISTINCT ON (ar.employee_id, ar.attendance_date) ar.*, e.name AS employee_name, e.zone_id
       FROM attendance_records ar JOIN employees e ON ar.employee_id = e.id
       WHERE TRUE ${whereSql}
       ORDER BY ar.employee_id, ar.attendance_date DESC, ar.id DESC`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list attendance.', code: 'INTERNAL' } });
  }
});

// GET /me — own-record only. Spec §15/§17.
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const myEmployeeId = await resolveEmployeeIdForRequestUser(req.user);
    if (myEmployeeId === null) return res.status(403).json({ error: { message: 'No employee record is linked to your account.', code: 'FORBIDDEN' } });
    const result = await pool.query(
      `SELECT DISTINCT ON (attendance_date) * FROM attendance_records
       WHERE employee_id = $1 ORDER BY attendance_date DESC, id DESC LIMIT 100`,
      [myEmployeeId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load attendance.', code: 'INTERNAL' } });
  }
});

// POST / — mark attendance. Spec §3.
router.post('/', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const { employee_id, attendance_date, status, clock_in, clock_out, notes } = req.body;
  const empId = parseStrictId(employee_id);
  if (empId === null) return res.status(400).json({ error: { message: 'employee_id is required.', code: 'VALIDATION' } });
  if (!attendance_date) return res.status(400).json({ error: { message: 'attendance_date is required.', code: 'VALIDATION' } });
  const st = status && VALID_STATUSES.includes(status) ? status : 'present';

  try {
    const inScope = await assertEmployeeInScope(req.user, empId);
    if (!inScope) return res.status(403).json({ error: { message: 'You cannot mark attendance for an employee outside your zone.', code: 'FORBIDDEN' } });

    const inserted = await pool.query(
      `INSERT INTO attendance_records (employee_id, attendance_date, status, clock_in, clock_out, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [empId, attendance_date, st, clock_in || null, clock_out || null, notes || null, req.user.id]
    );
    const record = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'attendance.create', entityType: 'attendance_record', entityId: record.id, before: null, after: record });
    res.status(201).json({ data: record });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'Attendance for this employee on this date already exists.', code: 'CONFLICT' } });
    res.status(500).json({ error: { message: 'Failed to create attendance record.', code: 'INTERNAL' } });
  }
});

// POST /:id/correct — creates a new row, original untouched. Spec §3/§5.
router.post('/:id/correct', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid attendance id.', code: 'VALIDATION' } });
  const { status, clock_in, clock_out, notes, correction_reason } = req.body;
  const reason = (correction_reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'correction_reason is required.', code: 'VALIDATION' } });

  try {
    const origRes = await pool.query('SELECT * FROM attendance_records WHERE id = $1', [id]);
    if (origRes.rows.length === 0) return res.status(404).json({ error: { message: 'Attendance record not found.', code: 'NOT_FOUND' } });
    const original = origRes.rows[0];

    const inScope = await assertEmployeeInScope(req.user, original.employee_id);
    if (!inScope) return res.status(403).json({ error: { message: 'You cannot correct attendance outside your zone.', code: 'FORBIDDEN' } });

    const st = status && VALID_STATUSES.includes(status) ? status : original.status;
    const inserted = await pool.query(
      `INSERT INTO attendance_records
         (employee_id, attendance_date, status, clock_in, clock_out, notes, corrected_from_id, correction_reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [original.employee_id, original.attendance_date, st,
       clock_in !== undefined ? clock_in : original.clock_in,
       clock_out !== undefined ? clock_out : original.clock_out,
       notes !== undefined ? notes : original.notes,
       original.id, reason, req.user.id]
    );
    const correction = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'attendance.correct', entityType: 'attendance_record', entityId: correction.id, before: original, after: correction });
    res.status(201).json({ data: correction });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to correct attendance record.', code: 'INTERNAL' } });
  }
});

module.exports = router;
