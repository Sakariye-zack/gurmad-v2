const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getInvoiceBalance } = require('../lib/financialCalculations');

const router = express.Router();

// Same zone-scope pattern as every prior V2 module (local resolver, not a
// shared cross-module utility) — matches customers.js/batches.js exactly.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const VIEW_ROLES = ['admin', 'cashier', 'gudoomiye', 'zone_accountant'];
const CREATE_ROLES = ['admin', 'cashier'];

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

async function generateInvoiceNumber(client) {
  const seq = await client.query(`SELECT nextval('invoice_number_seq') AS n`);
  const n = Number(seq.rows[0].n);
  return `INV-${String(n).padStart(6, '0')}`;
}

// GET / — list, zone-scoped via the customer's own zone_id (invoices have
// no zone_id of their own; joining to customers is the same pattern the
// reference system uses via c.zone).
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
      where.push(`invoices.status = $${params.length}`);
    }
    if (req.query.customer_id) {
      const cid = parseStrictId(req.query.customer_id);
      if (cid === null) return res.status(400).json({ error: { message: 'Invalid customer_id filter.', code: 'VALIDATION' } });
      params.push(cid);
      where.push(`invoices.customer_id = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT invoices.*, customers.name AS customer_name, customers.customer_number, customers.phone AS customer_phone
       FROM invoices JOIN customers ON invoices.customer_id = customers.id
       ${whereSql} ORDER BY invoices.created_at DESC`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list invoices.', code: 'INTERNAL' } });
  }
});

router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid invoice id.', code: 'VALIDATION' } });
  try {
    const invRes = await pool.query(
      `SELECT invoices.*, customers.name AS customer_name, customers.customer_number, customers.phone AS customer_phone, customers.zone_id
       FROM invoices JOIN customers ON invoices.customer_id = customers.id WHERE invoices.id = $1`,
      [id]
    );
    if (invRes.rows.length === 0) return res.status(404).json({ error: { message: 'Invoice not found.', code: 'NOT_FOUND' } });
    const invoice = invRes.rows[0];

    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && invoice.zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this invoice.', code: 'FORBIDDEN' } });
    }

    const balance = await getInvoiceBalance(id);
    const payments = await pool.query(
      `SELECT id, amount, currency, method, amount_usd, status, reference_code, cashier_id, created_at, reversed_at, reversed_reason
       FROM payments WHERE invoice_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    const debt = await pool.query(`SELECT * FROM debts WHERE invoice_id = $1`, [id]);

    res.json({ data: { ...invoice, balance, payments: payments.rows, debt: debt.rows[0] || null } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load invoice.', code: 'INTERNAL' } });
  }
});

// POST / — create. invoice_total is always explicitly provided — never
// auto-calculated from customers.fee/collection_frequency (non-negotiable
// rule #10/#11: fee is a pre-fill suggestion only, read by the FRONTEND
// form, never by this route).
router.post('/', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  const { customer_id, invoice_total, discount_amount, currency, batch_customer_id, notes,
    collector_name_snapshot, truck_name_snapshot, zone_name_snapshot } = req.body;

  const custId = parseStrictId(String(customer_id ?? ''));
  if (custId === null) return res.status(400).json({ error: { message: 'customer_id is required.', code: 'VALIDATION' } });
  const total = parseFloat(invoice_total);
  if (isNaN(total) || total < 0) return res.status(400).json({ error: { message: 'invoice_total must be a non-negative number.', code: 'VALIDATION' } });
  const discount = discount_amount !== undefined ? parseFloat(discount_amount) : 0;
  if (isNaN(discount) || discount < 0) return res.status(400).json({ error: { message: 'discount_amount must be a non-negative number.', code: 'VALIDATION' } });
  if (discount > total) return res.status(400).json({ error: { message: 'discount_amount cannot exceed invoice_total.', code: 'VALIDATION' } });

  let bcId = null;
  if (batch_customer_id !== undefined && batch_customer_id !== null && batch_customer_id !== '') {
    bcId = parseStrictId(String(batch_customer_id));
    if (bcId === null) return res.status(400).json({ error: { message: 'Invalid batch_customer_id.', code: 'VALIDATION' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const custRes = await client.query('SELECT id, zone_id FROM customers WHERE id = $1', [custId]);
    if (custRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Customer not found.', code: 'NOT_FOUND' } });
    }
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && custRes.rows[0].zone_id !== myZoneId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'You cannot create an invoice for a customer outside your zone.', code: 'FORBIDDEN' } });
    }
    if (bcId !== null) {
      const bcRes = await client.query('SELECT id, customer_id FROM batch_customers WHERE id = $1', [bcId]);
      if (bcRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: { message: 'batch_customer_id does not reference an existing collection event.', code: 'VALIDATION' } });
      }
      if (bcRes.rows[0].customer_id !== custId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: { message: 'The referenced collection event belongs to a different customer.', code: 'VALIDATION' } });
      }
    }

    const invoiceNumber = await generateInvoiceNumber(client);
    const inserted = await client.query(
      `INSERT INTO invoices (invoice_number, customer_id, batch_customer_id, invoice_total, discount_amount, currency, status,
        collector_name_snapshot, truck_name_snapshot, zone_name_snapshot, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'unpaid',$7,$8,$9,$10,$11) RETURNING *`,
      [invoiceNumber, custId, bcId, total, discount, currency || 'USD',
        collector_name_snapshot || null, truck_name_snapshot || null, zone_name_snapshot || null, notes || null, req.user.id]
    );
    await client.query('COMMIT');
    const invoice = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'invoice.create', entityType: 'invoice', entityId: invoice.id, before: null, after: invoice });
    res.status(201).json({ data: invoice });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to create invoice.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// PUT /:id/void — Admin only, VOID != DELETE, row + audit trail preserved.
router.put('/:id/void', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid invoice id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'A reason is required to void an invoice.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Invoice not found.', code: 'NOT_FOUND' } });
    }
    const inv = existing.rows[0];
    if (inv.status === 'voided') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'This invoice is already voided.', code: 'CONFLICT' } });
    }
    const updated = await client.query(
      `UPDATE invoices SET status = 'voided', voided_at = NOW(), voided_by = $1, voided_reason = $2 WHERE id = $3 RETURNING *`,
      [req.user.id, reason, id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'invoice.void', entityType: 'invoice', entityId: id, before: inv, after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to void invoice.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

module.exports = router;
