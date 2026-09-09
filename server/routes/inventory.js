const express = require('express');
const crypto = require('crypto');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { calculateStockBalance, calculateStoreStock, calculateItemStock, calculateLowStock } = require('../lib/inventoryCalculations');

const router = express.Router();

// Master Functional Completion Program — Phase 4: Inventory & Assets.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier'];
const OPERATE_ROLES = ['admin', 'gudoomiye'];
const ADMIN_ONLY = ['admin'];
const MOVEMENT_TYPES = ['opening_balance', 'receipt', 'issue', 'transfer_out', 'transfer_in', 'adjustment', 'return'];

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

async function loadStoreWithAccessCheck(user, storeId, client = pool) {
  const r = await client.query('SELECT * FROM inventory_stores WHERE id = $1', [storeId]);
  if (r.rows.length === 0) return { error: { status: 404, message: 'Store not found.', code: 'NOT_FOUND' } };
  const store = r.rows[0];
  const myZoneId = await resolveUserZoneId(user);
  if (myZoneId !== null && store.zone_id !== null && store.zone_id !== myZoneId) {
    return { error: { status: 403, message: 'You do not have access to this store.', code: 'FORBIDDEN' } };
  }
  // A Gudoomiye may act on a company-wide store (zone_id IS NULL) —
  // no restriction found or added for that case (matches every other
  // module's own nullable-zone-is-accessible-to-all precedent).
  return { store };
}

// ============================================================
// Items
// ============================================================

router.get('/items', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const params = [];
    const filters = [];
    if (req.query.status) { params.push(req.query.status); filters.push(`status = $${params.length}`); }
    if (req.query.q) {
      const q = req.query.q.trim();
      if (q.length >= 2) {
        params.push(`%${q}%`);
        const i = params.length;
        filters.push(`(name ILIKE $${i} OR sku ILIKE $${i} OR category ILIKE $${i})`);
      }
    }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(`SELECT * FROM inventory_items ${whereSql} ORDER BY name ASC`, params);
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list items.', code: 'INTERNAL' } });
  }
});

router.get('/items/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid item id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query('SELECT * FROM inventory_items WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Item not found.', code: 'NOT_FOUND' } });
    const stock = await calculateItemStock(id);
    res.json({ data: { ...result.rows[0], stock } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load item.', code: 'INTERNAL' } });
  }
});

router.post('/items', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const { sku, name, category, unit_of_measure, description, reorder_level } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: { message: 'name is required.', code: 'VALIDATION' } });
  if (!unit_of_measure || !String(unit_of_measure).trim()) return res.status(400).json({ error: { message: 'unit_of_measure is required.', code: 'VALIDATION' } });
  if (reorder_level !== undefined && reorder_level !== null && (isNaN(parseInt(reorder_level, 10)) || parseInt(reorder_level, 10) < 0)) {
    return res.status(400).json({ error: { message: 'reorder_level must be a non-negative integer.', code: 'VALIDATION' } });
  }
  try {
    const inserted = await pool.query(
      `INSERT INTO inventory_items (sku, name, category, unit_of_measure, description, reorder_level) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [sku || null, String(name).trim(), category || null, String(unit_of_measure).trim(), description || null, reorder_level != null ? parseInt(reorder_level, 10) : null]
    );
    const item = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_item.create', entityType: 'inventory_item', entityId: item.id, before: null, after: item });
    res.status(201).json({ data: item });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'An item with this SKU already exists.', code: 'CONFLICT' } });
    res.status(500).json({ error: { message: 'Failed to create item.', code: 'INTERNAL' } });
  }
});

router.put('/items/:id', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid item id.', code: 'VALIDATION' } });
  const { sku, name, category, unit_of_measure, description, reorder_level } = req.body;
  try {
    const before = await pool.query('SELECT * FROM inventory_items WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Item not found.', code: 'NOT_FOUND' } });
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: { message: 'name cannot be empty.', code: 'VALIDATION' } });
    if (unit_of_measure !== undefined && !String(unit_of_measure).trim()) return res.status(400).json({ error: { message: 'unit_of_measure cannot be empty.', code: 'VALIDATION' } });
    const updated = await pool.query(
      `UPDATE inventory_items SET sku = $1, name = COALESCE($2, name), category = $3, unit_of_measure = COALESCE($4, unit_of_measure),
         description = $5, reorder_level = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7 RETURNING *`,
      [sku !== undefined ? sku : before.rows[0].sku, name ? String(name).trim() : null, category !== undefined ? category : before.rows[0].category,
       unit_of_measure ? String(unit_of_measure).trim() : null, description !== undefined ? description : before.rows[0].description,
       reorder_level !== undefined ? (reorder_level != null ? parseInt(reorder_level, 10) : null) : before.rows[0].reorder_level, id]
    );
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_item.edit', entityType: 'inventory_item', entityId: id, before: before.rows[0], after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'An item with this SKU already exists.', code: 'CONFLICT' } });
    res.status(500).json({ error: { message: 'Failed to update item.', code: 'INTERNAL' } });
  }
});

router.put('/items/:id/status', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid item id.', code: 'VALIDATION' } });
  const { status } = req.body;
  if (!['active', 'inactive'].includes(status)) return res.status(400).json({ error: { message: "status must be 'active' or 'inactive'.", code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM inventory_items WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Item not found.', code: 'NOT_FOUND' } });
    const updated = await pool.query('UPDATE inventory_items SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *', [status, id]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_item.status_change', entityType: 'inventory_item', entityId: id, before: before.rows[0], after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update item status.', code: 'INTERNAL' } });
  }
});

// ============================================================
// Stores
// ============================================================

router.get('/stores', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const params = [];
    const filters = [];
    if (myZoneId !== null) { params.push(myZoneId); filters.push(`(zone_id = $${params.length} OR zone_id IS NULL)`); }
    if (req.query.status) { params.push(req.query.status); filters.push(`status = $${params.length}`); }
    if (req.query.q) {
      const q = req.query.q.trim();
      if (q.length >= 2) { params.push(`%${q}%`); filters.push(`name ILIKE $${params.length}`); }
    }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(`SELECT s.*, z.name AS zone_name FROM inventory_stores s LEFT JOIN zones z ON s.zone_id = z.id ${whereSql} ORDER BY s.name ASC`, params);
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list stores.', code: 'INTERNAL' } });
  }
});

router.get('/stores/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid store id.', code: 'VALIDATION' } });
  try {
    const access = await loadStoreWithAccessCheck(req.user, id);
    if (access.error) return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } });
    const stock = await calculateStoreStock(id);
    res.json({ data: { ...access.store, stock } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load store.', code: 'INTERNAL' } });
  }
});

router.post('/stores', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const { name, zone_id } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: { message: 'name is required.', code: 'VALIDATION' } });
  let zoneId = null;
  if (zone_id !== undefined && zone_id !== null && zone_id !== '') {
    zoneId = parseStrictId(zone_id);
    if (zoneId === null) return res.status(400).json({ error: { message: 'Invalid zone_id.', code: 'VALIDATION' } });
    const zoneRes = await pool.query('SELECT id FROM zones WHERE id = $1', [zoneId]);
    if (zoneRes.rows.length === 0) return res.status(400).json({ error: { message: 'zone_id does not reference an existing zone.', code: 'VALIDATION' } });
  }
  try {
    const inserted = await pool.query(`INSERT INTO inventory_stores (name, zone_id) VALUES ($1,$2) RETURNING *`, [String(name).trim(), zoneId]);
    const store = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_store.create', entityType: 'inventory_store', entityId: store.id, before: null, after: store });
    res.status(201).json({ data: store });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to create store.', code: 'INTERNAL' } });
  }
});

router.put('/stores/:id', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid store id.', code: 'VALIDATION' } });
  const { name, zone_id } = req.body;
  try {
    const before = await pool.query('SELECT * FROM inventory_stores WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Store not found.', code: 'NOT_FOUND' } });
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: { message: 'name cannot be empty.', code: 'VALIDATION' } });
    let zoneId = before.rows[0].zone_id;
    if (zone_id !== undefined) {
      zoneId = zone_id === null || zone_id === '' ? null : parseStrictId(zone_id);
      if (zone_id !== null && zone_id !== '' && zoneId === null) return res.status(400).json({ error: { message: 'Invalid zone_id.', code: 'VALIDATION' } });
    }
    const updated = await pool.query(
      `UPDATE inventory_stores SET name = COALESCE($1, name), zone_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [name ? String(name).trim() : null, zoneId, id]
    );
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_store.edit', entityType: 'inventory_store', entityId: id, before: before.rows[0], after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update store.', code: 'INTERNAL' } });
  }
});

router.put('/stores/:id/status', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid store id.', code: 'VALIDATION' } });
  const { status } = req.body;
  if (!['active', 'inactive'].includes(status)) return res.status(400).json({ error: { message: "status must be 'active' or 'inactive'.", code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM inventory_stores WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Store not found.', code: 'NOT_FOUND' } });
    const updated = await pool.query('UPDATE inventory_stores SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *', [status, id]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_store.status_change', entityType: 'inventory_store', entityId: id, before: before.rows[0], after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update store status.', code: 'INTERNAL' } });
  }
});

// ============================================================
// Concurrency helpers (Spec §5)
// ============================================================

// Locks the (item_id, store_id) pair for the duration of the caller's
// own transaction. If a movement already exists, locks the most
// recent row FOR UPDATE; otherwise takes a transaction-scoped advisory
// lock keyed on a stable hash of (item_id, store_id). Must be called
// AFTER BEGIN, using the transaction's own client.
async function lockItemStorePair(client, itemId, storeId) {
  const existing = await client.query(
    `SELECT id FROM inventory_movements WHERE item_id = $1 AND store_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE`,
    [itemId, storeId]
  );
  if (existing.rows.length === 0) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`inv:${itemId}:${storeId}`]);
  }
}

async function getBalance(client, itemId, storeId) {
  const res = await client.query(`SELECT COALESCE(SUM(quantity), 0) AS balance FROM inventory_movements WHERE item_id = $1 AND store_id = $2`, [itemId, storeId]);
  return Number(res.rows[0].balance);
}

async function assertItemActiveForReceipt(client, itemId) {
  const r = await client.query('SELECT status FROM inventory_items WHERE id = $1', [itemId]);
  if (r.rows.length === 0) return { ok: false, status: 404, message: 'Item not found.', code: 'NOT_FOUND' };
  if (r.rows[0].status !== 'active') return { ok: false, status: 409, message: 'This item is inactive and cannot receive new stock.', code: 'CONFLICT' };
  return { ok: true };
}
async function assertItemExists(client, itemId) {
  const r = await client.query('SELECT status FROM inventory_items WHERE id = $1', [itemId]);
  if (r.rows.length === 0) return { ok: false, status: 404, message: 'Item not found.', code: 'NOT_FOUND' };
  return { ok: true };
}

// ============================================================
// Movements
// ============================================================

router.get('/movements', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const params = [];
    const filters = [];
    if (myZoneId !== null) { params.push(myZoneId); filters.push(`(s.zone_id = $${params.length} OR s.zone_id IS NULL)`); }
    if (req.query.item_id) { const v = parseStrictId(req.query.item_id); if (v === null) return res.status(400).json({ error: { message: 'Invalid item_id.', code: 'VALIDATION' } }); params.push(v); filters.push(`m.item_id = $${params.length}`); }
    if (req.query.store_id) { const v = parseStrictId(req.query.store_id); if (v === null) return res.status(400).json({ error: { message: 'Invalid store_id.', code: 'VALIDATION' } }); params.push(v); filters.push(`m.store_id = $${params.length}`); }
    if (req.query.movement_type && MOVEMENT_TYPES.includes(req.query.movement_type)) { params.push(req.query.movement_type); filters.push(`m.movement_type = $${params.length}`); }
    if (req.query.date_from) { params.push(req.query.date_from); filters.push(`m.created_at >= $${params.length}`); }
    if (req.query.date_to) { params.push(req.query.date_to); filters.push(`m.created_at <= $${params.length}`); }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT m.*, i.name AS item_name, s.name AS store_name FROM inventory_movements m
       JOIN inventory_items i ON m.item_id = i.id JOIN inventory_stores s ON m.store_id = s.id
       ${whereSql} ORDER BY m.created_at DESC LIMIT 500`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list movements.', code: 'INTERNAL' } });
  }
});

router.post('/movements/issue', authenticateToken, requireRole(...OPERATE_ROLES), async (req, res) => {
  const { item_id, store_id, quantity, reason, employee_id } = req.body;
  const itemId = parseStrictId(item_id);
  const storeId = parseStrictId(store_id);
  const qty = parseInt(quantity, 10);
  if (itemId === null) return res.status(400).json({ error: { message: 'item_id is required.', code: 'VALIDATION' } });
  if (storeId === null) return res.status(400).json({ error: { message: 'store_id is required.', code: 'VALIDATION' } });
  if (isNaN(qty) || qty <= 0) return res.status(400).json({ error: { message: 'quantity must be a positive integer.', code: 'VALIDATION' } });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: { message: 'reason is required.', code: 'VALIDATION' } });
  let employeeId = null;
  if (employee_id !== undefined && employee_id !== null && employee_id !== '') {
    employeeId = parseStrictId(employee_id);
    if (employeeId === null) return res.status(400).json({ error: { message: 'Invalid employee_id.', code: 'VALIDATION' } });
    const empRes = await pool.query('SELECT id FROM employees WHERE id = $1', [employeeId]);
    if (empRes.rows.length === 0) return res.status(400).json({ error: { message: 'employee_id does not reference an existing employee.', code: 'VALIDATION' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const storeAccess = await loadStoreWithAccessCheck(req.user, storeId, client);
    if (storeAccess.error) { await client.query('ROLLBACK'); return res.status(storeAccess.error.status).json({ error: { message: storeAccess.error.message, code: storeAccess.error.code } }); }
    const itemCheck = await assertItemExists(client, itemId);
    if (!itemCheck.ok) { await client.query('ROLLBACK'); return res.status(itemCheck.status).json({ error: { message: itemCheck.message, code: itemCheck.code } }); }

    await lockItemStorePair(client, itemId, storeId);
    const balance = await getBalance(client, itemId, storeId);
    if (qty > balance) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: `Insufficient stock. Only ${balance} available.`, code: 'CONFLICT' } });
    }
    const inserted = await client.query(
      `INSERT INTO inventory_movements (item_id, store_id, movement_type, quantity, reason, created_by) VALUES ($1,$2,'issue',$3,$4,$5) RETURNING *`,
      [itemId, storeId, -qty, `${String(reason).trim()}${employeeId ? ` (employee #${employeeId})` : ''}`, req.user.id]
    );
    await client.query('COMMIT');
    const movement = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_movement.create', entityType: 'inventory_movement', entityId: movement.id, before: null, after: { ...movement, employee_id: employeeId } });
    res.status(201).json({ data: movement });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to issue stock.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.post('/movements/receive', authenticateToken, requireRole(...OPERATE_ROLES), async (req, res) => {
  const { item_id, store_id, quantity, reference, supplier_id, unit_cost, notes } = req.body;
  const itemId = parseStrictId(item_id);
  const storeId = parseStrictId(store_id);
  const qty = parseInt(quantity, 10);
  if (itemId === null) return res.status(400).json({ error: { message: 'item_id is required.', code: 'VALIDATION' } });
  if (storeId === null) return res.status(400).json({ error: { message: 'store_id is required.', code: 'VALIDATION' } });
  if (isNaN(qty) || qty <= 0) return res.status(400).json({ error: { message: 'quantity must be a positive integer.', code: 'VALIDATION' } });
  if (!reference || !String(reference).trim()) return res.status(400).json({ error: { message: 'reference is required.', code: 'VALIDATION' } });
  let supplierId = null;
  if (supplier_id !== undefined && supplier_id !== null && supplier_id !== '') {
    supplierId = parseStrictId(supplier_id);
    if (supplierId === null) return res.status(400).json({ error: { message: 'Invalid supplier_id.', code: 'VALIDATION' } });
  }
  let unitCost = null;
  if (unit_cost !== undefined && unit_cost !== null && unit_cost !== '') {
    unitCost = parseFloat(unit_cost);
    if (isNaN(unitCost) || unitCost < 0) return res.status(400).json({ error: { message: 'unit_cost must be >= 0.', code: 'VALIDATION' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const storeRes = await client.query('SELECT * FROM inventory_stores WHERE id = $1', [storeId]);
    if (storeRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Store not found.', code: 'NOT_FOUND' } }); }
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && storeRes.rows[0].zone_id !== null && storeRes.rows[0].zone_id !== myZoneId) { await client.query('ROLLBACK'); return res.status(403).json({ error: { message: 'You do not have access to this store.', code: 'FORBIDDEN' } }); }
    if (storeRes.rows[0].status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: 'This store is inactive and cannot receive new stock.', code: 'CONFLICT' } }); }
    const itemCheck = await assertItemActiveForReceipt(client, itemId);
    if (!itemCheck.ok) { await client.query('ROLLBACK'); return res.status(itemCheck.status).json({ error: { message: itemCheck.message, code: itemCheck.code } }); }
    if (supplierId) {
      const supRes = await client.query('SELECT id FROM suppliers WHERE id = $1', [supplierId]);
      if (supRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: { message: 'supplier_id does not reference an existing supplier.', code: 'VALIDATION' } }); }
    }

    await lockItemStorePair(client, itemId, storeId);
    const inserted = await client.query(
      `INSERT INTO inventory_movements (item_id, store_id, movement_type, quantity, unit_cost, reference, source_supplier_id, created_by)
       VALUES ($1,$2,'receipt',$3,$4,$5,$6,$7) RETURNING *`,
      [itemId, storeId, qty, unitCost, `${String(reference).trim()}${notes ? ` — ${notes}` : ''}`, supplierId, req.user.id]
    );
    await client.query('COMMIT');
    const movement = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_movement.create', entityType: 'inventory_movement', entityId: movement.id, before: null, after: movement });
    res.status(201).json({ data: movement });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to receive stock.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.post('/movements/transfer', authenticateToken, requireRole(...OPERATE_ROLES), async (req, res) => {
  const { item_id, source_store_id, destination_store_id, quantity, reason } = req.body;
  const itemId = parseStrictId(item_id);
  const sourceId = parseStrictId(source_store_id);
  const destId = parseStrictId(destination_store_id);
  const qty = parseInt(quantity, 10);
  if (itemId === null) return res.status(400).json({ error: { message: 'item_id is required.', code: 'VALIDATION' } });
  if (sourceId === null || destId === null) return res.status(400).json({ error: { message: 'source_store_id and destination_store_id are required.', code: 'VALIDATION' } });
  if (sourceId === destId) return res.status(400).json({ error: { message: 'Source and destination must differ.', code: 'VALIDATION' } });
  if (isNaN(qty) || qty <= 0) return res.status(400).json({ error: { message: 'quantity must be a positive integer.', code: 'VALIDATION' } });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: { message: 'reason is required.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sourceAccess = await loadStoreWithAccessCheck(req.user, sourceId, client);
    if (sourceAccess.error) { await client.query('ROLLBACK'); return res.status(sourceAccess.error.status).json({ error: { message: sourceAccess.error.message, code: sourceAccess.error.code } }); }
    const destAccess = await loadStoreWithAccessCheck(req.user, destId, client);
    if (destAccess.error) { await client.query('ROLLBACK'); return res.status(destAccess.error.status).json({ error: { message: destAccess.error.message, code: destAccess.error.code } }); }
    const itemCheck = await assertItemExists(client, itemId);
    if (!itemCheck.ok) { await client.query('ROLLBACK'); return res.status(itemCheck.status).json({ error: { message: itemCheck.message, code: itemCheck.code } }); }

    // Deterministic ascending-store_id lock order — prevents deadlock
    // between two opposite-direction concurrent transfers (Spec §5).
    const [firstId, secondId] = sourceId < destId ? [sourceId, destId] : [destId, sourceId];
    await lockItemStorePair(client, itemId, firstId);
    await lockItemStorePair(client, itemId, secondId);

    const sourceBalance = await getBalance(client, itemId, sourceId);
    if (qty > sourceBalance) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: `Insufficient stock at source. Only ${sourceBalance} available.`, code: 'CONFLICT' } });
    }

    const transferGroupId = crypto.randomUUID();
    const outRes = await client.query(
      `INSERT INTO inventory_movements (item_id, store_id, movement_type, quantity, reason, transfer_group_id, created_by)
       VALUES ($1,$2,'transfer_out',$3,$4,$5,$6) RETURNING *`,
      [itemId, sourceId, -qty, String(reason).trim(), transferGroupId, req.user.id]
    );
    const inRes = await client.query(
      `INSERT INTO inventory_movements (item_id, store_id, movement_type, quantity, reason, transfer_group_id, created_by)
       VALUES ($1,$2,'transfer_in',$3,$4,$5,$6) RETURNING *`,
      [itemId, destId, qty, String(reason).trim(), transferGroupId, req.user.id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_movement.transfer', entityType: 'inventory_movement', entityId: outRes.rows[0].id, before: null, after: { out: outRes.rows[0], in: inRes.rows[0] } });
    res.status(201).json({ data: { transfer_out: outRes.rows[0], transfer_in: inRes.rows[0] } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to transfer stock.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.post('/movements/return', authenticateToken, requireRole(...OPERATE_ROLES), async (req, res) => {
  const { item_id, destination_store_id, quantity, reason } = req.body;
  const itemId = parseStrictId(item_id);
  const storeId = parseStrictId(destination_store_id);
  const qty = parseInt(quantity, 10);
  if (itemId === null) return res.status(400).json({ error: { message: 'item_id is required.', code: 'VALIDATION' } });
  if (storeId === null) return res.status(400).json({ error: { message: 'destination_store_id is required.', code: 'VALIDATION' } });
  if (isNaN(qty) || qty <= 0) return res.status(400).json({ error: { message: 'quantity must be a positive integer.', code: 'VALIDATION' } });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: { message: 'reason is required.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const storeRes = await client.query('SELECT * FROM inventory_stores WHERE id = $1', [storeId]);
    if (storeRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Store not found.', code: 'NOT_FOUND' } }); }
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && storeRes.rows[0].zone_id !== null && storeRes.rows[0].zone_id !== myZoneId) { await client.query('ROLLBACK'); return res.status(403).json({ error: { message: 'You do not have access to this store.', code: 'FORBIDDEN' } }); }
    if (storeRes.rows[0].status !== 'active') { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: 'This store is inactive and cannot receive a return.', code: 'CONFLICT' } }); }
    const itemCheck = await assertItemExists(client, itemId);
    if (!itemCheck.ok) { await client.query('ROLLBACK'); return res.status(itemCheck.status).json({ error: { message: itemCheck.message, code: itemCheck.code } }); }

    await lockItemStorePair(client, itemId, storeId);
    const inserted = await client.query(
      `INSERT INTO inventory_movements (item_id, store_id, movement_type, quantity, reason, created_by) VALUES ($1,$2,'return',$3,$4,$5) RETURNING *`,
      [itemId, storeId, qty, String(reason).trim(), req.user.id]
    );
    await client.query('COMMIT');
    const movement = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_movement.create', entityType: 'inventory_movement', entityId: movement.id, before: null, after: movement });
    res.status(201).json({ data: movement });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to record return.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.post('/movements/opening-balance', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const { item_id, store_id, quantity } = req.body;
  const itemId = parseStrictId(item_id);
  const storeId = parseStrictId(store_id);
  const qty = parseInt(quantity, 10);
  if (itemId === null || storeId === null) return res.status(400).json({ error: { message: 'item_id and store_id are required.', code: 'VALIDATION' } });
  if (isNaN(qty) || qty <= 0) return res.status(400).json({ error: { message: 'quantity must be a positive integer.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const itemCheck = await assertItemExists(client, itemId);
    if (!itemCheck.ok) { await client.query('ROLLBACK'); return res.status(itemCheck.status).json({ error: { message: itemCheck.message, code: itemCheck.code } }); }
    const storeRes = await client.query('SELECT id FROM inventory_stores WHERE id = $1', [storeId]);
    if (storeRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Store not found.', code: 'NOT_FOUND' } }); }

    // Lock acquired BEFORE the existence check — the exact ordering
    // that makes two concurrent opening-balance attempts serialize
    // correctly (Spec §11).
    await lockItemStorePair(client, itemId, storeId);
    const existing = await client.query('SELECT 1 FROM inventory_movements WHERE item_id = $1 AND store_id = $2 LIMIT 1', [itemId, storeId]);
    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'This item/store pair already has movement history — opening balance can only be recorded once, before any other movement.', code: 'CONFLICT' } });
    }
    const inserted = await client.query(
      `INSERT INTO inventory_movements (item_id, store_id, movement_type, quantity, created_by) VALUES ($1,$2,'opening_balance',$3,$4) RETURNING *`,
      [itemId, storeId, qty, req.user.id]
    );
    await client.query('COMMIT');
    const movement = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_movement.create', entityType: 'inventory_movement', entityId: movement.id, before: null, after: movement });
    res.status(201).json({ data: movement });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to record opening balance.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.post('/movements/receive-from-procurement', authenticateToken, requireRole(...OPERATE_ROLES), async (req, res) => {
  const { purchase_order_receipt_item_id, store_id } = req.body;
  const receiptItemId = parseStrictId(purchase_order_receipt_item_id);
  const storeId = parseStrictId(store_id);
  if (receiptItemId === null) return res.status(400).json({ error: { message: 'purchase_order_receipt_item_id is required.', code: 'VALIDATION' } });
  if (storeId === null) return res.status(400).json({ error: { message: 'store_id is required.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Read-only against Procurement's own (CLOSED) tables.
    const receiptRes = await client.query(
      `SELECT ri.id, ri.quantity_received, poi.inventory_item_id
       FROM purchase_order_receipt_items ri JOIN purchase_order_items poi ON ri.purchase_order_item_id = poi.id
       WHERE ri.id = $1`,
      [receiptItemId]
    );
    if (receiptRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Purchase order receipt item not found.', code: 'NOT_FOUND' } }); }
    const receiptLine = receiptRes.rows[0];
    if (receiptLine.inventory_item_id === null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'This purchase order line is not mapped to an inventory item.', code: 'VALIDATION' } });
    }

    const storeAccess = await loadStoreWithAccessCheck(req.user, storeId, client);
    if (storeAccess.error) { await client.query('ROLLBACK'); return res.status(storeAccess.error.status).json({ error: { message: storeAccess.error.message, code: storeAccess.error.code } }); }
    const itemCheck = await assertItemActiveForReceipt(client, receiptLine.inventory_item_id);
    if (!itemCheck.ok) { await client.query('ROLLBACK'); return res.status(itemCheck.status).json({ error: { message: itemCheck.message, code: itemCheck.code } }); }

    await lockItemStorePair(client, receiptLine.inventory_item_id, storeId);
    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO inventory_movements (item_id, store_id, movement_type, quantity, source_purchase_order_receipt_item_id, created_by)
         VALUES ($1,$2,'receipt',$3,$4,$5) RETURNING *`,
        [receiptLine.inventory_item_id, storeId, receiptLine.quantity_received, receiptItemId, req.user.id]
      );
    } catch (insertErr) {
      await client.query('ROLLBACK');
      if (insertErr.code === '23505') return res.status(409).json({ error: { message: 'This purchase order receipt line has already been converted to an inventory receipt.', code: 'CONFLICT' } });
      throw insertErr;
    }
    await client.query('COMMIT');
    const movement = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_movement.create', entityType: 'inventory_movement', entityId: movement.id, before: null, after: { ...movement, source: 'procurement' } });
    res.status(201).json({ data: movement });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to convert procurement receipt to inventory.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// ============================================================
// Adjustments
// ============================================================

router.get('/adjustments', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  try {
    const params = [];
    const filters = [];
    if (req.query.status) { params.push(req.query.status); filters.push(`ar.status = $${params.length}`); }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT ar.*, i.name AS item_name, s.name AS store_name FROM inventory_adjustment_requests ar
       JOIN inventory_items i ON ar.item_id = i.id JOIN inventory_stores s ON ar.store_id = s.id
       ${whereSql} ORDER BY ar.created_at DESC`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list adjustment requests.', code: 'INTERNAL' } });
  }
});

router.post('/adjustments', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const { item_id, store_id, requested_quantity, reason } = req.body;
  const itemId = parseStrictId(item_id);
  const storeId = parseStrictId(store_id);
  const qty = parseInt(requested_quantity, 10);
  if (itemId === null || storeId === null) return res.status(400).json({ error: { message: 'item_id and store_id are required.', code: 'VALIDATION' } });
  if (isNaN(qty) || qty === 0) return res.status(400).json({ error: { message: 'requested_quantity must be a non-zero integer.', code: 'VALIDATION' } });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: { message: 'reason is required.', code: 'VALIDATION' } });
  try {
    const itemRes = await pool.query('SELECT id FROM inventory_items WHERE id = $1', [itemId]);
    if (itemRes.rows.length === 0) return res.status(404).json({ error: { message: 'Item not found.', code: 'NOT_FOUND' } });
    const storeRes = await pool.query('SELECT id FROM inventory_stores WHERE id = $1', [storeId]);
    if (storeRes.rows.length === 0) return res.status(404).json({ error: { message: 'Store not found.', code: 'NOT_FOUND' } });
    const inserted = await pool.query(
      `INSERT INTO inventory_adjustment_requests (item_id, store_id, requested_quantity, reason, requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [itemId, storeId, qty, String(reason).trim(), req.user.id]
    );
    const request = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_adjustment.create', entityType: 'inventory_adjustment_request', entityId: request.id, before: null, after: request });
    res.status(201).json({ data: request });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to create adjustment request.', code: 'INTERNAL' } });
  }
});

router.put('/adjustments/:id/status', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid adjustment request id.', code: 'VALIDATION' } });
  const { status, rejected_reason } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: { message: "status must be 'approved' or 'rejected'.", code: 'VALIDATION' } });

  const before = await pool.query('SELECT * FROM inventory_adjustment_requests WHERE id = $1', [id]);
  if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Adjustment request not found.', code: 'NOT_FOUND' } });
  const request = before.rows[0];
  if (request.status !== 'pending') return res.status(409).json({ error: { message: `Adjustment request is already ${request.status}.`, code: 'CONFLICT' } });
  // Self-approval / self-rejection blocked — mirrors Procurement exactly.
  if (request.requested_by === req.user.id) {
    return res.status(403).json({ error: { message: 'You cannot approve or reject your own adjustment request.', code: 'FORBIDDEN' } });
  }

  if (status === 'rejected') {
    const reason = (rejected_reason || '').trim();
    if (!reason) return res.status(400).json({ error: { message: 'rejected_reason is required.', code: 'VALIDATION' } });
    const updated = await pool.query(
      `UPDATE inventory_adjustment_requests SET status = 'rejected', approved_by = $1, approved_at = CURRENT_TIMESTAMP, rejected_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [req.user.id, reason, id]
    );
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_adjustment.reject', entityType: 'inventory_adjustment_request', entityId: id, before: request, after: updated.rows[0] });
    return res.json({ data: updated.rows[0] });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockItemStorePair(client, request.item_id, request.store_id);
    const currentBalance = await getBalance(client, request.item_id, request.store_id);
    if (currentBalance + request.requested_quantity < 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'Approving this adjustment would result in negative stock — the balance has changed since the request was created.', code: 'CONFLICT' } });
    }
    const movementRes = await client.query(
      `INSERT INTO inventory_movements (item_id, store_id, movement_type, quantity, reason, created_by) VALUES ($1,$2,'adjustment',$3,$4,$5) RETURNING *`,
      [request.item_id, request.store_id, request.requested_quantity, request.reason, req.user.id]
    );
    const movement = movementRes.rows[0];
    const updated = await client.query(
      `UPDATE inventory_adjustment_requests SET status = 'approved', approved_by = $1, approved_at = CURRENT_TIMESTAMP, resulting_movement_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [req.user.id, movement.id, id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'inventory_adjustment.approve', entityType: 'inventory_adjustment_request', entityId: id, before: request, after: { request: updated.rows[0], movement } });
    res.json({ data: { request: updated.rows[0], movement } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to approve adjustment.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// ============================================================
// Assets
// ============================================================

router.get('/assets', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const params = [];
    const filters = [];
    if (myZoneId !== null) { params.push(myZoneId); filters.push(`(a.zone_id = $${params.length} OR a.zone_id IS NULL)`); }
    if (req.query.status) { params.push(req.query.status); filters.push(`a.status = $${params.length}`); }
    if (req.query.q) {
      const q = req.query.q.trim();
      if (q.length >= 2) { params.push(`%${q}%`); const i = params.length; filters.push(`(a.name ILIKE $${i} OR a.asset_tag ILIKE $${i} OR a.serial_number ILIKE $${i})`); }
    }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT a.*, e.name AS assigned_employee_name FROM asset_register a LEFT JOIN employees e ON a.assigned_employee_id = e.id ${whereSql} ORDER BY a.name ASC`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list assets.', code: 'INTERNAL' } });
  }
});

async function loadAssetWithAccessCheck(user, assetId, client = pool) {
  const r = await client.query('SELECT * FROM asset_register WHERE id = $1', [assetId]);
  if (r.rows.length === 0) return { error: { status: 404, message: 'Asset not found.', code: 'NOT_FOUND' } };
  const asset = r.rows[0];
  const myZoneId = await resolveUserZoneId(user);
  if (myZoneId !== null && asset.zone_id !== null && asset.zone_id !== myZoneId) {
    return { error: { status: 403, message: 'You do not have access to this asset.', code: 'FORBIDDEN' } };
  }
  return { asset };
}

router.get('/assets/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid asset id.', code: 'VALIDATION' } });
  try {
    const access = await loadAssetWithAccessCheck(req.user, id);
    if (access.error) return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } });
    res.json({ data: access.asset });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load asset.', code: 'INTERNAL' } });
  }
});

router.get('/assets/:id/transfers', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid asset id.', code: 'VALIDATION' } });
  try {
    const access = await loadAssetWithAccessCheck(req.user, id);
    if (access.error) return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } });
    const result = await pool.query('SELECT * FROM asset_transfers WHERE asset_id = $1 ORDER BY transferred_at DESC', [id]);
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load asset transfer history.', code: 'INTERNAL' } });
  }
});

router.post('/assets', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const { asset_tag, name, category, serial_number, acquisition_date, acquisition_cost, supplier_id, purchase_order_id, zone_id, store_location_id, condition } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: { message: 'name is required.', code: 'VALIDATION' } });
  if (acquisition_cost !== undefined && acquisition_cost !== null && acquisition_cost !== '' && (isNaN(parseFloat(acquisition_cost)) || parseFloat(acquisition_cost) < 0)) {
    return res.status(400).json({ error: { message: 'acquisition_cost must be >= 0.', code: 'VALIDATION' } });
  }
  try {
    const inserted = await pool.query(
      `INSERT INTO asset_register (asset_tag, name, category, serial_number, acquisition_date, acquisition_cost, supplier_id, purchase_order_id, zone_id, store_location_id, condition)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [asset_tag || null, String(name).trim(), category || null, serial_number || null, acquisition_date || null,
       acquisition_cost != null && acquisition_cost !== '' ? parseFloat(acquisition_cost) : null,
       supplier_id ? parseStrictId(supplier_id) : null, purchase_order_id ? parseStrictId(purchase_order_id) : null,
       zone_id ? parseStrictId(zone_id) : null, store_location_id ? parseStrictId(store_location_id) : null, condition || null]
    );
    const asset = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'asset.create', entityType: 'asset', entityId: asset.id, before: null, after: asset });
    res.status(201).json({ data: asset });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'An asset with this tag already exists.', code: 'CONFLICT' } });
    res.status(500).json({ error: { message: 'Failed to create asset.', code: 'INTERNAL' } });
  }
});

router.put('/assets/:id', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid asset id.', code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM asset_register WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Asset not found.', code: 'NOT_FOUND' } });
    if (before.rows[0].status === 'retired') return res.status(409).json({ error: { message: 'This asset is retired and cannot be edited.', code: 'CONFLICT' } });
    const { name, category, serial_number, acquisition_date, acquisition_cost, condition, status } = req.body;
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: { message: 'name cannot be empty.', code: 'VALIDATION' } });
    let newStatus = before.rows[0].status;
    if (status !== undefined) {
      const validTransitions = { active: ['in_maintenance', 'assigned'], assigned: ['in_maintenance', 'active'], in_maintenance: ['active', 'assigned'] };
      if (!['active', 'assigned', 'in_maintenance'].includes(status) || !(validTransitions[before.rows[0].status] || []).includes(status)) {
        return res.status(409).json({ error: { message: `Cannot transition asset from ${before.rows[0].status} to ${status}.`, code: 'CONFLICT' } });
      }
      newStatus = status;
    }
    const updated = await pool.query(
      `UPDATE asset_register SET name = COALESCE($1, name), category = $2, serial_number = $3, acquisition_date = $4, acquisition_cost = $5, condition = $6, status = $7, updated_at = CURRENT_TIMESTAMP WHERE id = $8 RETURNING *`,
      [name ? String(name).trim() : null, category !== undefined ? category : before.rows[0].category, serial_number !== undefined ? serial_number : before.rows[0].serial_number,
       acquisition_date !== undefined ? acquisition_date : before.rows[0].acquisition_date, acquisition_cost !== undefined ? acquisition_cost : before.rows[0].acquisition_cost,
       condition !== undefined ? condition : before.rows[0].condition, newStatus, id]
    );
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'asset.edit', entityType: 'asset', entityId: id, before: before.rows[0], after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update asset.', code: 'INTERNAL' } });
  }
});

router.put('/assets/:id/transfer', authenticateToken, requireRole(...OPERATE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid asset id.', code: 'VALIDATION' } });
  const { to_employee_id, to_zone_id, reason } = req.body;
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: { message: 'reason is required.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const access = await loadAssetWithAccessCheck(req.user, id, client);
    if (access.error) { await client.query('ROLLBACK'); return res.status(access.error.status).json({ error: { message: access.error.message, code: access.error.code } }); }
    if (access.asset.status === 'retired') { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: 'This asset is retired and cannot be transferred.', code: 'CONFLICT' } }); }

    let toEmployeeId = null;
    if (to_employee_id !== undefined && to_employee_id !== null && to_employee_id !== '') {
      toEmployeeId = parseStrictId(to_employee_id);
      if (toEmployeeId === null) { await client.query('ROLLBACK'); return res.status(400).json({ error: { message: 'Invalid to_employee_id.', code: 'VALIDATION' } }); }
      const empRes = await client.query('SELECT id FROM employees WHERE id = $1', [toEmployeeId]);
      if (empRes.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: { message: 'to_employee_id does not reference an existing employee.', code: 'VALIDATION' } }); }
    }
    let toZoneId = access.asset.zone_id;
    if (to_zone_id !== undefined) {
      toZoneId = to_zone_id === null || to_zone_id === '' ? null : parseStrictId(to_zone_id);
    }

    const fromEmployeeId = access.asset.assigned_employee_id;
    const fromZoneId = access.asset.zone_id;
    const newStatus = toEmployeeId ? 'assigned' : (access.asset.status === 'assigned' ? 'active' : access.asset.status);

    const updated = await client.query(
      `UPDATE asset_register SET assigned_employee_id = $1, zone_id = $2, status = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *`,
      [toEmployeeId, toZoneId, newStatus, id]
    );
    const transferRes = await client.query(
      `INSERT INTO asset_transfers (asset_id, from_employee_id, to_employee_id, from_zone_id, to_zone_id, transferred_by, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, fromEmployeeId, toEmployeeId, fromZoneId, toZoneId, req.user.id, String(reason).trim()]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'asset.transfer', entityType: 'asset', entityId: id, before: access.asset, after: { asset: updated.rows[0], transfer: transferRes.rows[0] } });
    res.json({ data: { asset: updated.rows[0], transfer: transferRes.rows[0] } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to transfer asset.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.put('/assets/:id/retire', authenticateToken, requireRole(...ADMIN_ONLY), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid asset id.', code: 'VALIDATION' } });
  const { reason, condition } = req.body;
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: { message: 'reason is required.', code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM asset_register WHERE id = $1', [id]);
    if (before.rows.length === 0) return res.status(404).json({ error: { message: 'Asset not found.', code: 'NOT_FOUND' } });
    if (before.rows[0].status === 'retired') return res.status(409).json({ error: { message: 'This asset is already retired.', code: 'CONFLICT' } });
    const updated = await pool.query(
      `UPDATE asset_register SET status = 'retired', retired_reason = $1, retired_at = CURRENT_TIMESTAMP, condition = COALESCE($2, condition), updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [String(reason).trim(), condition || null, id]
    );
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'asset.retire', entityType: 'asset', entityId: id, before: before.rows[0], after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to retire asset.', code: 'INTERNAL' } });
  }
});

module.exports = router;
