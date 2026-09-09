const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  calculatePOLineTotal, calculatePOTotal, calculateReceivedQuantity,
  calculateRemainingQuantity, calculateReceiptStatus, calculateOverDeliveryFlag,
} = require('../lib/procurementCalculations');

const router = express.Router();

// Master Functional Completion Program — Phase 3: Procurement.
// Per GURMAD_V2_Phase3_Procurement_Implementation_Specification.md.
// Zone-scoping extends the per-file ZONE_SCOPED_ROLES pattern (a new,
// independent copy local to this file, matching how every other route
// file already defines its own — not a shared/modified constant) to
// include head_of_cashiers/cashier, since Procurement needs own-zone
// resolution for those two roles for the first time in this engagement.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier'];
const SUBMIT_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier'];
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier'];
const APPROVE_ROLES = ['admin', 'gudoomiye'];
const PO_ROLES = ['admin', 'gudoomiye'];
const SUPPLIER_WRITE_ROLES = ['admin'];

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

async function generateRequestNumber(client) {
  const seq = await client.query(`SELECT nextval('procurement_request_number_seq') AS n`);
  return `PR-${String(Number(seq.rows[0].n)).padStart(6, '0')}`;
}
async function generatePoNumber(client) {
  const seq = await client.query(`SELECT nextval('purchase_order_number_seq') AS n`);
  return `PO-${String(Number(seq.rows[0].n)).padStart(6, '0')}`;
}

function validateItemsPayload(items, { priceField }) {
  if (!Array.isArray(items) || items.length === 0) return 'At least one item is required.';
  for (const item of items) {
    if (!item.item_name || !String(item.item_name).trim()) return 'Each item requires an item_name.';
    const qty = parseInt(item.quantity, 10);
    if (isNaN(qty) || qty <= 0) return 'Each item quantity must be a positive integer.';
    const price = parseFloat(item[priceField]);
    if (item[priceField] !== undefined && (isNaN(price) || price < 0)) return `Each item ${priceField} must be >= 0.`;
  }
  return null;
}

// ============================================================
// Suppliers
// ============================================================

router.get('/suppliers', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const params = [];
    const filters = [];
    if (req.query.status) { params.push(req.query.status); filters.push(`status = $${params.length}`); }
    if (req.query.q) {
      const q = req.query.q.trim();
      if (q.length >= 2) {
        params.push(`%${q}%`);
        const i = params.length;
        filters.push(`(name ILIKE $${i} OR contact ILIKE $${i} OR category ILIKE $${i})`);
      }
    }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(`SELECT * FROM suppliers ${whereSql} ORDER BY name ASC`, params);
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list suppliers.', code: 'INTERNAL' } });
  }
});

router.get('/suppliers/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid supplier id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query('SELECT * FROM suppliers WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Supplier not found.', code: 'NOT_FOUND' } });
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load supplier.', code: 'INTERNAL' } });
  }
});

router.post('/suppliers', authenticateToken, requireRole(...SUPPLIER_WRITE_ROLES), async (req, res) => {
  const { name, contact, phone, email, address, category } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: { message: 'name is required.', code: 'VALIDATION' } });
  try {
    const inserted = await pool.query(
      `INSERT INTO suppliers (name, contact, phone, email, address, category) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [String(name).trim(), contact || null, phone || null, email || null, address || null, category || null]
    );
    const supplier = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'supplier.create', entityType: 'supplier', entityId: supplier.id, before: null, after: supplier });
    res.status(201).json({ data: supplier });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to create supplier.', code: 'INTERNAL' } });
  }
});

router.put('/suppliers/:id', authenticateToken, requireRole(...SUPPLIER_WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid supplier id.', code: 'VALIDATION' } });
  const { name, contact, phone, email, address, category } = req.body;
  try {
    const before = await pool.query('SELECT * FROM suppliers WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Supplier not found.', code: 'NOT_FOUND' } });
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: { message: 'name cannot be empty.', code: 'VALIDATION' } });
    const updated = await pool.query(
      `UPDATE suppliers SET name = COALESCE($1, name), contact = $2, phone = $3, email = $4, address = $5, category = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 RETURNING *`,
      [name ? String(name).trim() : null, contact ?? before.rows[0].contact, phone ?? before.rows[0].phone,
       email ?? before.rows[0].email, address ?? before.rows[0].address, category ?? before.rows[0].category, id]
    );
    const supplier = updated.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'supplier.edit', entityType: 'supplier', entityId: id, before: before.rows[0], after: supplier });
    res.json({ data: supplier });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update supplier.', code: 'INTERNAL' } });
  }
});

router.put('/suppliers/:id/status', authenticateToken, requireRole(...SUPPLIER_WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid supplier id.', code: 'VALIDATION' } });
  const { status } = req.body;
  if (!['active', 'inactive'].includes(status)) return res.status(400).json({ error: { message: "status must be 'active' or 'inactive'.", code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM suppliers WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Supplier not found.', code: 'NOT_FOUND' } });
    const updated = await pool.query('UPDATE suppliers SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *', [status, id]);
    const supplier = updated.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'supplier.status_change', entityType: 'supplier', entityId: id, before: before.rows[0], after: supplier });
    res.json({ data: supplier });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update supplier status.', code: 'INTERNAL' } });
  }
});

// No DELETE route exists for suppliers, ever — per Decision 13.

// ============================================================
// Procurement Requests
// ============================================================

async function loadRequestWithAccessCheck(user, requestId, client = pool) {
  const r = await client.query('SELECT * FROM procurement_requests WHERE id = $1', [requestId]);
  if (r.rows.length === 0) return { error: { status: 404, message: 'Procurement request not found.', code: 'NOT_FOUND' } };
  const request = r.rows[0];
  const myZoneId = await resolveUserZoneId(user);
  if (myZoneId !== null && request.zone_id !== myZoneId) {
    return { error: { status: 403, message: 'You do not have access to this procurement request.', code: 'FORBIDDEN' } };
  }
  return { request };
}

router.post('/requests', authenticateToken, requireRole(...SUBMIT_ROLES), async (req, res) => {
  const { zone_id, priority, reason, items } = req.body;
  const role = (req.user.role || '').toLowerCase();
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: { message: 'reason is required.', code: 'VALIDATION' } });
  const pri = priority && ['low', 'normal', 'high'].includes(priority) ? priority : 'normal';
  const itemsError = validateItemsPayload(items, { priceField: 'estimated_unit_price' });
  if (itemsError) return res.status(400).json({ error: { message: itemsError, code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let targetZoneId;
    if (role === 'admin') {
      const zid = parseStrictId(zone_id);
      if (zid === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: { message: 'zone_id is required for Admin.', code: 'VALIDATION' } }); }
      const zoneRes = await client.query('SELECT id FROM zones WHERE id = $1', [zid]);
      if (zoneRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: { message: 'Invalid zone_id.', code: 'VALIDATION' } }); }
      targetZoneId = zid;
    } else {
      // Non-admin zone is ALWAYS server-resolved — any client-supplied
      // zone_id is never read for this branch at all.
      targetZoneId = await resolveUserZoneId(req.user);
      if (targetZoneId === null) { await client.query('ROLLBACK'); return res.status(403).json({ error: { message: 'Your account has no resolvable zone.', code: 'FORBIDDEN' } }); }
    }

    const requestNumber = await generateRequestNumber(client);
    const inserted = await client.query(
      `INSERT INTO procurement_requests (request_number, zone_id, requested_by, priority, reason)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [requestNumber, targetZoneId, req.user.id, pri, String(reason).trim()]
    );
    const request = inserted.rows[0];
    const insertedItems = [];
    for (const item of items) {
      const itemRes = await client.query(
        `INSERT INTO procurement_request_items (procurement_request_id, item_name, quantity, estimated_unit_price, notes)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [request.id, String(item.item_name).trim(), parseInt(item.quantity, 10), parseFloat(item.estimated_unit_price ?? 0), item.notes || null]
      );
      insertedItems.push(itemRes.rows[0]);
    }
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'request.create', entityType: 'procurement_request', entityId: request.id, before: null, after: request });
    res.status(201).json({ data: { ...request, items: insertedItems } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to create procurement request.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.get('/requests', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const params = [];
    const filters = [];
    if (myZoneId !== null) { params.push(myZoneId); filters.push(`pr.zone_id = $${params.length}`); }
    if (req.query.zone_id && myZoneId === null) {
      const zid = parseStrictId(req.query.zone_id);
      if (zid === null) return res.status(400).json({ error: { message: 'Invalid zone_id.', code: 'VALIDATION' } });
      params.push(zid); filters.push(`pr.zone_id = $${params.length}`);
    }
    if (req.query.status) { params.push(req.query.status); filters.push(`pr.status = $${params.length}`); }
    if (req.query.priority) { params.push(req.query.priority); filters.push(`pr.priority = $${params.length}`); }
    if (req.query.q) {
      const q = req.query.q.trim();
      if (q.length >= 2) { params.push(`%${q}%`); const i = params.length; filters.push(`(pr.request_number ILIKE $${i} OR pr.reason ILIKE $${i})`); }
    }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT pr.*, z.name AS zone_name FROM procurement_requests pr JOIN zones z ON pr.zone_id = z.id ${whereSql} ORDER BY pr.created_at DESC`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list procurement requests.', code: 'INTERNAL' } });
  }
});

router.get('/requests/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid request id.', code: 'VALIDATION' } });
  try {
    const access = await loadRequestWithAccessCheck(req.user, id);
    if (access.error) return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } });
    const items = await pool.query('SELECT * FROM procurement_request_items WHERE procurement_request_id = $1 ORDER BY id ASC', [id]);
    res.json({ data: { ...access.request, items: items.rows } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load procurement request.', code: 'INTERNAL' } });
  }
});

// PUT /:id — edit while pending. Per the Final Implementation
// Authorization's Business Decision 3: the requester themselves, OR an
// authorized approver (Admin company-wide / Gudoomiye own-zone) may
// edit — not only Admin/Gudoomiye as originally specified. Zone
// re-assignment is never permitted for a non-admin caller (the zone_id
// field is simply not accepted from any non-admin edit at all).
router.put('/requests/:id', authenticateToken, requireRole(...SUBMIT_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid request id.', code: 'VALIDATION' } });
  const { priority, reason, items } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT * FROM procurement_requests WHERE id = $1 FOR UPDATE', [id]);
    if (before.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Procurement request not found.', code: 'NOT_FOUND' } }); }
    const request = before.rows[0];
    if (request.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: `Request is already ${request.status} and cannot be edited.`, code: 'CONFLICT' } }); }

    const role = (req.user.role || '').toLowerCase();
    const myZoneId = await resolveUserZoneId(req.user);
    const isOwnRequest = request.requested_by === req.user.id;
    const isAuthorizedApprover = APPROVE_ROLES.includes(role) && (myZoneId === null || request.zone_id === myZoneId);
    if (!isOwnRequest && !isAuthorizedApprover) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'Only the requester or an authorized approver may edit this request.', code: 'FORBIDDEN' } });
    }
    // Redundant explicit re-check: a non-admin caller can never move a
    // request to a different zone — no zone_id field is accepted here
    // at all, own-request or approver edit alike.
    if (myZoneId !== null && request.zone_id !== myZoneId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'You do not have access to this procurement request.', code: 'FORBIDDEN' } });
    }

    const pri = priority && ['low', 'normal', 'high'].includes(priority) ? priority : request.priority;
    const reasonVal = reason !== undefined ? String(reason).trim() : request.reason;
    if (!reasonVal) { await client.query('ROLLBACK'); return res.status(400).json({ error: { message: 'reason cannot be empty.', code: 'VALIDATION' } }); }

    let itemRows = null;
    if (items !== undefined) {
      const itemsError = validateItemsPayload(items, { priceField: 'estimated_unit_price' });
      if (itemsError) { await client.query('ROLLBACK'); return res.status(400).json({ error: { message: itemsError, code: 'VALIDATION' } }); }
      await client.query('DELETE FROM procurement_request_items WHERE procurement_request_id = $1', [id]);
      itemRows = [];
      for (const item of items) {
        const itemRes = await client.query(
          `INSERT INTO procurement_request_items (procurement_request_id, item_name, quantity, estimated_unit_price, notes)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [id, String(item.item_name).trim(), parseInt(item.quantity, 10), parseFloat(item.estimated_unit_price ?? 0), item.notes || null]
        );
        itemRows.push(itemRes.rows[0]);
      }
    }

    const updated = await client.query(
      `UPDATE procurement_requests SET priority = $1, reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [pri, reasonVal, id]
    );
    await client.query('COMMIT');
    const record = updated.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'request.update', entityType: 'procurement_request', entityId: id, before: request, after: record });
    const finalItems = itemRows ?? (await pool.query('SELECT * FROM procurement_request_items WHERE procurement_request_id = $1', [id])).rows;
    res.json({ data: { ...record, items: finalItems } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to update procurement request.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.put('/requests/:id/status', authenticateToken, requireRole(...APPROVE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid request id.', code: 'VALIDATION' } });
  const { status } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: { message: "status must be 'approved' or 'rejected'.", code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM procurement_requests WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Procurement request not found.', code: 'NOT_FOUND' } });
    const request = before.rows[0];
    if (request.status !== 'pending') return res.status(409).json({ error: { message: `Request is already ${request.status}.`, code: 'CONFLICT' } });

    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && request.zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this procurement request.', code: 'FORBIDDEN' } });
    }
    // Self-approval / self-rejection — hard-blocked, unconditionally,
    // regardless of role. Per the Final Implementation Authorization's
    // Business Decision 2.
    if (request.requested_by === req.user.id) {
      return res.status(403).json({ error: { message: 'You cannot approve or reject your own procurement request.', code: 'FORBIDDEN' } });
    }

    const updated = await pool.query(
      `UPDATE procurement_requests SET status = $1, approved_by = $2, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [status, req.user.id, id]
    );
    const record = updated.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: `request.${status}`, entityType: 'procurement_request', entityId: id, before: request, after: record });
    res.json({ data: record });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update request status.', code: 'INTERNAL' } });
  }
});

router.put('/requests/:id/cancel', authenticateToken, requireRole(...SUBMIT_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid request id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'A reason is required to cancel a procurement request.', code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM procurement_requests WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Procurement request not found.', code: 'NOT_FOUND' } });
    const request = before.rows[0];
    if (request.status !== 'pending') return res.status(409).json({ error: { message: `Request is already ${request.status}.`, code: 'CONFLICT' } });

    const role = (req.user.role || '').toLowerCase();
    const myZoneId = await resolveUserZoneId(req.user);
    const isOwnRequest = request.requested_by === req.user.id;
    const isAuthorizedApprover = APPROVE_ROLES.includes(role) && (myZoneId === null || request.zone_id === myZoneId);
    if (!isOwnRequest && !isAuthorizedApprover) {
      return res.status(403).json({ error: { message: 'You do not have access to cancel this procurement request.', code: 'FORBIDDEN' } });
    }
    if (myZoneId !== null && request.zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this procurement request.', code: 'FORBIDDEN' } });
    }

    const updated = await pool.query(
      `UPDATE procurement_requests SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
      [id]
    );
    const record = updated.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'request.cancel', entityType: 'procurement_request', entityId: id, before: request, after: { ...record, cancellation_reason: reason } });
    res.json({ data: record });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to cancel procurement request.', code: 'INTERNAL' } });
  }
});

// ============================================================
// Purchase Orders
// ============================================================

async function loadPoWithAccessCheck(user, poId, client = pool) {
  const r = await client.query(
    `SELECT po.*, pr.zone_id AS request_zone_id FROM purchase_orders po
     JOIN procurement_requests pr ON po.procurement_request_id = pr.id WHERE po.id = $1`,
    [poId]
  );
  if (r.rows.length === 0) return { error: { status: 404, message: 'Purchase order not found.', code: 'NOT_FOUND' } };
  const po = r.rows[0];
  const myZoneId = await resolveUserZoneId(user);
  if (myZoneId !== null && po.request_zone_id !== myZoneId) {
    return { error: { status: 403, message: 'You do not have access to this purchase order.', code: 'FORBIDDEN' } };
  }
  return { po };
}

router.post('/purchase-orders', authenticateToken, requireRole(...PO_ROLES), async (req, res) => {
  const { procurement_request_id, supplier_id, items } = req.body;
  const requestId = parseStrictId(procurement_request_id);
  const supplierId = parseStrictId(supplier_id);
  if (requestId === null) return res.status(400).json({ error: { message: 'procurement_request_id is required.', code: 'VALIDATION' } });
  if (supplierId === null) return res.status(400).json({ error: { message: 'supplier_id is required.', code: 'VALIDATION' } });
  const itemsError = validateItemsPayload(items, { priceField: 'unit_price' });
  if (itemsError) return res.status(400).json({ error: { message: itemsError, code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reqRes = await client.query('SELECT * FROM procurement_requests WHERE id = $1', [requestId]);
    if (reqRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Procurement request not found.', code: 'NOT_FOUND' } }); }
    const request = reqRes.rows[0];
    if (request.status !== 'approved') { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: 'A purchase order can only be created from an approved procurement request.', code: 'CONFLICT' } }); }
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && request.zone_id !== myZoneId) { await client.query('ROLLBACK'); return res.status(403).json({ error: { message: 'You do not have access to this procurement request.', code: 'FORBIDDEN' } }); }

    const supplierRes = await client.query('SELECT * FROM suppliers WHERE id = $1', [supplierId]);
    if (supplierRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Supplier not found.', code: 'NOT_FOUND' } }); }
    // Final Implementation Authorization, Business Decision 1: a new PO
    // may only be created against an ACTIVE supplier.
    if (supplierRes.rows[0].status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'This supplier is inactive and cannot receive new purchase orders.', code: 'CONFLICT' } });
    }

    // Cross-request reference prevention (Spec §5.5).
    for (const item of items) {
      if (item.procurement_request_item_id !== undefined && item.procurement_request_item_id !== null) {
        const rid = parseStrictId(item.procurement_request_item_id);
        if (rid === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: { message: 'Invalid procurement_request_item_id.', code: 'VALIDATION' } }); }
        const linkRes = await client.query('SELECT procurement_request_id FROM procurement_request_items WHERE id = $1', [rid]);
        if (linkRes.rows.length === 0 || linkRes.rows[0].procurement_request_id !== requestId) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: { message: 'procurement_request_item_id does not belong to this procurement request.', code: 'VALIDATION' } });
        }
      }
    }

    const poNumber = await generatePoNumber(client);
    const totalAmount = calculatePOTotal(items);
    const insertedPo = await client.query(
      `INSERT INTO purchase_orders (po_number, procurement_request_id, supplier_id, total_amount, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [poNumber, requestId, supplierId, totalAmount, req.user.id]
    );
    const po = insertedPo.rows[0];
    const insertedItems = [];
    for (const item of items) {
      const lineTotal = calculatePOLineTotal(item.quantity, item.unit_price);
      const itemRes = await client.query(
        `INSERT INTO purchase_order_items (purchase_order_id, procurement_request_item_id, item_name, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [po.id, item.procurement_request_item_id || null, String(item.item_name).trim(), parseInt(item.quantity, 10), parseFloat(item.unit_price), lineTotal]
      );
      insertedItems.push(itemRes.rows[0]);
    }
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'PO.create', entityType: 'purchase_order', entityId: po.id, before: null, after: po });
    res.status(201).json({ data: { ...po, items: insertedItems } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to create purchase order.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.get('/purchase-orders', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const params = [];
    const filters = [];
    if (myZoneId !== null) { params.push(myZoneId); filters.push(`pr.zone_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); filters.push(`po.status = $${params.length}`); }
    if (req.query.supplier_id) {
      const sid = parseStrictId(req.query.supplier_id);
      if (sid === null) return res.status(400).json({ error: { message: 'Invalid supplier_id.', code: 'VALIDATION' } });
      params.push(sid); filters.push(`po.supplier_id = $${params.length}`);
    }
    if (req.query.procurement_request_id) {
      const rid = parseStrictId(req.query.procurement_request_id);
      if (rid === null) return res.status(400).json({ error: { message: 'Invalid procurement_request_id.', code: 'VALIDATION' } });
      params.push(rid); filters.push(`po.procurement_request_id = $${params.length}`);
    }
    if (req.query.q) {
      const q = req.query.q.trim();
      if (q.length >= 2) { params.push(`%${q}%`); filters.push(`po.po_number ILIKE $${params.length}`); }
    }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT po.*, s.name AS supplier_name, pr.request_number, pr.zone_id
       FROM purchase_orders po
       JOIN suppliers s ON po.supplier_id = s.id
       JOIN procurement_requests pr ON po.procurement_request_id = pr.id
       ${whereSql} ORDER BY po.created_at DESC`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list purchase orders.', code: 'INTERNAL' } });
  }
});

router.get('/purchase-orders/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid purchase order id.', code: 'VALIDATION' } });
  try {
    const access = await loadPoWithAccessCheck(req.user, id);
    if (access.error) return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } });
    const itemsRes = await pool.query('SELECT * FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY id ASC', [id]);
    const items = [];
    for (const item of itemsRes.rows) {
      const received = await calculateReceivedQuantity(item.id);
      const remaining = item.quantity - received;
      items.push({ ...item, received_quantity: received, remaining_quantity: remaining, needs_review: calculateOverDeliveryFlag(received, item.quantity) });
    }
    const supplier = await pool.query('SELECT id, name, status FROM suppliers WHERE id = $1', [access.po.supplier_id]);
    res.json({ data: { ...access.po, supplier: supplier.rows[0], items } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load purchase order.', code: 'INTERNAL' } });
  }
});

router.put('/purchase-orders/:id', authenticateToken, requireRole(...PO_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid purchase order id.', code: 'VALIDATION' } });
  const { items } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const access = await loadPoWithAccessCheck(req.user, id, client);
    if (access.error) { await client.query('ROLLBACK'); return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } }); }
    if (access.po.status !== 'draft') { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: 'Purchase order can only be edited while in draft status.', code: 'CONFLICT' } }); }
    const itemsError = validateItemsPayload(items, { priceField: 'unit_price' });
    if (itemsError) { await client.query('ROLLBACK'); return res.status(400).json({ error: { message: itemsError, code: 'VALIDATION' } }); }

    await client.query('DELETE FROM purchase_order_items WHERE purchase_order_id = $1', [id]);
    const insertedItems = [];
    for (const item of items) {
      const lineTotal = calculatePOLineTotal(item.quantity, item.unit_price);
      const itemRes = await client.query(
        `INSERT INTO purchase_order_items (purchase_order_id, procurement_request_item_id, item_name, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, item.procurement_request_item_id || null, String(item.item_name).trim(), parseInt(item.quantity, 10), parseFloat(item.unit_price), lineTotal]
      );
      insertedItems.push(itemRes.rows[0]);
    }
    const totalAmount = calculatePOTotal(items);
    const updated = await client.query(`UPDATE purchase_orders SET total_amount = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`, [totalAmount, id]);
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'PO.update', entityType: 'purchase_order', entityId: id, before: access.po, after: updated.rows[0] });
    res.json({ data: { ...updated.rows[0], items: insertedItems } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to update purchase order.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.put('/purchase-orders/:id/order', authenticateToken, requireRole(...PO_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid purchase order id.', code: 'VALIDATION' } });
  try {
    const access = await loadPoWithAccessCheck(req.user, id);
    if (access.error) return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } });
    if (access.po.status !== 'draft') return res.status(409).json({ error: { message: 'Only a draft purchase order can be ordered.', code: 'CONFLICT' } });
    const updated = await pool.query(`UPDATE purchase_orders SET status = 'ordered', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [id]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'PO.order', entityType: 'purchase_order', entityId: id, before: access.po, after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to order purchase order.', code: 'INTERNAL' } });
  }
});

router.put('/purchase-orders/:id/cancel', authenticateToken, requireRole(...PO_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid purchase order id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'A reason is required to cancel a purchase order.', code: 'VALIDATION' } });
  try {
    const access = await loadPoWithAccessCheck(req.user, id);
    if (access.error) return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } });
    if (!['draft', 'ordered', 'partially_received'].includes(access.po.status)) {
      return res.status(409).json({ error: { message: `Purchase order is ${access.po.status} and cannot be cancelled.`, code: 'CONFLICT' } });
    }
    const updated = await pool.query(`UPDATE purchase_orders SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`, [id]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'PO.cancel', entityType: 'purchase_order', entityId: id, before: access.po, after: { ...updated.rows[0], cancellation_reason: reason } });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to cancel purchase order.', code: 'INTERNAL' } });
  }
});

// ============================================================
// Receiving
// ============================================================

router.post('/purchase-orders/:id/receipts', authenticateToken, requireRole(...PO_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid purchase order id.', code: 'VALIDATION' } });
  const { notes, items } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: { message: 'At least one receipt line is required.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Step 2: lock the parent PO row first — legacy's own proven
    // pattern, reused verbatim.
    const poRes = await client.query(
      `SELECT po.*, pr.zone_id AS request_zone_id FROM purchase_orders po
       JOIN procurement_requests pr ON po.procurement_request_id = pr.id WHERE po.id = $1 FOR UPDATE`,
      [id]
    );
    if (poRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Purchase order not found.', code: 'NOT_FOUND' } }); }
    const po = poRes.rows[0];
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && po.request_zone_id !== myZoneId) { await client.query('ROLLBACK'); return res.status(403).json({ error: { message: 'You do not have access to this purchase order.', code: 'FORBIDDEN' } }); }
    if (!['ordered', 'partially_received'].includes(po.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: `Purchase order is ${po.status} and cannot receive goods.`, code: 'CONFLICT' } });
    }

    // Step 4/5: load PO items, validate every submitted line references
    // an item belonging to THIS PO (cross-PO reference prevention).
    const poItems = (await client.query('SELECT * FROM purchase_order_items WHERE purchase_order_id = $1', [id])).rows;
    const poItemIds = new Set(poItems.map((i) => i.id));
    for (const line of items) {
      const poItemId = parseStrictId(line.purchase_order_item_id);
      if (poItemId === null || !poItemIds.has(poItemId)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: { message: 'purchase_order_item_id must reference an item on this purchase order.', code: 'VALIDATION' } });
      }
      const qty = parseInt(line.quantity_received, 10);
      if (isNaN(qty) || qty <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: { message: 'quantity_received must be a positive integer.', code: 'VALIDATION' } });
      }
    }
    // Over-delivery is permitted — no rejection here (Decision 7).

    const receiptRes = await client.query(
      `INSERT INTO purchase_order_receipts (purchase_order_id, received_by, notes) VALUES ($1,$2,$3) RETURNING *`,
      [id, req.user.id, notes || null]
    );
    const receipt = receiptRes.rows[0];
    const insertedItems = [];
    for (const line of items) {
      const itemRes = await client.query(
        `INSERT INTO purchase_order_receipt_items (purchase_order_receipt_id, purchase_order_item_id, quantity_received)
         VALUES ($1,$2,$3) RETURNING *`,
        [receipt.id, parseStrictId(line.purchase_order_item_id), parseInt(line.quantity_received, 10)]
      );
      insertedItems.push(itemRes.rows[0]);
    }

    const newStatus = await calculateReceiptStatus(id, client);
    const updatedPo = await client.query(
      `UPDATE purchase_orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [newStatus, id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'receipt.create', entityType: 'purchase_order_receipt', entityId: receipt.id, before: null, after: { receipt, items: insertedItems } });
    res.status(201).json({ data: { receipt, items: insertedItems, purchase_order: updatedPo.rows[0] } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to record purchase order receipt.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.get('/purchase-orders/:id/receipts', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid purchase order id.', code: 'VALIDATION' } });
  try {
    const access = await loadPoWithAccessCheck(req.user, id);
    if (access.error) return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } });
    const receipts = await pool.query('SELECT * FROM purchase_order_receipts WHERE purchase_order_id = $1 ORDER BY received_at ASC', [id]);
    const result = [];
    for (const receipt of receipts.rows) {
      const items = await pool.query(
        `SELECT ri.*, poi.item_name, poi.quantity AS ordered_quantity FROM purchase_order_receipt_items ri
         JOIN purchase_order_items poi ON ri.purchase_order_item_id = poi.id WHERE ri.purchase_order_receipt_id = $1`,
        [receipt.id]
      );
      const annotated = [];
      for (const item of items.rows) {
        const received = await calculateReceivedQuantity(item.purchase_order_item_id);
        annotated.push({ ...item, needs_review: calculateOverDeliveryFlag(received, item.ordered_quantity) });
      }
      result.push({ ...receipt, items: annotated });
    }
    res.json({ data: result });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list purchase order receipts.', code: 'INTERNAL' } });
  }
});

router.get('/purchase-orders/:id/receipts/:receiptId', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  const receiptId = parseStrictId(req.params.receiptId);
  if (id === null || receiptId === null) return res.status(400).json({ error: { message: 'Invalid id.', code: 'VALIDATION' } });
  try {
    const access = await loadPoWithAccessCheck(req.user, id);
    if (access.error) return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } });
    const receipt = await pool.query('SELECT * FROM purchase_order_receipts WHERE id = $1 AND purchase_order_id = $2', [receiptId, id]);
    if (receipt.rows.length === 0) return res.status(404).json({ error: { message: 'Receipt not found.', code: 'NOT_FOUND' } });
    const items = await pool.query(
      `SELECT ri.*, poi.item_name, poi.quantity AS ordered_quantity FROM purchase_order_receipt_items ri
       JOIN purchase_order_items poi ON ri.purchase_order_item_id = poi.id WHERE ri.purchase_order_receipt_id = $1`,
      [receiptId]
    );
    res.json({ data: { ...receipt.rows[0], items: items.rows } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load receipt.', code: 'INTERNAL' } });
  }
});

module.exports = router;
