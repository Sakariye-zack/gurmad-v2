const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Phase 1 HR & Payroll — Spec §6/§10. Payroll periods are company-wide;
// admin controls create/process/finalize.
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'];

function parseStrictId(raw) {
  if (!/^\d+$/.test(String(raw ?? ''))) return null;
  return parseInt(raw, 10);
}

router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const params = [];
    const filters = [];
    if (req.query.status) { params.push(req.query.status); filters.push(`status = $${params.length}`); }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(`SELECT * FROM payroll_periods ${whereSql} ORDER BY start_date DESC`, params);
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list payroll periods.', code: 'INTERNAL' } });
  }
});

router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid payroll period id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query('SELECT * FROM payroll_periods WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Payroll period not found.', code: 'NOT_FOUND' } });
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load payroll period.', code: 'INTERNAL' } });
  }
});

// POST / — Spec §1.4/§6: no overlapping period, admin only.
router.post('/', authenticateToken, requireRole('admin'), async (req, res) => {
  const { label, start_date, end_date } = req.body;
  if (!label || !String(label).trim()) return res.status(400).json({ error: { message: 'label is required.', code: 'VALIDATION' } });
  if (!start_date || !end_date) return res.status(400).json({ error: { message: 'start_date and end_date are required.', code: 'VALIDATION' } });
  if (new Date(end_date) < new Date(start_date)) return res.status(400).json({ error: { message: 'end_date must not be before start_date.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const overlap = await client.query(
      `SELECT id FROM payroll_periods WHERE NOT (end_date < $1 OR start_date > $2) FOR UPDATE`,
      [start_date, end_date]
    );
    if (overlap.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'A payroll period already exists that overlaps this date range.', code: 'CONFLICT' } });
    }
    const inserted = await client.query(
      `INSERT INTO payroll_periods (label, start_date, end_date, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [String(label).trim(), start_date, end_date, req.user.id]
    );
    await client.query('COMMIT');
    const period = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'payroll_period.create', entityType: 'payroll_period', entityId: period.id, before: null, after: period });
    res.status(201).json({ data: period });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to create payroll period.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// PUT /:id/status — process/finalize. Spec §6/§11.
router.put('/:id/status', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid payroll period id.', code: 'VALIDATION' } });
  const { status } = req.body;
  if (!['processing', 'finalized'].includes(status)) {
    return res.status(400).json({ error: { message: "status must be 'processing' or 'finalized'.", code: 'VALIDATION' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT * FROM payroll_periods WHERE id = $1 FOR UPDATE', [id]);
    if (before.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Payroll period not found.', code: 'NOT_FOUND' } });
    }
    const period = before.rows[0];
    const validTransition = (period.status === 'open' && status === 'processing') || (period.status === 'processing' && status === 'finalized');
    if (!validTransition) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: `Cannot transition payroll period from ${period.status} to ${status}.`, code: 'CONFLICT' } });
    }

    if (status === 'finalized') {
      // Finalizing the period finalizes every non-reversed record within it.
      await client.query(
        `UPDATE payroll_records SET status = 'finalized', finalized_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE payroll_period_id = $1 AND status = 'open'`,
        [id]
      );
    }

    const extra = status === 'finalized' ? ', finalized_by = $3, finalized_at = CURRENT_TIMESTAMP' : '';
    const params = status === 'finalized' ? [status, id, req.user.id] : [status, id];
    const updated = await client.query(
      `UPDATE payroll_periods SET status = $1, updated_at = CURRENT_TIMESTAMP ${extra} WHERE id = $2 RETURNING *`,
      params
    );
    await client.query('COMMIT');
    const updatedPeriod = updated.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: `payroll_period.${status}`, entityType: 'payroll_period', entityId: updatedPeriod.id, before: period, after: updatedPeriod });
    res.json({ data: updatedPeriod });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to update payroll period status.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// POST /:id/generate — Spec §7/§9. Snapshots salary + zone for every
// active employee into a payroll_records row. Deterministic, no
// attendance formula. Re-running for the same employee/period while
// still 'open' updates the snapshot (e.g. salary changed before
// processing began); a 'finalized'/'paid' record is left untouched
// (ON CONFLICT ... WHERE guard, mirroring the immutability precedent).
router.post('/:id/generate', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid payroll period id.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const periodRes = await client.query('SELECT * FROM payroll_periods WHERE id = $1 FOR UPDATE', [id]);
    if (periodRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Payroll period not found.', code: 'NOT_FOUND' } });
    }
    const period = periodRes.rows[0];
    if (period.status !== 'processing') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'Payroll can only be generated for a period in processing status.', code: 'CONFLICT' } });
    }

    const employees = await client.query(`SELECT id, salary, zone_id FROM employees WHERE status = 'active'`);
    const results = [];
    const needsReview = [];
    for (const emp of employees.rows) {
      const salarySnapshot = emp.salary != null ? emp.salary : 0;
      if (emp.salary == null || Number(emp.salary) === 0) needsReview.push(emp.id);
      const inserted = await client.query(
        `INSERT INTO payroll_records (payroll_period_id, employee_id, salary_snapshot, zone_snapshot_id, earnings_total, deductions_total, net_salary, status)
         VALUES ($1,$2,$3,$4,0,0,$3,'open')
         ON CONFLICT (payroll_period_id, employee_id) WHERE status != 'reversed' DO UPDATE SET
           salary_snapshot = EXCLUDED.salary_snapshot,
           zone_snapshot_id = EXCLUDED.zone_snapshot_id,
           net_salary = EXCLUDED.salary_snapshot + payroll_records.earnings_total - payroll_records.deductions_total,
           updated_at = CURRENT_TIMESTAMP
         WHERE payroll_records.status = 'open'
         RETURNING *`,
        [id, emp.id, salarySnapshot, emp.zone_id]
      );
      if (inserted.rows.length > 0) results.push(inserted.rows[0]);
    }
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'payroll_period.generate', entityType: 'payroll_period', entityId: id, before: null, after: { count: results.length } });
    res.json({ data: results, needs_review: needsReview });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to generate payroll.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// DELETE /:id — only an OPEN period with zero payroll_records. Spec §6.
router.delete('/:id', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid payroll period id.', code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM payroll_periods WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Payroll period not found.', code: 'NOT_FOUND' } });
    if (before.rows[0].status !== 'open') return res.status(409).json({ error: { message: 'Only an open payroll period may be deleted.', code: 'CONFLICT' } });
    const recordCount = await pool.query('SELECT COUNT(*) FROM payroll_records WHERE payroll_period_id = $1', [id]);
    if (parseInt(recordCount.rows[0].count, 10) > 0) {
      return res.status(409).json({ error: { message: 'This payroll period already has payroll records and cannot be deleted.', code: 'CONFLICT' } });
    }
    await pool.query('DELETE FROM payroll_periods WHERE id = $1', [id]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'payroll_period.delete', entityType: 'payroll_period', entityId: id, before: before.rows[0], after: null });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to delete payroll period.', code: 'INTERNAL' } });
  }
});

module.exports = router;
