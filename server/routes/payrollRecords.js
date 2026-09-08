const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { resolveEmployeeIdForRequestUser } = require('../lib/hrCalculations');

const router = express.Router();

// Phase 1 HR & Payroll — Spec §11-14. Payroll records/items/settlement/
// reversal. Payroll is its own financial domain — never a customer
// invoice/payment/debt/cashout variant.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'];
const SETTLE_ROLES = ['admin', 'head_of_cashiers'];
const IMMUTABLE_STATUSES = ['finalized', 'paid', 'reversed'];

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

// GET / — list, zone-scoped via the record's own zone_snapshot_id.
router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const role = (req.user.role || '').toLowerCase();
    const params = [];
    const filters = [];
    if (myZoneId !== null) { params.push(myZoneId); filters.push(`pr.zone_snapshot_id = $${params.length}`); }
    if (req.query.payroll_period_id) {
      const pid = parseStrictId(req.query.payroll_period_id);
      if (pid === null) return res.status(400).json({ error: { message: 'Invalid payroll_period_id.', code: 'VALIDATION' } });
      params.push(pid); filters.push(`pr.payroll_period_id = $${params.length}`);
    }
    if (req.query.employee_id) {
      const eid = parseStrictId(req.query.employee_id);
      if (eid === null) return res.status(400).json({ error: { message: 'Invalid employee_id.', code: 'VALIDATION' } });
      params.push(eid); filters.push(`pr.employee_id = $${params.length}`);
    }
    if (req.query.status) { params.push(req.query.status); filters.push(`pr.status = $${params.length}`); }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    // Head of Cashiers: settlement-relevant columns only (Spec §13).
    const columns = role === 'head_of_cashiers'
      ? 'pr.id, pr.payroll_period_id, pr.employee_id, pr.net_salary, pr.status, e.name AS employee_name'
      : 'pr.*, e.name AS employee_name';
    const result = await pool.query(
      `SELECT ${columns} FROM payroll_records pr JOIN employees e ON pr.employee_id = e.id
       ${whereSql} ORDER BY pr.created_at DESC`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list payroll records.', code: 'INTERNAL' } });
  }
});

// GET /me — own-record payslip list. Spec §15/§18.
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const myEmployeeId = await resolveEmployeeIdForRequestUser(req.user);
    if (myEmployeeId === null) return res.status(403).json({ error: { message: 'No employee record is linked to your account.', code: 'FORBIDDEN' } });
    const result = await pool.query(
      `SELECT pr.*, pp.label AS period_label FROM payroll_records pr JOIN payroll_periods pp ON pr.payroll_period_id = pp.id
       WHERE pr.employee_id = $1 ORDER BY pp.start_date DESC`,
      [myEmployeeId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load payroll history.', code: 'INTERNAL' } });
  }
});

async function loadRecordWithAccessCheck(req, res, id) {
  const recRes = await pool.query('SELECT * FROM payroll_records WHERE id = $1', [id]);
  if (recRes.rows.length === 0) { res.status(404).json({ error: { message: 'Payroll record not found.', code: 'NOT_FOUND' } }); return null; }
  const record = recRes.rows[0];
  const myZoneId = await resolveUserZoneId(req.user);
  if (myZoneId !== null && record.zone_snapshot_id !== myZoneId) {
    res.status(403).json({ error: { message: 'You do not have access to this payroll record.', code: 'FORBIDDEN' } });
    return null;
  }
  return record;
}

// GET /:id — full structured payslip view. Spec §16.
router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid payroll record id.', code: 'VALIDATION' } });
  try {
    const record = await loadRecordWithAccessCheck(req, res, id);
    if (!record) return;
    const items = await pool.query('SELECT * FROM payroll_items WHERE payroll_record_id = $1 ORDER BY created_at ASC', [id]);
    const settlement = await pool.query('SELECT * FROM payroll_settlements WHERE payroll_record_id = $1', [id]);
    const period = await pool.query('SELECT label, start_date, end_date FROM payroll_periods WHERE id = $1', [record.payroll_period_id]);
    res.json({ data: { ...record, period: period.rows[0] || null, items: items.rows, settlement: settlement.rows[0] || null } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load payroll record.', code: 'INTERNAL' } });
  }
});

// POST /:id/items — earning/deduction line item, incl. cashout-shortage
// linkage. Spec §11/§12. Admin only (payroll processing role).
router.post('/:id/items', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid payroll record id.', code: 'VALIDATION' } });
  const { item_type, amount, description, source_type, source_id } = req.body;
  if (!['earning', 'deduction'].includes(item_type)) return res.status(400).json({ error: { message: "item_type must be 'earning' or 'deduction'.", code: 'VALIDATION' } });
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: { message: 'amount must be a positive number.', code: 'VALIDATION' } });
  const desc = (description || '').trim();
  if (!desc) return res.status(400).json({ error: { message: 'description is required.', code: 'VALIDATION' } });
  let srcType = null, srcId = null;
  if (source_type) {
    if (!['cashout_shortage', 'manual'].includes(source_type)) return res.status(400).json({ error: { message: 'Invalid source_type.', code: 'VALIDATION' } });
    srcType = source_type;
    if (srcType === 'cashout_shortage') {
      srcId = parseStrictId(source_id);
      if (srcId === null) return res.status(400).json({ error: { message: 'source_id is required when source_type is cashout_shortage.', code: 'VALIDATION' } });
      // Cashout (CLOSED Module 7) is validated by SELECT only — no
      // write, no FK, no dependency at the schema level (Spec §1.6.1).
      const shortage = await pool.query('SELECT id, status FROM cashout_shortages WHERE id = $1', [srcId]);
      if (shortage.rows.length === 0) return res.status(400).json({ error: { message: 'source_id does not reference an existing cashout shortage.', code: 'VALIDATION' } });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const recRes = await client.query('SELECT * FROM payroll_records WHERE id = $1 FOR UPDATE', [id]);
    if (recRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Payroll record not found.', code: 'NOT_FOUND' } });
    }
    const record = recRes.rows[0];
    if (IMMUTABLE_STATUSES.includes(record.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: `Payroll record is ${record.status} and cannot be modified.`, code: 'CONFLICT' } });
    }

    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO payroll_items (payroll_record_id, item_type, amount, description, source_type, source_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, item_type, amt, desc, srcType, srcId, req.user.id]
      );
    } catch (insertErr) {
      await client.query('ROLLBACK');
      if (insertErr.code === '23505') return res.status(409).json({ error: { message: 'This cashout shortage is already linked to a payroll deduction.', code: 'CONFLICT' } });
      throw insertErr;
    }

    const totals = await client.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE item_type = 'earning'), 0) AS earnings,
              COALESCE(SUM(amount) FILTER (WHERE item_type = 'deduction'), 0) AS deductions
       FROM payroll_items WHERE payroll_record_id = $1`,
      [id]
    );
    const earnings = totals.rows[0].earnings;
    const deductions = totals.rows[0].deductions;
    const updated = await client.query(
      `UPDATE payroll_records SET earnings_total = $1, deductions_total = $2,
         net_salary = salary_snapshot + $1 - $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 RETURNING *`,
      [earnings, deductions, id]
    );
    await client.query('COMMIT');
    const item = inserted.rows[0];
    await logAudit({
      actorId: req.user.id, actorUsername: req.user.username,
      action: srcType === 'cashout_shortage' ? 'payroll_item.link_shortage' : 'payroll_item.create',
      entityType: 'payroll_item', entityId: item.id, before: null, after: item,
    });
    res.status(201).json({ data: { item, payroll_record: updated.rows[0] } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to add payroll item.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// DELETE /:id/items/:itemId — open/processing only. Spec §11.
router.delete('/:id/items/:itemId', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  const itemId = parseStrictId(req.params.itemId);
  if (id === null || itemId === null) return res.status(400).json({ error: { message: 'Invalid id.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const recRes = await client.query('SELECT * FROM payroll_records WHERE id = $1 FOR UPDATE', [id]);
    if (recRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Payroll record not found.', code: 'NOT_FOUND' } });
    }
    const record = recRes.rows[0];
    if (IMMUTABLE_STATUSES.includes(record.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: `Payroll record is ${record.status} and cannot be modified.`, code: 'CONFLICT' } });
    }
    const itemRes = await client.query('SELECT * FROM payroll_items WHERE id = $1 AND payroll_record_id = $2', [itemId, id]);
    if (itemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Payroll item not found.', code: 'NOT_FOUND' } });
    }
    await client.query('DELETE FROM payroll_items WHERE id = $1', [itemId]);
    const totals = await client.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE item_type = 'earning'), 0) AS earnings,
              COALESCE(SUM(amount) FILTER (WHERE item_type = 'deduction'), 0) AS deductions
       FROM payroll_items WHERE payroll_record_id = $1`,
      [id]
    );
    const updated = await client.query(
      `UPDATE payroll_records SET earnings_total = $1, deductions_total = $2,
         net_salary = salary_snapshot + $1 - $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3 RETURNING *`,
      [totals.rows[0].earnings, totals.rows[0].deductions, id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'payroll_item.delete', entityType: 'payroll_item', entityId: itemId, before: itemRes.rows[0], after: null });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to delete payroll item.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// POST /:id/settle — Spec §14. Admin + Head of Cashiers.
router.post('/:id/settle', authenticateToken, requireRole(...SETTLE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid payroll record id.', code: 'VALIDATION' } });
  const { method, provider, reference } = req.body;
  if (!['cash', 'mobile_money'].includes(method)) return res.status(400).json({ error: { message: "method must be 'cash' or 'mobile_money'.", code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const recRes = await client.query('SELECT * FROM payroll_records WHERE id = $1 FOR UPDATE', [id]);
    if (recRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Payroll record not found.', code: 'NOT_FOUND' } });
    }
    const record = recRes.rows[0];
    if (record.status !== 'finalized') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'Only a finalized payroll record may be settled.', code: 'CONFLICT' } });
    }

    let settlement;
    try {
      settlement = await client.query(
        `INSERT INTO payroll_settlements (payroll_record_id, method, provider, reference, amount, settled_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, method, provider || null, reference || null, record.net_salary, req.user.id]
      );
    } catch (insertErr) {
      await client.query('ROLLBACK');
      if (insertErr.code === '23505') return res.status(409).json({ error: { message: 'This payroll record has already been settled.', code: 'CONFLICT' } });
      throw insertErr;
    }

    const updated = await client.query(
      `UPDATE payroll_records SET status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
      [id]
    );

    // Auto-advance the parent period to 'paid' once every record within
    // it is settled — Spec §6.
    const remaining = await client.query(
      `SELECT COUNT(*) FROM payroll_records WHERE payroll_period_id = $1 AND status NOT IN ('paid', 'reversed')`,
      [record.payroll_period_id]
    );
    if (parseInt(remaining.rows[0].count, 10) === 0) {
      await client.query(`UPDATE payroll_periods SET status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'finalized'`, [record.payroll_period_id]);
    }

    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'payroll_settlement.create', entityType: 'payroll_settlement', entityId: settlement.rows[0].id, before: null, after: settlement.rows[0] });
    res.status(201).json({ data: { settlement: settlement.rows[0], payroll_record: updated.rows[0] } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to settle payroll record.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// POST /:id/reverse — Spec §13. Admin only. finalized (not paid) only.
router.post('/:id/reverse', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid payroll record id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'A reason is required to reverse a payroll record.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const recRes = await client.query('SELECT * FROM payroll_records WHERE id = $1 FOR UPDATE', [id]);
    if (recRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Payroll record not found.', code: 'NOT_FOUND' } });
    }
    const record = recRes.rows[0];
    if (record.status !== 'finalized') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'Only a finalized (not yet paid) payroll record may be reversed.', code: 'CONFLICT' } });
    }

    const reversed = await client.query(
      `UPDATE payroll_records SET status = 'reversed', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
      [id]
    );
    const replacement = await client.query(
      `INSERT INTO payroll_records (payroll_period_id, employee_id, salary_snapshot, zone_snapshot_id, earnings_total, deductions_total, net_salary, status, reversed_from_id)
       VALUES ($1,$2,$3,$4,0,0,$3,'open',$5)
       RETURNING *`,
      [record.payroll_period_id, record.employee_id, record.salary_snapshot, record.zone_snapshot_id, record.id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'payroll_record.reverse', entityType: 'payroll_record', entityId: id, before: record, after: { reversed: reversed.rows[0], replacement: replacement.rows[0], reason } });
    res.status(201).json({ data: { reversed: reversed.rows[0], replacement: replacement.rows[0] } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: { message: 'A replacement payroll record already exists for this employee/period.', code: 'CONFLICT' } });
    res.status(500).json({ error: { message: 'Failed to reverse payroll record.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

module.exports = router;
