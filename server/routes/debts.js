const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getInvoiceBalance, EPSILON } = require('../lib/financialCalculations');

const router = express.Router();

// 'cashier' added (user-reported live, Phase 10) — same gap/fix as
// invoices.js and payments.js: this file's own zone checks already
// existed, only the role list was missing 'cashier'.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'cashier'];
const VIEW_ROLES = ['admin', 'cashier', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'];
const CREATE_ROLES = ['admin', 'cashier', 'gudoomiye'];
const SETTLE_ROLES = ['admin', 'cashier'];

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

router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const where = [];
    const params = [];
    if (myZoneId !== null) {
      params.push(myZoneId);
      where.push(`customers.zone_id = $${params.length}`);
    }
    if (req.query.status) {
      params.push(req.query.status);
      where.push(`debts.status = $${params.length}`);
    }
    // P1 Functional Gaps — customer_id filter (mirrors invoices.js exactly,
    // used by Customer Detail's own Debts section) and q search by
    // customer name/number (2-char minimum, same ILIKE pattern already
    // used by Batches/Groups search — no new pattern invented).
    if (req.query.customer_id) {
      const cid = parseStrictId(req.query.customer_id);
      if (cid === null) return res.status(400).json({ error: { message: 'Invalid customer_id filter.', code: 'VALIDATION' } });
      params.push(cid);
      where.push(`debts.customer_id = $${params.length}`);
    }
    if (req.query.q) {
      const q = req.query.q.trim();
      if (q.length >= 2) {
        params.push(`%${q}%`);
        const i = params.length;
        where.push(`(customers.name ILIKE $${i} OR customers.customer_number ILIKE $${i})`);
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT debts.*, customers.name AS customer_name, customers.customer_number
       FROM debts JOIN customers ON debts.customer_id = customers.id
       ${whereSql} ORDER BY debts.created_at DESC`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list debts.', code: 'INTERNAL' } });
  }
});

// POST / — standalone or invoice-linked. Matches the reference system's
// own POST /api/debts, which never required an invoice (OD-1: invoice_id
// nullable).
router.post('/', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  const { customer_id, invoice_id, amount, currency, description } = req.body;
  const custId = parseStrictId(String(customer_id ?? ''));
  if (custId === null) return res.status(400).json({ error: { message: 'customer_id is required.', code: 'VALIDATION' } });
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: { message: 'amount must be a positive number.', code: 'VALIDATION' } });

  let invId = null;
  if (invoice_id !== undefined && invoice_id !== null && invoice_id !== '') {
    invId = parseStrictId(String(invoice_id));
    if (invId === null) return res.status(400).json({ error: { message: 'Invalid invoice_id.', code: 'VALIDATION' } });
  }

  try {
    const custRes = await pool.query('SELECT id, zone_id FROM customers WHERE id = $1', [custId]);
    if (custRes.rows.length === 0) return res.status(404).json({ error: { message: 'Customer not found.', code: 'NOT_FOUND' } });
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && custRes.rows[0].zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You cannot create a debt for a customer outside your zone.', code: 'FORBIDDEN' } });
    }
    if (invId !== null) {
      const invRes = await pool.query('SELECT id, customer_id FROM invoices WHERE id = $1', [invId]);
      if (invRes.rows.length === 0) return res.status(400).json({ error: { message: 'invoice_id does not reference an existing invoice.', code: 'VALIDATION' } });
      if (invRes.rows[0].customer_id !== custId) return res.status(400).json({ error: { message: 'The referenced invoice belongs to a different customer.', code: 'VALIDATION' } });
    }

    const inserted = await pool.query(
      `INSERT INTO debts (customer_id, invoice_id, amount, currency, description, status, created_by)
       VALUES ($1,$2,$3,$4,$5,'unpaid',$6) RETURNING *`,
      [custId, invId, amt, currency || 'USD', description || null, req.user.id]
    );
    const debt = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'debt.create', entityType: 'debt', entityId: debt.id, before: null, after: debt });
    res.status(201).json({ data: debt });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to create debt.', code: 'INTERNAL' } });
  }
});

// PUT /:id/status — settle to 'paid'. OD-1's soft-block-with-reason: if
// the linked invoice is still outstanding, settlement_override_reason is
// required — the debt can still be settled (a real edge case, e.g.
// separately forgiven), but the contradiction is never silent.
router.put('/:id/status', authenticateToken, requireRole(...SETTLE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid debt id.', code: 'VALIDATION' } });
  const { status, settlement_override_reason } = req.body;
  if (status !== 'paid') return res.status(400).json({ error: { message: "Only status 'paid' may be set via this endpoint.", code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM debts WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Debt not found.', code: 'NOT_FOUND' } });
    }
    const debt = existing.rows[0];
    if (debt.status === 'paid') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'This debt is already settled.', code: 'CONFLICT' } });
    }

    let overrideReason = null;
    if (debt.invoice_id !== null) {
      const balance = await getInvoiceBalance(debt.invoice_id, client);
      if (balance && balance.outstanding > EPSILON) {
        const reason = (settlement_override_reason || '').trim();
        if (!reason) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: {
              message: `Cannot settle this debt: the originating invoice #${debt.invoice_id} still has an outstanding balance of $${balance.outstanding.toFixed(2)}. Provide settlement_override_reason to settle anyway.`,
              code: 'INVOICE_STILL_OUTSTANDING',
            },
          });
        }
        overrideReason = reason;
      }
    }

    const updated = await client.query(
      `UPDATE debts SET status = 'paid', settled_at = NOW(), settled_by = $1, settlement_override_reason = $2 WHERE id = $3 RETURNING *`,
      [req.user.id, overrideReason, id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'debt.settle', entityType: 'debt', entityId: id, before: debt, after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to settle debt.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

module.exports = router;
