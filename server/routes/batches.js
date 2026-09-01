const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { validateResourceAssignment } = require('../lib/collectionValidation');

const router = express.Router();

const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'collector'];
const WRITE_ROLES = ['admin', 'gudoomiye'];
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
// DR-1 precedent, carried forward exactly: per-customer status marking is
// admin + the assigned collector only — gudoomiye keeps every other batch-
// management action but NOT this one. Not widened for V2.
const MARK_STATUS_ROLES = ['admin', 'collector'];
// OD-3, frozen: Reschedule is admin/gudoomiye/zone_accountant. Collector
// and cashier are explicitly forbidden — not merely hidden in the UI.
const RESCHEDULE_ROLES = ['admin', 'gudoomiye', 'zone_accountant'];

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

// OD-2, approved identity chain: User/Auth -> Employee -> Collector/Driver.
// A collector's own identity for ownership checks is resolved via
// employees.user_id (never by name). If no employee record is linked to
// this login, they cannot be recognized as "themselves" for ownership
// purposes — a real, documented consequence of OD-2, not a bug.
async function resolveEmployeeIdForUser(user) {
  const r = await pool.query('SELECT id FROM employees WHERE user_id = $1', [user.id]);
  return r.rows[0]?.id ?? null;
}

async function assertBatchZoneAccess(user, zoneId) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return true;
  const myZoneId = await resolveUserZoneId(user);
  return myZoneId !== null && myZoneId === zoneId;
}

async function generateBatchCode(client, zoneId, cycleId) {
  const numRow = await client.query(`SELECT COALESCE(MAX(batch_number), 0) + 1 AS n FROM batches WHERE zone_id = $1 AND cycle_id = $2`, [zoneId, cycleId]);
  const batchNumber = numRow.rows[0].n;
  return { batchNumber, batchCode: `Z${zoneId}-C${cycleId}-B${batchNumber}` };
}

// ---------- Batches: list / create / detail ----------

router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const where = [];
    const params = [];
    if (myZoneId !== null) {
      params.push(myZoneId);
      where.push(`batches.zone_id = $${params.length}`);
    }
    if (req.query.status) {
      params.push(req.query.status);
      where.push(`batches.status = $${params.length}`);
    }
    if (req.query.zone_id) {
      const zid = parseStrictId(req.query.zone_id);
      if (zid === null) return res.status(400).json({ error: { message: 'Invalid zone_id filter.', code: 'VALIDATION' } });
      if (myZoneId !== null && zid !== myZoneId) return res.status(403).json({ error: { message: 'You do not have access to that zone.', code: 'FORBIDDEN' } });
      params.push(zid);
      where.push(`batches.zone_id = $${params.length}`);
    }
    if (req.query.cycle_id) {
      params.push(parseStrictId(req.query.cycle_id));
      where.push(`batches.cycle_id = $${params.length}`);
    }
    // A collector only ever sees batches they're actually assigned to
    // (via task_resources on a task belonging to the batch) — resolved by
    // employee id, never by name (OD-2).
    if ((req.user.role || '').toLowerCase() === 'collector') {
      const myEmpId = await resolveEmployeeIdForUser(req.user);
      if (myEmpId === null) return res.json({ data: [] });
      params.push(myEmpId);
      where.push(`batches.id IN (
        SELECT t.batch_id FROM tasks t
        JOIN task_resources tr ON tr.task_id = t.id
        WHERE tr.resource_type = 'collector' AND tr.resource_id = $${params.length}
      )`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT batches.*, zones.name AS zone_name, collection_cycles.cycle_type FROM batches
       LEFT JOIN zones ON batches.zone_id = zones.id
       LEFT JOIN collection_cycles ON batches.cycle_id = collection_cycles.id
       ${whereSql} ORDER BY batches.created_at DESC`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list batches.', code: 'INTERNAL' } });
  }
});

router.post('/', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const { zone_id, cycle_id, customer_type, commercial_shift, start_date, end_date, customer_ids, notes } = req.body;
  const zid = parseStrictId(String(zone_id ?? ''));
  const cid = parseStrictId(String(cycle_id ?? ''));
  if (zid === null || cid === null) return res.status(400).json({ error: { message: 'zone_id and cycle_id are required.', code: 'VALIDATION' } });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date || '')) return res.status(400).json({ error: { message: 'start_date is required (YYYY-MM-DD).', code: 'VALIDATION' } });
  const cType = customer_type === 'commercial' ? 'commercial' : 'residential';
  if (cType === 'commercial' && !['day', 'night'].includes(commercial_shift)) {
    return res.status(400).json({ error: { message: 'commercial_shift is required (day or night) for a commercial batch.', code: 'VALIDATION' } });
  }
  const ids = Array.isArray(customer_ids) ? [...new Set(customer_ids)] : [];

  if (!(await assertBatchZoneAccess(req.user, zid))) {
    return res.status(403).json({ error: { message: 'You cannot create a batch outside your assigned zone.', code: 'FORBIDDEN' } });
  }

  try {
    if (ids.length > 0) {
      const conflicts = await pool.query(`SELECT customer_id FROM batch_customers WHERE customer_id = ANY($1::int[]) AND status = 'pending'`, [ids]);
      if (conflicts.rows.length > 0) {
        return res.status(409).json({ error: { message: 'One or more customers are already Pending in another open batch.', code: 'CONFLICT' }, conflicting_customer_ids: conflicts.rows.map((r) => r.customer_id) });
      }
      // DR-7: every customer in a Commercial/Residential batch must match
      // the batch's own classification — a batch is either all-Residential
      // or all-Commercial (DR-7's own approved design).
      const mismatched = await pool.query(`SELECT id FROM customers WHERE id = ANY($1::int[]) AND customer_type != $2`, [ids, cType]);
      if (mismatched.rows.length > 0) {
        return res.status(400).json({ error: { message: `${mismatched.rows.length} customer(s) do not match this batch's customer_type (${cType}).`, code: 'DR7_BLOCK' }, mismatched_customer_ids: mismatched.rows.map((r) => r.id) });
      }
      // Zone integrity (found during Module 5 browser QA, not part of the
      // discovery's original checklist but a real, obvious gap): a
      // customer's own zone must match the batch's zone — collection is
      // inherently zone-local, and nothing about DR-7 alone would have
      // caught a cross-zone customer slipping into a batch.
      const crossZone = await pool.query(`SELECT id FROM customers WHERE id = ANY($1::int[]) AND zone_id != $2`, [ids, zid]);
      if (crossZone.rows.length > 0) {
        return res.status(400).json({ error: { message: `${crossZone.rows.length} customer(s) do not belong to this batch's zone.`, code: 'VALIDATION' }, cross_zone_customer_ids: crossZone.rows.map((r) => r.id) });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { batchNumber, batchCode } = await generateBatchCode(client, zid, cid);
      const inserted = await client.query(
        `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, customer_type, commercial_shift, start_date, end_date, total_customers, status, created_by, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11) RETURNING *`,
        [batchCode, zid, cid, batchNumber, cType, cType === 'commercial' ? commercial_shift : null, start_date, end_date || null, ids.length, req.user.id, notes || null]
      );
      const batch = inserted.rows[0];
      for (const custId of ids) {
        await client.query(`INSERT INTO batch_customers (batch_id, customer_id, status) VALUES ($1, $2, 'pending')`, [batch.id, custId]);
      }
      await client.query('COMMIT');
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'batch.create', entityType: 'batch', entityId: batch.id, before: null, after: batch });
      res.status(201).json({ data: batch });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'Duplicate assignment detected during creation.', code: 'CONFLICT' } });
    if (err.code === '23503') return res.status(400).json({ error: { message: 'zone_id or cycle_id does not reference an existing record.', code: 'VALIDATION' } });
    res.status(500).json({ error: { message: 'Failed to create batch.', code: 'INTERNAL' } });
  }
});

router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid batch id.', code: 'VALIDATION' } });
  try {
    const batchRes = await pool.query(`SELECT batches.*, zones.name AS zone_name FROM batches LEFT JOIN zones ON batches.zone_id = zones.id WHERE batches.id = $1`, [id]);
    if (batchRes.rows.length === 0) return res.status(404).json({ error: { message: 'Batch not found.', code: 'NOT_FOUND' } });
    const batch = batchRes.rows[0];

    if (!(await assertBatchZoneAccess(req.user, batch.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this batch.', code: 'FORBIDDEN' } });
    }
    if ((req.user.role || '').toLowerCase() === 'collector') {
      const myEmpId = await resolveEmployeeIdForUser(req.user);
      const owns = myEmpId !== null && (await pool.query(
        `SELECT 1 FROM tasks t JOIN task_resources tr ON tr.task_id = t.id WHERE t.batch_id = $1 AND tr.resource_type = 'collector' AND tr.resource_id = $2 LIMIT 1`,
        [id, myEmpId]
      )).rows.length > 0;
      if (!owns) return res.status(403).json({ error: { message: 'You are not assigned to this batch.', code: 'FORBIDDEN' } });
    }

    const progress = await pool.query('SELECT * FROM batch_progress WHERE batch_id = $1', [id]);
    const tasks = await pool.query(
      `SELECT tasks.*,
        COALESCE(json_agg(json_build_object(
          'resource_type', tr.resource_type, 'resource_id', tr.resource_id,
          'name', COALESCE(e.name, tk.plate_number)
        )) FILTER (WHERE tr.id IS NOT NULL), '[]') AS resources
       FROM tasks
       LEFT JOIN task_resources tr ON tr.task_id = tasks.id
       LEFT JOIN employees e ON e.id = tr.resource_id AND tr.resource_type IN ('collector','driver')
       LEFT JOIN trucks tk ON tk.id = tr.resource_id AND tr.resource_type = 'truck'
       WHERE tasks.batch_id = $1
       GROUP BY tasks.id ORDER BY tasks.id`,
      [id]
    );
    res.json({ data: { ...batch, progress: progress.rows[0] || null, tasks: tasks.rows } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load batch.', code: 'INTERNAL' } });
  }
});

router.get('/:id/customers', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid batch id.', code: 'VALIDATION' } });
  try {
    const batchRes = await pool.query('SELECT * FROM batches WHERE id = $1', [id]);
    if (batchRes.rows.length === 0) return res.status(404).json({ error: { message: 'Batch not found.', code: 'NOT_FOUND' } });
    const batch = batchRes.rows[0];
    if (!(await assertBatchZoneAccess(req.user, batch.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this batch.', code: 'FORBIDDEN' } });
    }
    if ((req.user.role || '').toLowerCase() === 'collector') {
      const myEmpId = await resolveEmployeeIdForUser(req.user);
      const owns = myEmpId !== null && (await pool.query(
        `SELECT 1 FROM tasks t JOIN task_resources tr ON tr.task_id = t.id WHERE t.batch_id = $1 AND tr.resource_type = 'collector' AND tr.resource_id = $2 LIMIT 1`,
        [id, myEmpId]
      )).rows.length > 0;
      if (!owns) return res.status(403).json({ error: { message: 'You are not assigned to this batch.', code: 'FORBIDDEN' } });
    }
    const result = await pool.query(
      `SELECT batch_customers.*, customers.customer_number, customers.name, customers.business_name, customers.phone, customers.address_line
       FROM batch_customers JOIN customers ON customers.id = batch_customers.customer_id
       WHERE batch_customers.batch_id = $1 ORDER BY customers.name`,
      [id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load batch customers.', code: 'INTERNAL' } });
  }
});

// ---------- Batch lifecycle (row-locked, concurrency-safe — preserved verbatim pattern) ----------

router.put('/:id/start', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid batch id.', code: 'VALIDATION' } });
  try {
    const preCheck = await pool.query('SELECT zone_id FROM batches WHERE id = $1', [id]);
    if (preCheck.rows.length === 0) return res.status(404).json({ error: { message: 'Batch not found.', code: 'NOT_FOUND' } });
    if (!(await assertBatchZoneAccess(req.user, preCheck.rows[0].zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this batch.', code: 'FORBIDDEN' } });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT * FROM batches WHERE id = $1 FOR UPDATE', [id]);
      const batch = locked.rows[0];
      if (!['draft', 'assigned'].includes(batch.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message: `Cannot start a batch in status ${batch.status}.`, code: 'CONFLICT' } });
      }
      const updated = await client.query(`UPDATE batches SET status = 'in_progress', started_at = COALESCE(started_at, NOW()) WHERE id = $1 RETURNING *`, [id]);
      await client.query('COMMIT');
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'batch.start', entityType: 'batch', entityId: id, before: batch, after: updated.rows[0] });
      res.json({ data: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to start batch.', code: 'INTERNAL' } });
  }
});

// Idempotent by design (matches the current system's documented behavior):
// closing an already-Partially-Completed batch is valid and may legitimately
// return the same recomputed status again, not an error.
router.put('/:id/close-cycle', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid batch id.', code: 'VALIDATION' } });
  try {
    const preCheck = await pool.query('SELECT zone_id FROM batches WHERE id = $1', [id]);
    if (preCheck.rows.length === 0) return res.status(404).json({ error: { message: 'Batch not found.', code: 'NOT_FOUND' } });
    if (!(await assertBatchZoneAccess(req.user, preCheck.rows[0].zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this batch.', code: 'FORBIDDEN' } });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT * FROM batches WHERE id = $1 FOR UPDATE', [id]);
      const batch = locked.rows[0];
      if (!['in_progress', 'assigned', 'partially_completed'].includes(batch.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message: `Cannot close cycle on a batch in status ${batch.status}.`, code: 'CONFLICT' } });
      }
      const progress = await client.query('SELECT pending FROM batch_progress WHERE batch_id = $1', [id]);
      const pending = parseInt(progress.rows[0]?.pending || 0, 10);
      const newStatus = pending === 0 ? 'completed' : 'partially_completed';
      // Explicit ::varchar cast on the first $1 use — without it, Postgres's
      // parameter-type inference sees $1 compared to a plain string literal
      // in the CASE WHEN and a column assignment in the SET clause and
      // throws "inconsistent types deduced for parameter $1". The current
      // system's own equivalent route already has this exact cast — it was
      // dropped during the initial V2 port and caught live during this
      // module's own QA, not a new discovery independent of the reference.
      const updated = await client.query(
        `UPDATE batches SET status = $1::varchar, completed_at = CASE WHEN $1::varchar = 'completed' THEN NOW() ELSE completed_at END WHERE id = $2 RETURNING *`,
        [newStatus, id]
      );
      await client.query('COMMIT');
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'batch.close_cycle', entityType: 'batch', entityId: id, before: batch, after: updated.rows[0] });
      res.json({ data: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to close cycle on batch.', code: 'INTERNAL' } });
  }
});

router.put('/:id/cancel', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid batch id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'A reason is required to cancel a batch.', code: 'VALIDATION' } });
  try {
    const preCheck = await pool.query('SELECT zone_id FROM batches WHERE id = $1', [id]);
    if (preCheck.rows.length === 0) return res.status(404).json({ error: { message: 'Batch not found.', code: 'NOT_FOUND' } });
    if (!(await assertBatchZoneAccess(req.user, preCheck.rows[0].zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this batch.', code: 'FORBIDDEN' } });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query('SELECT * FROM batches WHERE id = $1 FOR UPDATE', [id]);
      const batch = locked.rows[0];
      if (['completed', 'cancelled'].includes(batch.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message: `Cannot cancel a batch already ${batch.status}.`, code: 'CONFLICT' } });
      }
      const incoming = await client.query(`SELECT COUNT(*) c FROM batch_customers WHERE rescheduled_to_batch_id = $1 AND status = 'rescheduled'`, [id]);
      if (parseInt(incoming.rows[0].c, 10) > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message: `${incoming.rows[0].c} customer(s) were rescheduled into this batch — re-point them before cancelling.`, code: 'CONFLICT' } });
      }
      const updated = await client.query(`UPDATE batches SET status = 'cancelled', cancelled_at = NOW(), cancelled_reason = $1 WHERE id = $2 RETURNING *`, [reason, id]);
      await client.query('COMMIT');
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'batch.cancel', entityType: 'batch', entityId: id, before: batch, after: updated.rows[0] });
      res.json({ data: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to cancel batch.', code: 'INTERNAL' } });
  }
});

// ---------- Tasks + resource assignment ----------

router.post('/:id/tasks', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid batch id.', code: 'VALIDATION' } });
  try {
    const batchRes = await pool.query('SELECT * FROM batches WHERE id = $1', [id]);
    if (batchRes.rows.length === 0) return res.status(404).json({ error: { message: 'Batch not found.', code: 'NOT_FOUND' } });
    const batch = batchRes.rows[0];
    if (['completed', 'cancelled'].includes(batch.status)) {
      return res.status(400).json({ error: { message: `Cannot add tasks to a ${batch.status} batch.`, code: 'VALIDATION' } });
    }
    if (!(await assertBatchZoneAccess(req.user, batch.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this batch.', code: 'FORBIDDEN' } });
    }

    const resources = Array.isArray(req.body.resources) ? req.body.resources : [];
    for (const r of resources) {
      const check = await validateResourceAssignment(r.resource_type, r.resource_id, batch);
      if (!check.ok) return res.status(check.code === 'NOT_FOUND' ? 400 : 409).json({ error: { message: check.error, code: check.code } });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const taskRes = await client.query(`INSERT INTO tasks (batch_id, status) VALUES ($1, 'pending') RETURNING *`, [id]);
      const task = taskRes.rows[0];
      for (const r of resources) {
        await client.query(`INSERT INTO task_resources (task_id, resource_type, resource_id, role_note) VALUES ($1,$2,$3,$4)`, [task.id, r.resource_type, r.resource_id, r.role_note || null]);
        await client.query(`INSERT INTO task_resource_history (task_id, resource_type, resource_id, action, performed_by) VALUES ($1,$2,$3,'assigned',$4)`, [task.id, r.resource_type, r.resource_id, req.user.id]);
      }
      if (batch.status === 'draft' && resources.length > 0) {
        await client.query(`UPDATE batches SET status = 'assigned', assigned_at = COALESCE(assigned_at, NOW()) WHERE id = $1`, [id]);
      }
      await client.query('COMMIT');
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'task.create', entityType: 'task', entityId: task.id, before: null, after: task });
      res.status(201).json({ data: task });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'This resource is already assigned to this task.', code: 'CONFLICT' } });
    res.status(500).json({ error: { message: 'Failed to create task.', code: 'INTERNAL' } });
  }
});

router.post('/:id/tasks/:taskId/resources', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  const taskId = parseStrictId(req.params.taskId);
  if (id === null || taskId === null) return res.status(400).json({ error: { message: 'Invalid id.', code: 'VALIDATION' } });
  const { resource_type, resource_id, role_note } = req.body;
  try {
    const batchRes = await pool.query('SELECT * FROM batches WHERE id = $1', [id]);
    if (batchRes.rows.length === 0) return res.status(404).json({ error: { message: 'Batch not found.', code: 'NOT_FOUND' } });
    const batch = batchRes.rows[0];
    if (!(await assertBatchZoneAccess(req.user, batch.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this batch.', code: 'FORBIDDEN' } });
    }
    const linkCheck = await pool.query('SELECT 1 FROM tasks WHERE id = $1 AND batch_id = $2', [taskId, id]);
    if (linkCheck.rows.length === 0) return res.status(404).json({ error: { message: 'This task does not belong to this batch.', code: 'NOT_FOUND' } });

    const check = await validateResourceAssignment(resource_type, resource_id, batch);
    if (!check.ok) return res.status(check.code === 'NOT_FOUND' ? 400 : 409).json({ error: { message: check.error, code: check.code } });

    const inserted = await pool.query(`INSERT INTO task_resources (task_id, resource_type, resource_id, role_note) VALUES ($1,$2,$3,$4) RETURNING *`, [taskId, resource_type, resource_id, role_note || null]);
    await pool.query(`INSERT INTO task_resource_history (task_id, resource_type, resource_id, action, performed_by) VALUES ($1,$2,$3,'assigned',$4)`, [taskId, resource_type, resource_id, req.user.id]);
    await pool.query(`UPDATE batches SET status = 'assigned', assigned_at = COALESCE(assigned_at, NOW()) WHERE id = $1 AND status = 'draft'`, [id]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'task_resource.assign', entityType: 'task_resource', entityId: inserted.rows[0].id, before: null, after: inserted.rows[0] });
    res.status(201).json({ data: inserted.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'This resource is already assigned to this task.', code: 'CONFLICT' } });
    res.status(500).json({ error: { message: 'Failed to assign resource.', code: 'INTERNAL' } });
  }
});

router.delete('/:id/tasks/:taskId/resources/:resourceType/:resourceId', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  const taskId = parseStrictId(req.params.taskId);
  const resourceId = parseStrictId(req.params.resourceId);
  if (id === null || taskId === null || resourceId === null) return res.status(400).json({ error: { message: 'Invalid id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'A reason is required to remove a resource.', code: 'VALIDATION' } });
  try {
    const batchRes = await pool.query('SELECT zone_id FROM batches WHERE id = $1', [id]);
    if (batchRes.rows.length === 0) return res.status(404).json({ error: { message: 'Batch not found.', code: 'NOT_FOUND' } });
    if (!(await assertBatchZoneAccess(req.user, batchRes.rows[0].zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this batch.', code: 'FORBIDDEN' } });
    }
    const { resourceType } = req.params;
    const deleted = await pool.query(`DELETE FROM task_resources WHERE task_id = $1 AND resource_type = $2 AND resource_id = $3 RETURNING *`, [taskId, resourceType, resourceId]);
    if (deleted.rows.length === 0) return res.status(404).json({ error: { message: 'Resource assignment not found.', code: 'NOT_FOUND' } });
    await pool.query(`INSERT INTO task_resource_history (task_id, resource_type, resource_id, action, reason, performed_by) VALUES ($1,$2,$3,'removed',$4,$5)`, [taskId, resourceType, resourceId, reason, req.user.id]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'task_resource.remove', entityType: 'task_resource', entityId: deleted.rows[0].id, before: deleted.rows[0], after: null });
    res.json({ data: { success: true } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to remove resource.', code: 'INTERNAL' } });
  }
});

// PUT /tasks/:taskId/status — task start/complete. DR-7 is RE-VALIDATED here
// for every 'collector' resource currently on the task (OD-4: task-start
// validation, protecting against a stale assignment where the employee's
// classification changed after assignment).
router.put('/:id/tasks/:taskId/status', authenticateToken, requireRole('admin', 'collector'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  const taskId = parseStrictId(req.params.taskId);
  if (id === null || taskId === null) return res.status(400).json({ error: { message: 'Invalid id.', code: 'VALIDATION' } });
  const status = req.body?.status;
  if (!['pending', 'in_progress', 'completed'].includes(status)) {
    return res.status(400).json({ error: { message: 'status must be one of: pending, in_progress, completed.', code: 'VALIDATION' } });
  }
  try {
    const batchRes = await pool.query('SELECT * FROM batches WHERE id = $1', [id]);
    if (batchRes.rows.length === 0) return res.status(404).json({ error: { message: 'Batch not found.', code: 'NOT_FOUND' } });
    const batch = batchRes.rows[0];
    const linkCheck = await pool.query('SELECT 1 FROM tasks WHERE id = $1 AND batch_id = $2', [taskId, id]);
    if (linkCheck.rows.length === 0) return res.status(404).json({ error: { message: 'This task does not belong to this batch.', code: 'NOT_FOUND' } });

    if ((req.user.role || '').toLowerCase() === 'collector') {
      const myEmpId = await resolveEmployeeIdForUser(req.user);
      const owns = myEmpId !== null && (await pool.query(
        `SELECT 1 FROM task_resources WHERE task_id = $1 AND resource_type = 'collector' AND resource_id = $2 LIMIT 1`,
        [taskId, myEmpId]
      )).rows.length > 0;
      if (!owns) return res.status(403).json({ error: { message: 'This task is not assigned to you.', code: 'FORBIDDEN' } });
    } else if (!(await assertBatchZoneAccess(req.user, batch.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this batch.', code: 'FORBIDDEN' } });
    }

    if (status === 'in_progress') {
      const collectors = await pool.query(`SELECT resource_id FROM task_resources WHERE task_id = $1 AND resource_type = 'collector'`, [taskId]);
      for (const row of collectors.rows) {
        const check = await validateResourceAssignment('collector', row.resource_id, batch);
        if (!check.ok) {
          return res.status(409).json({ error: { message: `Task cannot start: ${check.error}`, code: 'DR7_STALE_ASSIGNMENT' } });
        }
      }
    }

    const completedAt = status === 'completed' ? 'CURRENT_TIMESTAMP' : 'NULL';
    const startedAtSql = status === 'in_progress' ? ', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)' : '';
    const existing = await pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    const result = await pool.query(
      `UPDATE tasks SET status = $1, completed_at = ${completedAt}${startedAtSql} WHERE id = $2 RETURNING *`,
      [status, taskId]
    );
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'task.status_change', entityType: 'task', entityId: taskId, before: existing.rows[0], after: result.rows[0] });
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update task status.', code: 'INTERNAL' } });
  }
});

// ---------- Batch customer status marking + reschedule ----------

router.put('/:id/customers/:customerId/status', authenticateToken, requireRole(...MARK_STATUS_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  const customerId = parseStrictId(req.params.customerId);
  if (id === null || customerId === null) return res.status(400).json({ error: { message: 'Invalid id.', code: 'VALIDATION' } });
  const { status, task_id, reason, note, lat, lng } = req.body;
  if (!['serviced', 'missed', 'skipped'].includes(status)) {
    return res.status(400).json({ error: { message: `status must be one of: serviced, missed, skipped.`, code: 'VALIDATION' } });
  }
  if (status === 'missed' && !reason) return res.status(400).json({ error: { message: 'A reason is required to mark a customer Missed.', code: 'VALIDATION' } });
  try {
    if ((req.user.role || '').toLowerCase() === 'collector') {
      const tid = parseStrictId(String(task_id ?? ''));
      if (tid === null) return res.status(400).json({ error: { message: 'task_id is required.', code: 'VALIDATION' } });
      const myEmpId = await resolveEmployeeIdForUser(req.user);
      const owns = myEmpId !== null && (await pool.query(
        `SELECT 1 FROM task_resources WHERE task_id = $1 AND resource_type = 'collector' AND resource_id = $2 LIMIT 1`,
        [tid, myEmpId]
      )).rows.length > 0;
      if (!owns) return res.status(403).json({ error: { message: 'This task is not assigned to you.', code: 'FORBIDDEN' } });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const bcRes = await client.query('SELECT * FROM batch_customers WHERE batch_id = $1 AND customer_id = $2 FOR UPDATE', [id, customerId]);
      if (bcRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: { message: 'This customer is not in this batch.', code: 'NOT_FOUND' } });
      }
      const bc = bcRes.rows[0];
      if (bc.status !== 'pending') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message: `This customer is already ${bc.status} in this batch.`, code: 'CONFLICT' } });
      }
      const updated = await client.query(
        `UPDATE batch_customers SET status = $1, status_reason = $2, status_note = $3, status_lat = $4, status_lng = $5, status_at = NOW()
         WHERE batch_id = $6 AND customer_id = $7 RETURNING *`,
        [status, reason || null, note || null, lat || null, lng || null, id, customerId]
      );
      await client.query('COMMIT');
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'batch_customer.status_change', entityType: 'batch_customer', entityId: bc.id, before: bc, after: updated.rows[0] });
      res.json({ data: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update customer status.', code: 'INTERNAL' } });
  }
});

router.post('/:id/customers/:customerId/reschedule', authenticateToken, requireRole(...RESCHEDULE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  const customerId = parseStrictId(req.params.customerId);
  if (id === null || customerId === null) return res.status(400).json({ error: { message: 'Invalid id.', code: 'VALIDATION' } });
  const { target_batch_id, create_new_target, reason } = req.body;
  if (!target_batch_id && !create_new_target) {
    return res.status(400).json({ error: { message: 'Either target_batch_id or create_new_target:true is required.', code: 'VALIDATION' } });
  }
  try {
    const sourceBatchRes = await pool.query('SELECT * FROM batches WHERE id = $1', [id]);
    if (sourceBatchRes.rows.length === 0) return res.status(404).json({ error: { message: 'Batch not found.', code: 'NOT_FOUND' } });
    const sourceBatch = sourceBatchRes.rows[0];
    if (!(await assertBatchZoneAccess(req.user, sourceBatch.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this batch.', code: 'FORBIDDEN' } });
    }

    let targetBatchId = target_batch_id ? parseStrictId(String(target_batch_id)) : null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const bcRes = await client.query('SELECT * FROM batch_customers WHERE batch_id = $1 AND customer_id = $2 FOR UPDATE', [id, customerId]);
      if (bcRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: { message: 'This customer is not in this batch.', code: 'NOT_FOUND' } });
      }
      const bc = bcRes.rows[0];
      if (!['pending', 'missed'].includes(bc.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message: `Cannot reschedule a customer already ${bc.status}.`, code: 'CONFLICT' } });
      }

      if (create_new_target) {
        const { batchNumber, batchCode } = await generateBatchCode(client, sourceBatch.zone_id, sourceBatch.cycle_id);
        const newBatch = await client.query(
          `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, customer_type, commercial_shift, start_date, status, created_by, notes)
           VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE,'draft',$7,$8) RETURNING *`,
          [batchCode, sourceBatch.zone_id, sourceBatch.cycle_id, batchNumber, sourceBatch.customer_type, sourceBatch.commercial_shift, req.user.id, `Created via reschedule from batch ${sourceBatch.batch_code}`]
        );
        targetBatchId = newBatch.rows[0].id;
      } else {
        const targetBatch = await client.query('SELECT * FROM batches WHERE id = $1', [targetBatchId]);
        if (targetBatch.rows.length === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: { message: 'Target batch not found.', code: 'NOT_FOUND' } });
        }
        if (['completed', 'cancelled'].includes(targetBatch.rows[0].status)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: { message: `Cannot reschedule into a ${targetBatch.rows[0].status} batch.`, code: 'VALIDATION' } });
        }
        // Simplification (documented, not the current system's full dynamic
        // permission-catalog mechanism): cross-zone reschedule is admin-only
        // in this checkpoint, since zone-scoped roles (gudoomiye/
        // zone_accountant) are per-zone by construction.
        if (targetBatch.rows[0].zone_id !== sourceBatch.zone_id && (req.user.role || '').toLowerCase() !== 'admin') {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: { message: 'Cross-zone reschedule requires an admin.', code: 'FORBIDDEN' } });
        }
      }

      const updated = await client.query(
        `UPDATE batch_customers SET status = 'rescheduled', rescheduled_to_batch_id = $1, status_reason = $2, status_at = NOW() WHERE batch_id = $3 AND customer_id = $4 RETURNING *`,
        [targetBatchId, reason || null, id, customerId]
      );
      await client.query(`INSERT INTO batch_customers (batch_id, customer_id, status) VALUES ($1, $2, 'pending')`, [targetBatchId, customerId]);
      await client.query(`UPDATE batches SET total_customers = total_customers + 1 WHERE id = $1`, [targetBatchId]);
      await client.query('COMMIT');
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'batch_customer.reschedule', entityType: 'batch_customer', entityId: bc.id, before: bc, after: { ...updated.rows[0], target_batch_id: targetBatchId } });
      res.json({ data: { ...updated.rows[0], target_batch_id: targetBatchId } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'Customer is already Pending in the target batch (or another open batch).', code: 'CONFLICT' } });
    res.status(500).json({ error: { message: 'Failed to reschedule customer.', code: 'INTERNAL' } });
  }
});

module.exports = router;
