const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

// General staff Todo/Task tracker (user-requested, disambiguated in
// conversation from the Collection Cycles/Batches 'tasks' table — a
// scheduled collection-route stop, a completely different concept). This
// is a standalone assign-and-track work item: a manager gives a staff
// member something to do, with a due date/priority/status, independent
// of any batch or collection cycle.

const router = express.Router();
const MANAGER_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'];
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const STATUSES = ['pending', 'in_progress', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];

function parseStrictId(raw) {
  if (!/^\d+$/.test(String(raw ?? ''))) return null;
  return parseInt(raw, 10);
}

async function resolveUserZoneId(user, client = pool) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await client.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

const SELECT_TASK = `
  SELECT st.*, e.name AS assigned_to_name, e.zone_id AS assigned_to_zone_id,
         u.username AS created_by_username
  FROM staff_tasks st
  LEFT JOIN employees e ON e.id = st.assigned_to_employee_id
  LEFT JOIN v2_users u ON u.id = st.created_by_user_id
`;

// ==================================================================
// MY TASKS — self-service, every authenticated staff member with a
// linked employee record, no role restriction (Account Security/My HR's
// own precedent).
// ==================================================================
router.get('/my', authenticateToken, async (req, res) => {
  if (!req.user.employeeId) return res.json({ data: [] });
  try {
    const r = await pool.query(`${SELECT_TASK} WHERE st.assigned_to_employee_id = $1 ORDER BY st.due_date NULLS LAST, st.created_at DESC`, [req.user.employeeId]);
    return res.json({ data: r.rows });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load your tasks.', code: 'INTERNAL' } });
  }
});

// A staff member updating the status of their OWN task — no manager role
// required, but only for a task actually assigned to them.
router.put('/my/:id/status', authenticateToken, async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'Task not found.', code: 'NOT_FOUND' } });
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: { message: `status must be one of: ${STATUSES.join(', ')}.`, code: 'VALIDATION' } });
  try {
    const r = await pool.query(
      `UPDATE staff_tasks SET status = $1, updated_at = NOW() WHERE id = $2 AND assigned_to_employee_id = $3 RETURNING id`,
      [status, id, req.user.employeeId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Task not found.', code: 'NOT_FOUND' } });
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'status_change', entityType: 'staff_task', entityId: id, after: { status } });
    return res.json({ data: { id, status } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to update task status.', code: 'INTERNAL' } });
  }
});

// ==================================================================
// MANAGER VIEW — see/assign/edit every task in scope (zone-scoped for
// gudoomiye/zone_accountant, same pattern as leaveRequests.js).
// ==================================================================
router.get('/', authenticateToken, requireRole(...MANAGER_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const params = [];
    const filters = [];
    if (myZoneId !== null) { params.push(myZoneId); filters.push(`e.zone_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); filters.push(`st.status = $${params.length}`); }
    if (req.query.assigned_to_employee_id) {
      const eid = parseStrictId(req.query.assigned_to_employee_id);
      if (eid === null) return res.status(400).json({ error: { message: 'Invalid assigned_to_employee_id.', code: 'VALIDATION' } });
      params.push(eid); filters.push(`st.assigned_to_employee_id = $${params.length}`);
    }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const r = await pool.query(`${SELECT_TASK} ${whereSql} ORDER BY st.due_date NULLS LAST, st.created_at DESC`, params);
    return res.json({ data: r.rows });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to load tasks.', code: 'INTERNAL' } });
  }
});

router.post('/', authenticateToken, requireRole(...MANAGER_ROLES), async (req, res) => {
  const { title, description, assigned_to_employee_id, priority, due_date } = req.body || {};
  const errors = [];
  if (typeof title !== 'string' || !title.trim()) errors.push('title is required.');
  let employeeIdNum = null;
  if (assigned_to_employee_id !== undefined && assigned_to_employee_id !== null) {
    employeeIdNum = parseStrictId(assigned_to_employee_id);
    if (employeeIdNum === null) errors.push('assigned_to_employee_id must be a positive integer or null.');
  }
  const finalPriority = priority || 'medium';
  if (!PRIORITIES.includes(finalPriority)) errors.push(`priority must be one of: ${PRIORITIES.join(', ')}.`);
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });

  try {
    if (employeeIdNum !== null) {
      const inScope = await assertEmployeeInScope(req.user, employeeIdNum);
      if (!inScope) return res.status(400).json({ error: { message: 'That employee is outside your zone.', code: 'VALIDATION' } });
    }
    const ins = await pool.query(
      `INSERT INTO staff_tasks (title, description, assigned_to_employee_id, created_by_user_id, priority, due_date)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [title.trim(), description || null, employeeIdNum, req.user.id, finalPriority, due_date || null]
    );
    const taskId = ins.rows[0].id;

    // Best-effort notification to the assignee's own linked login, if any
    // (v2_staff_notifications' own existing shape — staffNotifications.js).
    if (employeeIdNum !== null) {
      const linkedUser = await pool.query('SELECT user_id FROM employees WHERE id = $1', [employeeIdNum]);
      const recipientId = linkedUser.rows[0]?.user_id;
      if (recipientId) {
        await pool.query(
          `INSERT INTO v2_staff_notifications (recipient_id, event_type, title, body, entity_type, entity_id)
           VALUES ($1, 'task.assigned', $2, $3, 'staff_task', $4)`,
          [recipientId, 'New task assigned', title.trim(), taskId]
        );
      }
    }

    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'create', entityType: 'staff_task', entityId: taskId, after: { title, assigned_to_employee_id: employeeIdNum } });
    const full = await pool.query(`${SELECT_TASK} WHERE st.id = $1`, [taskId]);
    return res.status(201).json({ data: full.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to create task.', code: 'INTERNAL' } });
  }
});

async function assertEmployeeInScope(user, employeeId, client = pool) {
  const myZoneId = await resolveUserZoneId(user, client);
  if (myZoneId === null) return true;
  const r = await client.query('SELECT zone_id FROM employees WHERE id = $1', [employeeId]);
  if (r.rows.length === 0) return false;
  return r.rows[0].zone_id === myZoneId;
}

router.put('/:id', authenticateToken, requireRole(...MANAGER_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'Task not found.', code: 'NOT_FOUND' } });
  const { title, description, assigned_to_employee_id, status, priority, due_date } = req.body || {};
  try {
    const before = await pool.query('SELECT * FROM staff_tasks WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Task not found.', code: 'NOT_FOUND' } });
    const prev = before.rows[0];

    if (status !== undefined && !STATUSES.includes(status)) {
      return res.status(400).json({ error: { message: `status must be one of: ${STATUSES.join(', ')}.`, code: 'VALIDATION' } });
    }
    if (priority !== undefined && !PRIORITIES.includes(priority)) {
      return res.status(400).json({ error: { message: `priority must be one of: ${PRIORITIES.join(', ')}.`, code: 'VALIDATION' } });
    }
    let nextEmployeeId = prev.assigned_to_employee_id;
    if (assigned_to_employee_id !== undefined) {
      nextEmployeeId = assigned_to_employee_id === null ? null : parseStrictId(assigned_to_employee_id);
      if (assigned_to_employee_id !== null && nextEmployeeId === null) {
        return res.status(400).json({ error: { message: 'assigned_to_employee_id must be a positive integer or null.', code: 'VALIDATION' } });
      }
      if (nextEmployeeId !== null) {
        const inScope = await assertEmployeeInScope(req.user, nextEmployeeId);
        if (!inScope) return res.status(400).json({ error: { message: 'That employee is outside your zone.', code: 'VALIDATION' } });
      }
    }

    const r = await pool.query(
      `UPDATE staff_tasks SET title = $1, description = $2, assigned_to_employee_id = $3, status = $4, priority = $5, due_date = $6, updated_at = NOW()
       WHERE id = $7 RETURNING id`,
      [
        title !== undefined ? title.trim() : prev.title,
        description !== undefined ? description : prev.description,
        nextEmployeeId,
        status !== undefined ? status : prev.status,
        priority !== undefined ? priority : prev.priority,
        due_date !== undefined ? due_date : prev.due_date,
        id,
      ]
    );
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'update', entityType: 'staff_task', entityId: id, before: prev, after: req.body });
    const full = await pool.query(`${SELECT_TASK} WHERE st.id = $1`, [r.rows[0].id]);
    return res.json({ data: full.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to update task.', code: 'INTERNAL' } });
  }
});

router.delete('/:id', authenticateToken, requireRole(...MANAGER_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json({ error: { message: 'Task not found.', code: 'NOT_FOUND' } });
  try {
    const r = await pool.query('DELETE FROM staff_tasks WHERE id = $1 RETURNING *', [id]);
    if (r.rows.length === 0) return res.status(404).json({ error: { message: 'Task not found.', code: 'NOT_FOUND' } });
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'delete', entityType: 'staff_task', entityId: id, before: r.rows[0] });
    return res.json({ data: { message: 'Task deleted.' } });
  } catch (err) {
    return res.status(500).json({ error: { message: 'Failed to delete task.', code: 'INTERNAL' } });
  }
});

module.exports = router;
