const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
// Phase 1 HR & Payroll — the ONE permitted additive change to this
// CLOSED/FROZEN file (GET /:id/effective-status only). No existing
// route, schema, or write behavior below this import is touched.
const { getEffectiveEmployeeStatus, resolveEmployeeIdForRequestUser } = require('../lib/hrCalculations');

const router = express.Router();

// Widened per user request (Phase 10) — 'cashier'/'head_of_cashiers' added
// alongside the DB constraint's own matching widening (db.js's
// employees_employee_type_check). Both values already existed as login
// roles (middleware/auth.js) with no employee_type counterpart before this.
const VALID_EMPLOYEE_TYPES = ['collector', 'driver', 'office', 'cashier', 'head_of_cashiers', 'other'];
const VALID_COLLECTOR_TYPES = ['residential', 'commercial'];
const VALID_SHIFTS = ['day', 'night'];
const VALID_STATUSES = ['active', 'on_leave', 'suspended', 'archived'];

// OD-3: Employee master list/detail access is Admin, Gudoomiye, Zone
// Accountant only — cashier/collector must not browse the staff directory.
// A materially narrower list than Customers/Zones (both viewable by any
// staff role) — deliberate, per your explicit decision.
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant'];
const WRITE_ROLES = ['admin', 'gudoomiye'];
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];

// Fields available to every viewer role. Salary is included for
// zone_accountant (a financial role — this is financial data, relevant to
// their function) but guarantor/ID-document/photo are HR-sensitive, not
// financial, and are withheld from zone_accountant specifically. Admin and
// Gudoomiye get every field. This is a reasonable interim field-level
// design, not explicitly itemized in the approved decision — flagged for
// review in the Module 3 completion report, not silently assumed as final.
const BASE_FIELDS = [
  'id', 'name', 'job_role', 'employee_type', 'collector_type', 'commercial_shift',
  'phone', 'zone_id', 'status', 'salary', 'join_date', 'user_id', 'created_at', 'updated_at',
];
const SENSITIVE_FIELDS = ['photo', 'id_document', 'guarantor_name', 'guarantor_phone', 'notes'];

function fieldsForRole(role) {
  const r = (role || '').toLowerCase();
  if (r === 'admin' || r === 'gudoomiye') return [...BASE_FIELDS, ...SENSITIVE_FIELDS];
  return BASE_FIELDS; // zone_accountant
}

function parseStrictId(raw) {
  if (!/^\d+$/.test(raw)) return null;
  return parseInt(raw, 10);
}

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

function pickFields(row, fields) {
  const out = {};
  for (const f of fields) out[f] = row[f];
  return out;
}

function validateEmployeeInput(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 100) {
      errors.push('name is required and must be 1-100 characters.');
    } else {
      out.name = body.name.trim();
    }
  }
  if (!partial || body.phone !== undefined) {
    if (typeof body.phone !== 'string' || body.phone.trim().length < 3 || body.phone.trim().length > 20) {
      errors.push('phone is required and must be 3-20 characters.');
    } else {
      out.phone = body.phone.trim();
    }
  }
  if (!partial || body.employee_type !== undefined) {
    if (!VALID_EMPLOYEE_TYPES.includes(body.employee_type)) {
      errors.push(`employee_type must be one of: ${VALID_EMPLOYEE_TYPES.join(', ')}.`);
    } else {
      out.employee_type = body.employee_type;
    }
  }

  // OD-1: zone_id is required ONLY when employee_type is collector. Office/
  // driver/other employees may have a null zone.
  const effectiveType = out.employee_type || (partial ? undefined : body.employee_type);
  if (effectiveType === 'collector') {
    const zoneId = parseStrictId(String(body.zone_id ?? ''));
    if (zoneId === null) {
      errors.push('zone_id is required for collectors.');
    } else {
      out.zone_id = zoneId;
    }
  } else if (body.zone_id !== undefined) {
    if (body.zone_id === null) {
      out.zone_id = null;
    } else {
      const zoneId = parseStrictId(String(body.zone_id));
      if (zoneId === null) errors.push('zone_id must be a valid zone or null.');
      else out.zone_id = zoneId;
    }
  }

  // collector_type / commercial_shift — DR-7 fields, only meaningful for
  // collectors. Validated whenever provided, not silently accepted for a
  // non-collector employee_type.
  if (body.collector_type !== undefined) {
    if (body.collector_type !== null && !VALID_COLLECTOR_TYPES.includes(body.collector_type)) {
      errors.push(`collector_type must be one of: ${VALID_COLLECTOR_TYPES.join(', ')}, or null.`);
    } else if (body.collector_type !== null && effectiveType !== 'collector' && effectiveType !== undefined) {
      errors.push('collector_type may only be set for employee_type "collector".');
    } else {
      out.collector_type = body.collector_type;
    }
  }
  const effectiveCollectorType = out.collector_type !== undefined ? out.collector_type : (partial ? undefined : body.collector_type);
  if (body.commercial_shift !== undefined) {
    if (body.commercial_shift !== null && !VALID_SHIFTS.includes(body.commercial_shift)) {
      errors.push(`commercial_shift must be one of: ${VALID_SHIFTS.join(', ')}, or null.`);
    } else if (body.commercial_shift !== null && effectiveCollectorType !== 'commercial' && effectiveCollectorType !== undefined) {
      errors.push('commercial_shift may only be set when collector_type is "commercial".');
    } else {
      out.commercial_shift = body.commercial_shift;
    }
  }

  if (body.job_role !== undefined) out.job_role = body.job_role ? String(body.job_role).trim().slice(0, 100) : null;
  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) {
      errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}.`);
    } else {
      out.status = body.status;
    }
  }
  if (body.salary !== undefined) {
    if (body.salary !== null && (typeof body.salary !== 'number' || body.salary < 0)) {
      errors.push('salary must be a non-negative number.');
    } else {
      out.salary = body.salary;
    }
  }
  if (body.join_date !== undefined) {
    if (body.join_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.join_date)) {
      errors.push('join_date must be YYYY-MM-DD or null.');
    } else {
      out.join_date = body.join_date;
    }
  }
  if (body.guarantor_name !== undefined) out.guarantor_name = body.guarantor_name ? String(body.guarantor_name).trim().slice(0, 100) : null;
  if (body.guarantor_phone !== undefined) out.guarantor_phone = body.guarantor_phone ? String(body.guarantor_phone).trim().slice(0, 20) : null;
  if (body.notes !== undefined) {
    const notes = body.notes ? String(body.notes) : '';
    if (notes.length > 2000) errors.push('notes must be 2000 characters or fewer.');
    else out.notes = notes || null;
  }

  // user_id — OD-2, hardening pass: this is an APPLICATION-LEVEL identity
  // reference, not a database-enforced foreign key. `users` lives in the
  // reference T2.8-F backend's own separate database (a deliberate
  // Foundation-phase decision — see db.js's migration comment); Postgres
  // cannot enforce a cross-database FK, so nothing here — and nothing any
  // API response returns — should be read as a guarantee that this integer
  // corresponds to a real row in `users`. Only format (positive integer)
  // and this database's own one-to-one uniqueness are actually verified.
  // Existence-checking against the real users table is out of scope for
  // this checkpoint (would require either a new cross-service call or
  // database consolidation — both explicitly deferred per your review).
  if (body.user_id !== undefined) {
    if (body.user_id === null) {
      out.user_id = null;
    } else {
      const uid = parseStrictId(String(body.user_id));
      if (uid === null) errors.push('user_id must be a positive integer or null.');
      else out.user_id = uid;
    }
  }

  return { errors, data: out };
}

async function assertZoneWritable(user, zoneId) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return true;
  if (zoneId === null || zoneId === undefined) return true; // non-collector, no zone to check
  const myZoneId = await resolveUserZoneId(user);
  return myZoneId !== null && myZoneId === zoneId;
}

router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const where = [];
    const params = [];
    if (myZoneId !== null) {
      // Module 3 regression correction, discovered during Module 4 (Trucks
      // had the identical pattern, found and fixed first): a strict
      // `zone_id = $1` silently hid every null-zone (company-wide/office)
      // employee from a zone-scoped viewer's list, inconsistent with the
      // detail route just below, which already treats a null zone_id as
      // visible. Real bug, not intentional — a gudoomiye could reach such
      // an employee by direct id but never discover them via the list.
      params.push(myZoneId);
      where.push(`(employees.zone_id = $${params.length} OR employees.zone_id IS NULL)`);
    }
    const status = req.query.status;
    if (status === 'archived') where.push(`employees.status = 'archived'`);
    else if (status === 'all') { /* no filter */ }
    else where.push(`employees.status != 'archived'`);

    if (req.query.employee_type) {
      if (!VALID_EMPLOYEE_TYPES.includes(req.query.employee_type)) {
        return res.status(400).json({ error: { message: 'Invalid employee_type filter.', code: 'VALIDATION' } });
      }
      params.push(req.query.employee_type);
      where.push(`employees.employee_type = $${params.length}`);
    }
    if (req.query.zone_id) {
      const zid = parseStrictId(req.query.zone_id);
      if (zid === null) return res.status(400).json({ error: { message: 'Invalid zone_id filter.', code: 'VALIDATION' } });
      if (myZoneId !== null && zid !== myZoneId) {
        return res.status(403).json({ error: { message: 'You do not have access to that zone.', code: 'FORBIDDEN' } });
      }
      params.push(zid);
      where.push(`employees.zone_id = $${params.length}`);
    }
    if (req.query.q) {
      params.push(`%${req.query.q.trim()}%`);
      const i = params.length;
      where.push(`(employees.name ILIKE $${i} OR employees.phone ILIKE $${i} OR employees.job_role ILIKE $${i})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM employees ${whereSql}`, params);
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT employees.*, zones.name AS zone_name FROM employees LEFT JOIN zones ON employees.zone_id = zones.id
       ${whereSql} ORDER BY employees.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const fields = [...fieldsForRole(req.user.role), 'zone_name'];
    res.json({ data: result.rows.map((r) => pickFields(r, fields)), meta: { total: countResult.rows[0].total, limit, offset } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list employees.', code: 'INTERNAL' } });
  }
});

router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid employee id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query(
      'SELECT employees.*, zones.name AS zone_name FROM employees LEFT JOIN zones ON employees.zone_id = zones.id WHERE employees.id = $1',
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Employee not found.', code: 'NOT_FOUND' } });

    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && result.rows[0].zone_id !== null && result.rows[0].zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this employee.', code: 'FORBIDDEN' } });
    }
    // A zone-scoped viewer with a null-zone employee (e.g. an office role)
    // in view is a policy question outside OD-1/OD-3's scope — allowed
    // through rather than silently blocked, since OD-1 explicitly permits
    // null-zone employees to exist and no decision restricts who can see
    // them once visible in an unfiltered list.
    res.json({ data: pickFields(result.rows[0], [...fieldsForRole(req.user.role), 'zone_name']) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load employee.', code: 'INTERNAL' } });
  }
});

// GET /:id/effective-status — Phase 1 HR & Payroll, Spec §5. Purely
// additive: reads existing data via getEffectiveEmployeeStatus(), writes
// nothing, does not alter any other route's behavior. Admin/Gudoomiye/
// Zone Accountant (own-zone) or the employee themselves (own record).
router.get('/:id/effective-status', authenticateToken, async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid employee id.', code: 'VALIDATION' } });
  try {
    const empRes = await pool.query('SELECT id, zone_id, user_id FROM employees WHERE id = $1', [id]);
    if (empRes.rows.length === 0) return res.status(404).json({ error: { message: 'Employee not found.', code: 'NOT_FOUND' } });
    const employee = empRes.rows[0];

    const role = (req.user.role || '').toLowerCase();
    const isStaffViewer = VIEW_ROLES.includes(role);
    let authorized = false;
    if (isStaffViewer) {
      const myZoneId = await resolveUserZoneId(req.user);
      authorized = myZoneId === null || employee.zone_id === myZoneId;
    } else {
      const myEmployeeId = await resolveEmployeeIdForRequestUser(req.user);
      authorized = myEmployeeId !== null && myEmployeeId === id;
    }
    if (!authorized) return res.status(403).json({ error: { message: 'You do not have access to this employee.', code: 'FORBIDDEN' } });

    const effectiveStatus = await getEffectiveEmployeeStatus(id);
    res.json({ data: { employee_id: id, effective_status: effectiveStatus } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load effective status.', code: 'INTERNAL' } });
  }
});

router.post('/', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const { errors, data } = validateEmployeeInput(req.body, { partial: false });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });

  if (!(await assertZoneWritable(req.user, data.zone_id ?? null))) {
    return res.status(403).json({ error: { message: 'You cannot create an employee outside your assigned zone.', code: 'FORBIDDEN' } });
  }

  try {
    const result = await pool.query(
      `INSERT INTO employees
        (name, job_role, employee_type, collector_type, commercial_shift, phone, zone_id, status,
         salary, join_date, guarantor_name, guarantor_phone, notes, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'active'),$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [data.name, data.job_role ?? null, data.employee_type, data.collector_type ?? null, data.commercial_shift ?? null,
       data.phone, data.zone_id ?? null, data.status ?? null, data.salary ?? null, data.join_date ?? null,
       data.guarantor_name ?? null, data.guarantor_phone ?? null, data.notes ?? null, data.user_id ?? null]
    );
    const employee = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'employee.create', entityType: 'employee', entityId: employee.id, before: null, after: employee });
    res.status(201).json({ data: pickFields(employee, fieldsForRole(req.user.role)) });
  } catch (err) {
    if (err.code === '23505' && String(err.constraint).includes('user_id')) {
      return res.status(409).json({ error: { message: 'This user account is already linked to another employee.', code: 'DUPLICATE' } });
    }
    if (err.code === '23503') {
      return res.status(400).json({ error: { message: 'zone_id does not reference an existing zone.', code: 'VALIDATION' } });
    }
    res.status(500).json({ error: { message: 'Failed to create employee.', code: 'INTERNAL' } });
  }
});

router.put('/:id', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid employee id.', code: 'VALIDATION' } });

  const { errors, data } = validateEmployeeInput(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  if (Object.keys(data).length === 0) return res.status(400).json({ error: { message: 'No valid fields provided to update.', code: 'VALIDATION' } });

  try {
    const existing = await pool.query('SELECT * FROM employees WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: { message: 'Employee not found.', code: 'NOT_FOUND' } });
    const current = existing.rows[0];

    if (!(await assertZoneWritable(req.user, current.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this employee.', code: 'FORBIDDEN' } });
    }
    if (data.zone_id !== undefined && !(await assertZoneWritable(req.user, data.zone_id))) {
      return res.status(403).json({ error: { message: 'You cannot transfer an employee into a zone you do not manage.', code: 'FORBIDDEN' } });
    }
    // If becoming (or already) a collector with no zone_id in this request
    // and none on the existing record, reject — mirrors create-time OD-1.
    const effectiveType = data.employee_type || current.employee_type;
    const effectiveZone = data.zone_id !== undefined ? data.zone_id : current.zone_id;
    if (effectiveType === 'collector' && effectiveZone === null) {
      return res.status(400).json({ error: { message: 'zone_id is required for collectors.', code: 'VALIDATION' } });
    }

    const fields = Object.keys(data);
    const setSql = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = fields.map((f) => data[f]);
    values.push(id);

    const result = await pool.query(
      `UPDATE employees SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`,
      values
    );
    const employee = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'employee.update', entityType: 'employee', entityId: employee.id, before: current, after: employee });
    res.json({ data: pickFields(employee, fieldsForRole(req.user.role)) });
  } catch (err) {
    if (err.code === '23505' && String(err.constraint).includes('user_id')) {
      return res.status(409).json({ error: { message: 'This user account is already linked to another employee.', code: 'DUPLICATE' } });
    }
    if (err.code === '23503') {
      return res.status(400).json({ error: { message: 'zone_id does not reference an existing zone.', code: 'VALIDATION' } });
    }
    res.status(500).json({ error: { message: 'Failed to update employee.', code: 'INTERNAL' } });
  }
});

router.put('/:id/status', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid employee id.', code: 'VALIDATION' } });
  const status = req.body?.status;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: { message: `status must be one of: ${VALID_STATUSES.join(', ')}.`, code: 'VALIDATION' } });
  }
  try {
    const existing = await pool.query('SELECT * FROM employees WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: { message: 'Employee not found.', code: 'NOT_FOUND' } });
    const current = existing.rows[0];
    if (!(await assertZoneWritable(req.user, current.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this employee.', code: 'FORBIDDEN' } });
    }
    const result = await pool.query(
      `UPDATE employees SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [status, id]
    );
    const employee = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'employee.status_change', entityType: 'employee', entityId: employee.id, before: { status: current.status }, after: { status: employee.status } });
    res.json({ data: pickFields(employee, fieldsForRole(req.user.role)) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update employee status.', code: 'INTERNAL' } });
  }
});

// PUT /:id/reschedule-permission — Module 5 final review, added here as a
// small, dedicated, isolated endpoint (not a change to the general
// validateEmployeeInput allowlist) per the explicit instruction: smallest
// isolated authorization mechanism for the Reschedule operation, not a
// global RBAC/permission-catalog migration. Admin-only to grant; the
// permission itself is checked in routes/batches.js's reschedule route.
router.put('/:id/reschedule-permission', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid employee id.', code: 'VALIDATION' } });
  const canCrossZone = req.body?.can_reschedule_cross_zone;
  if (typeof canCrossZone !== 'boolean') {
    return res.status(400).json({ error: { message: 'can_reschedule_cross_zone must be a boolean.', code: 'VALIDATION' } });
  }
  try {
    const existing = await pool.query('SELECT id, can_reschedule_cross_zone FROM employees WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: { message: 'Employee not found.', code: 'NOT_FOUND' } });
    const result = await pool.query(
      `UPDATE employees SET can_reschedule_cross_zone = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, can_reschedule_cross_zone`,
      [canCrossZone, id]
    );
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'employee.reschedule_permission_change', entityType: 'employee', entityId: id, before: existing.rows[0], after: result.rows[0] });
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update reschedule permission.', code: 'INTERNAL' } });
  }
});

// DELETE deliberately not implemented — archive via /:id/status instead,
// per the explicit instruction not to introduce a hard-delete that can
// destroy historical HR data.

module.exports = router;
