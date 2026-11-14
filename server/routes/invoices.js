const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getInvoiceBalance, getInvoiceBalancesBulk } = require('../lib/financialCalculations');
const { zaadStateFor } = require('../lib/zaadAttempts');
const { buildInvoiceDocx } = require('../lib/documentGenerators');
const { generateInvoiceNumber, insertInvoice } = require('../lib/invoiceInsert');
const autoBilling = require('../lib/autoBilling');
const debtSuspension = require('../lib/debtSuspension');
const { getWorkedDays } = require('../lib/workedDays');

const router = express.Router();

// Same zone-scope pattern as every prior V2 module (local resolver, not a
// shared cross-module utility) — matches customers.js/batches.js exactly.
//
// 'cashier' added (user-reported live, Phase 10 — 'cashierku qaab
// noocee ah bu u bixinayaa lacagta wali halkaa malaha waxbaa iga
// dhiman'): a cashier was NOT zone-scoped here even though every
// downstream check in this file (GET /, GET /:id, POST /) already
// structurally enforces resolveUserZoneId()'s result — so a cashier
// could see and collect payment against ANY customer's invoice
// company-wide, not just their own zone, contradicting the zone-scoped
// cashier workflow already established elsewhere this session (cashout
// reconciliation). No other route logic changes — the enforcement code
// already existed, only the role list was missing 'cashier'.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'cashier'];
const VIEW_ROLES = ['admin', 'cashier', 'gudoomiye', 'zone_accountant'];
const CREATE_ROLES = ['admin', 'cashier'];

function parseStrictId(raw) {
  if (!/^\d+$/.test(raw)) return null;
  return parseInt(raw, 10);
}

// Group › District › Zone › Sub Zone of the invoice's customer (read-only,
// same path shape as dailyLists.js / documentGenerators.customerContext).
const CUSTOMER_PATH_JOINS = `LEFT JOIN zones cz ON cz.id = customers.zone_id
       LEFT JOIN groups cg ON cg.id = customers.group_id
       LEFT JOIN routes cr ON cr.id = customers.route_id
       LEFT JOIN group_zones cgz ON cgz.id = cr.group_zone_id`;
const CUSTOMER_PATH_SQL = `NULLIF(concat_ws(' › ', NULLIF(COALESCE(cg.name, cg.code), ''), NULLIF(cz.name, ''), NULLIF(COALESCE(cgz.name, cgz.code), ''), NULLIF(COALESCE(cr.name, cr.code), '')), '')`;

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

// ---- Auto-billing admin endpoints (registered before '/:id') ----
router.get('/auto-billing/status', authenticateToken, requireRole('admin', 'gudoomiye', 'zone_accountant'), async (req, res) => {
  try {
    const runs = (await pool.query(
      `SELECT id, kind, period_key, started_at, finished_at, created_count, jsonb_array_length(skipped) AS skipped_count, error, triggered_by
       FROM billing_runs ORDER BY id DESC LIMIT 20`)).rows;
    const myZoneId = await resolveUserZoneId(req.user);
    const latest = {};
    for (const kind of ['monthly', 'daily']) {
      const r = await pool.query(`SELECT id, period_key, skipped FROM billing_runs WHERE kind = $1 AND finished_at IS NOT NULL AND error IS NULL ORDER BY period_key DESC, id DESC LIMIT 1`, [kind]);
      let skipped = r.rows[0]?.skipped || [];
      if (myZoneId !== null && skipped.length) {
        const ok = await pool.query(`SELECT id FROM customers WHERE id = ANY($1::int[]) AND zone_id = $2`, [skipped.map((s) => s.customer_id), myZoneId]);
        const allowed = new Set(ok.rows.map((x) => x.id));
        skipped = skipped.filter((s) => allowed.has(s.customer_id));
      }
      latest[kind] = { run_id: r.rows[0]?.id || null, period_key: r.rows[0]?.period_key || null, skipped };
    }
    res.json({ data: { runs, latest_skipped: latest } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load auto-billing status.', code: 'INTERNAL' } });
  }
});

router.post('/auto-billing/run', authenticateToken, requireRole('admin'), async (req, res) => {
  const { kind, period, date } = req.body || {};
  if (kind !== 'monthly' && kind !== 'daily') return res.status(400).json({ error: { message: "kind must be 'monthly' or 'daily'.", code: 'VALIDATION' } });
  try {
    let result;
    if (kind === 'monthly') {
      if (period !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period))) return res.status(400).json({ error: { message: 'period must be YYYY-MM.', code: 'VALIDATION' } });
      result = await autoBilling.runMonthly({ triggeredBy: req.user.id, manual: true, period: period || null });
    } else {
      let d = date;
      if (d === undefined) d = autoBilling.localParts(new Date(), await autoBilling.getTimezone()).date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d)) || isNaN(new Date(d + 'T00:00:00Z').getTime()) || new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) !== d) {
        return res.status(400).json({ error: { message: 'date must be a valid YYYY-MM-DD.', code: 'VALIDATION' } });
      }
      result = await autoBilling.runDaily({ date: d, triggeredBy: req.user.id });
    }
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'invoice.auto_billing_run', entityType: 'billing_run', entityId: result.run_id || null, before: null,
      after: { kind, period: period || null, date: date || null, created: result.created, skipped: result.skipped.length } });
    res.json({ data: result });
  } catch (err) {
    console.error('auto-billing run failed:', err);
    res.status(500).json({ error: { message: 'Auto-billing run failed.', code: 'INTERNAL' } });
  }
});

// Billing workspace (?open=1): unpaid/partial invoices, paginated
// (page, page_size default 100, max 500) with optional status / currency
// filters. ?with_balance=1 attaches each invoice's balance from ONE
// set-based query (getInvoiceBalancesBulk — same rules as getInvoiceBalance)
// and meta.summary (counts + still-owed per currency over every open invoice
// in scope, ignoring the status/currency filters). Each row also carries the
// ZAAD push state (zaad_in_progress / zaad_blocked_until).
async function listOpenInvoices(req, res, where, params) {
  const base = [...where, `invoices.status IN ('unpaid', 'partial')`];
  const idRows = (await pool.query(
    `SELECT invoices.id, invoices.status, CASE WHEN invoices.currency = 'SLSH' THEN 'SLSH' ELSE 'USD' END AS currency
     FROM invoices JOIN customers ON invoices.customer_id = customers.id
     WHERE ${base.join(' AND ')} ORDER BY invoices.created_at DESC, invoices.id DESC`,
    params
  )).rows;
  const withBalance = req.query.with_balance === '1';
  const balances = withBalance ? await getInvoiceBalancesBulk(idRows.map((r) => r.id)) : new Map();
  const statusF = ['unpaid', 'partial'].includes(req.query.status) ? req.query.status : null;
  const curF = ['USD', 'SLSH'].includes(String(req.query.currency || '').toUpperCase()) ? String(req.query.currency).toUpperCase() : null;
  const filtered = idRows.filter((r) => (!statusF || r.status === statusF) && (!curF || r.currency === curF));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(req.query.page_size, 10) || 100));
  const pageIds = filtered.slice((page - 1) * pageSize, page * pageSize).map((r) => r.id);
  const rows = pageIds.length ? (await pool.query(
    `SELECT invoices.*, customers.name AS customer_name, COALESCE(invoices.customer_number_snapshot, customers.customer_number) AS customer_number, customers.phone AS customer_phone,
            customers.whatsapp AS customer_whatsapp, customers.alternate_phone AS customer_alternate_phone, ${CUSTOMER_PATH_SQL} AS customer_path
     FROM invoices JOIN customers ON invoices.customer_id = customers.id
     ${CUSTOMER_PATH_JOINS}
     WHERE invoices.id = ANY($1::int[]) ORDER BY invoices.created_at DESC, invoices.id DESC`,
    [pageIds]
  )).rows : [];
  const zaad = await zaadStateFor(pageIds);
  for (const row of rows) {
    if (withBalance) row.balance = balances.get(row.id) || null;
    const z = zaad.get(row.id);
    row.zaad_in_progress = !!(z && z.in_progress);
    row.zaad_blocked_until = (z && z.blocked_until) || null;
  }
  const meta = { total: filtered.length, page, page_size: pageSize };
  if (withBalance) {
    const summary = { count: idRows.length, unpaid: 0, partial: 0, owed: { USD: 0, SLSH: 0 } };
    for (const r of idRows) {
      summary[r.status] += 1;
      summary.owed[r.currency] += balances.get(r.id)?.outstanding || 0;
    }
    meta.summary = summary;
  }
  return res.json({ data: rows, meta });
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
    const openMode = req.query.open === '1';
    if (req.query.status && !openMode) {
      params.push(req.query.status);
      where.push(`invoices.status = $${params.length}`);
    }
    if (req.query.customer_id) {
      const cid = parseStrictId(req.query.customer_id);
      if (cid === null) return res.status(400).json({ error: { message: 'Invalid customer_id filter.', code: 'VALIDATION' } });
      params.push(cid);
      where.push(`invoices.customer_id = $${params.length}`);
    }
    // P1 Functional Gaps — q search: invoice_number or the joined
    // customer's name/number. 2-char minimum, same ILIKE pattern already
    // used by Batches/Groups/Debts.
    if (req.query.q) {
      const q = req.query.q.trim();
      if (q.length >= 2) {
        params.push(`%${q}%`);
        const i = params.length;
        where.push(`(invoices.invoice_number ILIKE $${i} OR customers.name ILIKE $${i} OR customers.customer_number ILIKE $${i} OR invoices.customer_number_snapshot ILIKE $${i})`);
      }
    }
    if (openMode) return await listOpenInvoices(req, res, where, params);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT invoices.*, customers.name AS customer_name, COALESCE(invoices.customer_number_snapshot, customers.customer_number) AS customer_number, customers.phone AS customer_phone,
              customers.whatsapp AS customer_whatsapp, customers.alternate_phone AS customer_alternate_phone, ${CUSTOMER_PATH_SQL} AS customer_path
       FROM invoices JOIN customers ON invoices.customer_id = customers.id
       ${CUSTOMER_PATH_JOINS}
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
      `SELECT invoices.*, customers.name AS customer_name, COALESCE(invoices.customer_number_snapshot, customers.customer_number) AS customer_number, customers.phone AS customer_phone, customers.zone_id,
              customers.whatsapp AS customer_whatsapp, customers.alternate_phone AS customer_alternate_phone, customers.address_line AS customer_address,
              customers.door_number AS customer_door, customers.billing_type AS customer_billing_type, ${CUSTOMER_PATH_SQL} AS customer_path,
              COALESCE(cu.full_name, cu.username) AS created_by_name
       FROM invoices JOIN customers ON invoices.customer_id = customers.id
       ${CUSTOMER_PATH_JOINS}
       LEFT JOIN v2_users cu ON cu.id = invoices.created_by
       WHERE invoices.id = $1`,
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
      `SELECT p.id, p.amount, p.currency, p.method, p.amount_usd, p.status, p.reference_code, p.cashier_id, p.channel, p.created_at, p.reversed_at, p.reversed_reason,
              COALESCE(u.full_name, u.username) AS cashier_name
       FROM payments p LEFT JOIN v2_users u ON u.id = p.cashier_id WHERE p.invoice_id = $1 ORDER BY p.created_at ASC`,
      [id]
    );
    const debt = await pool.query(`SELECT * FROM debts WHERE invoice_id = $1`, [id]);
    // Letterhead contact block for the printed invoice (name/address/phone/
    // email from Settings > Company Information) — the full settings route
    // is admin-only, but every invoice viewer needs these on the paper copy.
    const co = (await pool.query('SELECT company_name, address, phone, email FROM company_settings WHERE id = 1').catch(() => ({ rows: [] }))).rows[0] || {};
    // Collection event (visit) date, when the invoice is linked to one.
    let visit = null;
    if (invoice.batch_customer_id) {
      const v = await pool.query(
        `SELECT bc.status, bc.status_at, b.batch_code FROM batch_customers bc LEFT JOIN batches b ON b.id = bc.batch_id WHERE bc.id = $1`,
        [invoice.batch_customer_id]
      ).catch(() => ({ rows: [] }));
      visit = v.rows[0] || null;
    }

    const zs = (await zaadStateFor([id])).get(id);
    const out = {
      ...invoice, balance, payments: payments.rows, debt: debt.rows[0] || null, visit,
      zaad_in_progress: !!(zs && zs.in_progress), zaad_blocked_until: (zs && zs.blocked_until) || null,
      company: { name: co.company_name || 'GURMAD', address: co.address || null, phone: co.phone || null, email: co.email || null },
    };
    if (invoice.billing_period) out.worked_days = await getWorkedDays(invoice.customer_id, invoice.billing_period, await autoBilling.getTimezone());
    res.json({ data: out });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load invoice.', code: 'INTERNAL' } });
  }
});

// Real, downloadable .docx of the invoice — additive only, same
// authorization boundary as the JSON detail route, per explicit request
// (Module 6 is CLOSED; this adds a new route only, no schema/API-shape
// change to any existing endpoint).
router.get('/:id/document.docx', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid invoice id.', code: 'VALIDATION' } });
  try {
    const invRes = await pool.query(
      `SELECT invoices.*, customers.name AS customer_name, COALESCE(invoices.customer_number_snapshot, customers.customer_number) AS customer_number, customers.zone_id
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
      `SELECT amount, currency, method, amount_usd, status, created_at FROM payments WHERE invoice_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    const worked_days = invoice.billing_period ? await getWorkedDays(invoice.customer_id, invoice.billing_period, await autoBilling.getTimezone()) : undefined;
    const buffer = await buildInvoiceDocx({ ...invoice, balance, payments: payments.rows, worked_days });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.invoice_number}.docx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to generate document.', code: 'INTERNAL' } });
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
        collector_name_snapshot, truck_name_snapshot, zone_name_snapshot, notes, created_by, customer_number_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,'unpaid',$7,$8,$9,$10,$11,(SELECT customer_number FROM customers WHERE id = $2)) RETURNING *`,
      [invoiceNumber, custId, bcId, total, discount, currency || 'USD',
        collector_name_snapshot || null, truck_name_snapshot || null, zone_name_snapshot || null, notes || null, req.user.id]
    );
    await client.query('COMMIT');
    const invoice = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'invoice.create', entityType: 'invoice', entityId: invoice.id, before: null, after: invoice });
    res.status(201).json({ data: invoice });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: { message: 'This collection event already has an invoice.', code: 'CONFLICT' } });
    console.error('invoice create failed:', err);
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
    // Debts V2: the auto-tracked debt mirrors this invoice's unpaid part — a
    // voided invoice is owed by nobody, so its open auto debt is closed as
    // written off (the Debts page tells users to void / adjust the invoice
    // instead of writing such a debt off by hand). Manual debts untouched.
    const closedDebts = await client.query(
      `UPDATE debts SET status = 'written_off', written_off_at = NOW(), written_off_by = $1, written_off_reason = $2, updated_at = NOW()
       WHERE invoice_id = $3 AND source = 'auto_invoice' AND status = 'unpaid' RETURNING *`,
      [req.user.id, `Invoice ${inv.invoice_number} voided: ${reason}`, id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'invoice.void', entityType: 'invoice', entityId: id, before: inv, after: updated.rows[0] });
    for (const d of closedDebts.rows) {
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'debt.write_off', entityType: 'debt', entityId: d.id, before: { status: 'unpaid', amount: d.amount, currency: d.currency }, after: { status: 'written_off', reason: d.written_off_reason, via: 'invoice.void' } });
    }
    // F3: voiding may clear a debt-suspended customer's balance (best-effort, never fails the void).
    await debtSuspension.afterPayment(inv.customer_id);
    res.json({ data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to void invoice.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// POST /bulk-generate — user-reported gap (Phase 10 Billing audit): every
// invoice previously had to be created one at a time, by hand, with no
// path from an actual serviced collection to a real invoice —
// batch_customer_id existed in the schema/detail view but nothing ever
// set it. This is the additive fix: given a batch, create one invoice
// per serviced customer in it that doesn't already have one, using that
// customer's on-file fee. Never overwrites/edits an existing invoice —
// a customer already invoiced for this batch, or missing a fee, is
// skipped and reported back, never silently guessed at.
router.post('/bulk-generate', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  const batchId = parseStrictId(String(req.body?.batch_id ?? ''));
  if (batchId === null) return res.status(400).json({ error: { message: 'A valid batch_id is required.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const batchRes = await client.query(
      `SELECT batches.*, zones.name AS zone_name FROM batches LEFT JOIN zones ON zones.id = batches.zone_id WHERE batches.id = $1`,
      [batchId]
    );
    if (batchRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Batch not found.', code: 'NOT_FOUND' } });
    }
    const batch = batchRes.rows[0];

    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && batch.zone_id !== myZoneId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'You do not have access to this batch.', code: 'FORBIDDEN' } });
    }

    // Every serviced customer in this batch not already invoiced for it —
    // the NOT EXISTS guard is what makes this endpoint safely re-runnable
    // (generate once, fix a missing fee, run again — only the gap fills in).
    const candidatesRes = await client.query(
      `SELECT bc.id AS batch_customer_id, c.id AS customer_id, c.name AS customer_name, c.fee, c.fee_currency, c.billing_type
       FROM batch_customers bc
       JOIN customers c ON c.id = bc.customer_id
       WHERE bc.batch_id = $1 AND bc.status = 'serviced'
         AND NOT EXISTS (SELECT 1 FROM invoices WHERE invoices.batch_customer_id = bc.id)
       ORDER BY bc.id ASC`,
      [batchId]
    );

    const created = [];
    const skippedNoFee = [];
    const skipped = [];
    for (const row of candidatesRes.rows) {
      if (row.billing_type === 'monthly') {
        skipped.push({ customer_id: row.customer_id, customer_name: row.customer_name, reason: 'monthly_customer' });
        continue;
      }
      if (row.fee === null || row.fee === undefined) {
        skippedNoFee.push({ customer_id: row.customer_id, customer_name: row.customer_name });
        continue;
      }
      const inv = await insertInvoice(client, { customerId: row.customer_id, batchCustomerId: row.batch_customer_id,
        total: row.fee, currency: row.fee_currency || 'USD', zoneNameSnapshot: batch.zone_name || null,
        notes: `Auto-generated from batch ${batch.batch_code}`, createdBy: req.user.id });
      if (inv) created.push(inv);
    }

    await client.query('COMMIT');
    for (const invoice of created) {
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'invoice.create', entityType: 'invoice', entityId: invoice.id, before: null, after: invoice });
    }
    res.status(201).json({ data: { created, skipped_no_fee: skippedNoFee, skipped, already_invoiced: candidatesRes.rowCount === 0 && created.length === 0 && skippedNoFee.length === 0 && skipped.length === 0 } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: { message: 'One of these visits was invoiced concurrently (possibly by auto-billing). Please retry.', code: 'CONFLICT' } });
    console.error('bulk invoice generation failed:', err);
    res.status(500).json({ error: { message: 'Failed to generate invoices.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

module.exports = router;
