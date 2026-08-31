const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

const VALID_TYPES = ['residential', 'commercial'];
const VALID_STATUSES = ['active', 'suspended', 'archived'];
const VALID_SHIFTS = ['day', 'night'];
const CUSTOMER_NUMBER_RE = /^C-\d{2,}$/;

// Zones that may write/scope-restrict — mirrors getZoneScope() in the
// reference backend: admin is global, gudoomiye/zone_accountant are
// zone-scoped. Deferred per Discovery §20/§25: cashier/collector-specific
// scoping (current system's getCashierScope()/collector-employee match)
// depends on collector_assignments/employees, which do not exist as V2
// modules yet — out of scope here, documented as a deferred dependency, not
// invented. Cashier/collector get the same unscoped staff view as any other
// authenticated role for now.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];

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

async function generateCustomerNumber(client) {
  const seq = await client.query(`SELECT nextval('customer_number_seq') AS n`);
  const n = Number(seq.rows[0].n);
  const width = Math.max(2, String(n).length);
  return `C-${String(n).padStart(width, '0')}`;
}

function validateCustomerInput(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.customer_type !== undefined) {
    if (!VALID_TYPES.includes(body.customer_type)) {
      errors.push(`customer_type must be one of: ${VALID_TYPES.join(', ')}.`);
    } else {
      out.customer_type = body.customer_type;
    }
  }
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
  if (!partial || body.zone_id !== undefined) {
    const zoneId = parseStrictId(String(body.zone_id ?? ''));
    if (zoneId === null) {
      errors.push('zone_id is required and must be a valid zone.');
    } else {
      out.zone_id = zoneId;
    }
  }

  // business_name is required for commercial customers — checked whenever
  // the effective type is commercial, not only when business_name itself
  // was present in the body (a commercial POST that never mentions
  // business_name must still be rejected, not silently accepted as null).
  const effectiveType = out.customer_type || (partial ? undefined : body.customer_type);
  if (effectiveType === 'commercial') {
    const bn = body.business_name;
    if (typeof bn !== 'string' || bn.trim().length < 1 || bn.trim().length > 150) {
      errors.push('business_name is required for commercial customers and must be 1-150 characters.');
    } else {
      out.business_name = bn.trim();
    }
  } else if (body.business_name !== undefined) {
    out.business_name = body.business_name === null ? null : String(body.business_name).trim().slice(0, 150) || null;
  }

  if (body.alternate_phone !== undefined) out.alternate_phone = body.alternate_phone ? String(body.alternate_phone).trim().slice(0, 20) : null;
  if (body.whatsapp !== undefined) out.whatsapp = body.whatsapp ? String(body.whatsapp).trim().slice(0, 20) : null;
  if (body.email !== undefined) {
    const email = body.email ? String(body.email).trim() : '';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push('email must be a valid email address.');
    } else {
      out.email = email || null;
    }
  }
  if (body.address_line !== undefined) out.address_line = body.address_line ? String(body.address_line).trim().slice(0, 200) : null;
  if (body.sub_zone !== undefined) out.sub_zone = body.sub_zone ? String(body.sub_zone).trim().slice(0, 100) : null;
  if (body.lat !== undefined) {
    if (body.lat !== null && (typeof body.lat !== 'number' || body.lat < -90 || body.lat > 90)) {
      errors.push('lat must be a number between -90 and 90.');
    } else {
      out.lat = body.lat;
    }
  }
  if (body.lng !== undefined) {
    if (body.lng !== null && (typeof body.lng !== 'number' || body.lng < -180 || body.lng > 180)) {
      errors.push('lng must be a number between -180 and 180.');
    } else {
      out.lng = body.lng;
    }
  }
  if (body.commercial_shift !== undefined) {
    if (body.commercial_shift !== null && !VALID_SHIFTS.includes(body.commercial_shift)) {
      errors.push(`commercial_shift must be one of: ${VALID_SHIFTS.join(', ')}, or null.`);
    } else {
      out.commercial_shift = body.commercial_shift;
    }
  }
  if (body.collection_frequency !== undefined) out.collection_frequency = body.collection_frequency ? String(body.collection_frequency).trim().slice(0, 50) : null;
  if (body.collection_mode !== undefined) out.collection_mode = body.collection_mode ? String(body.collection_mode).trim().slice(0, 50) : null;
  if (body.fee !== undefined) {
    if (body.fee !== null && (typeof body.fee !== 'number' || body.fee < 0)) {
      errors.push('fee must be a non-negative number.');
    } else {
      out.fee = body.fee;
    }
  }
  if (body.notes !== undefined) {
    const notes = body.notes ? String(body.notes) : '';
    if (notes.length > 2000) {
      errors.push('notes must be 2000 characters or fewer.');
    } else {
      out.notes = notes || null;
    }
  }

  return { errors, data: out };
}

async function assertZoneWritable(user, zoneId) {
  // Gudoomiye/zone_accountant may only write within their own zone.
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return true;
  const myZoneId = await resolveUserZoneId(user);
  return myZoneId !== null && myZoneId === zoneId;
}

// GET /api/v2/customers — list, search, filter, paginate. Zone-scoped for
// gudoomiye/zone_accountant, enforced server-side (closes the IDOR finding
// from Discovery §25 — every route re-checks scope, not just this one).
router.get('/', authenticateToken, async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const where = [];
    const params = [];

    if (myZoneId !== null) {
      params.push(myZoneId);
      where.push(`c.zone_id = $${params.length}`);
    }

    const status = req.query.status;
    if (status === 'archived') {
      where.push(`c.status = 'archived'`);
    } else if (status === 'all') {
      // no filter
    } else {
      // default: active customer list excludes archived (OD-1)
      where.push(`c.status != 'archived'`);
    }

    if (req.query.customer_type) {
      if (!VALID_TYPES.includes(req.query.customer_type)) {
        return res.status(400).json({ error: { message: `Invalid customer_type filter.`, code: 'VALIDATION' } });
      }
      params.push(req.query.customer_type);
      where.push(`c.customer_type = $${params.length}`);
    }
    if (req.query.zone_id) {
      const zid = parseStrictId(req.query.zone_id);
      if (zid === null) return res.status(400).json({ error: { message: 'Invalid zone_id filter.', code: 'VALIDATION' } });
      if (myZoneId !== null && zid !== myZoneId) {
        return res.status(403).json({ error: { message: 'You do not have access to that zone.', code: 'FORBIDDEN' } });
      }
      params.push(zid);
      where.push(`c.zone_id = $${params.length}`);
    }
    if (req.query.q) {
      params.push(`%${req.query.q.trim()}%`);
      const i = params.length;
      where.push(`(c.customer_number ILIKE $${i} OR c.name ILIKE $${i} OR c.business_name ILIKE $${i} OR c.phone ILIKE $${i})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM customers c ${whereSql}`, params);
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT c.*, z.name AS zone_name
       FROM customers c JOIN zones z ON c.zone_id = z.id
       ${whereSql}
       ORDER BY c.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: result.rows, meta: { total: countResult.rows[0].total, limit, offset } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list customers.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/customers/check-duplicate — advisory only (OD-2: warning, not
// a block). Never used to reject a create request server-side.
router.get('/check-duplicate', authenticateToken, async (req, res) => {
  try {
    const { phone, business_name, address_line, customer_type } = req.query;
    const conditions = [];
    const params = [];
    if (phone) {
      params.push(phone.trim());
      conditions.push(`c.phone = $${params.length}`);
    }
    if (customer_type === 'commercial' && business_name) {
      params.push(business_name.trim());
      conditions.push(`c.business_name ILIKE $${params.length}`);
    }
    if (address_line) {
      params.push(`%${address_line.trim()}%`);
      conditions.push(`c.address_line ILIKE $${params.length}`);
    }
    if (conditions.length === 0) return res.json({ data: [] });

    const result = await pool.query(
      `SELECT c.id, c.customer_number, c.name, c.business_name, c.phone, c.address_line, c.status
       FROM customers c WHERE c.status != 'archived' AND (${conditions.join(' OR ')}) LIMIT 5`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to check for duplicates.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/customers/:id
router.get('/:id', authenticateToken, async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid customer id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query(`SELECT c.*, z.name AS zone_name FROM customers c JOIN zones z ON c.zone_id = z.id WHERE c.id = $1`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Customer not found.', code: 'NOT_FOUND' } });

    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && result.rows[0].zone_id !== myZoneId) {
      // Closes the current system's IDOR finding — detail is scoped exactly
      // like the list, not just role-gated.
      return res.status(403).json({ error: { message: 'You do not have access to this customer.', code: 'FORBIDDEN' } });
    }
    res.json({ data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load customer.', code: 'INTERNAL' } });
  }
});

// POST /api/v2/customers — admin, gudoomiye (own zone only).
router.post('/', authenticateToken, requireRole('admin', 'gudoomiye'), async (req, res) => {
  const { errors, data } = validateCustomerInput(req.body, { partial: false });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });

  const writable = await assertZoneWritable(req.user, data.zone_id);
  if (!writable) {
    return res.status(403).json({ error: { message: 'You cannot create a customer outside your assigned zone.', code: 'FORBIDDEN' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const customerNumber = await generateCustomerNumber(client);
    const result = await client.query(
      `INSERT INTO customers
        (customer_number, customer_type, name, business_name, phone, alternate_phone, whatsapp, email,
         address_line, zone_id, sub_zone, lat, lng, commercial_shift, collection_frequency, collection_mode,
         fee, notes, registered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [customerNumber, data.customer_type, data.name, data.business_name ?? null, data.phone,
       data.alternate_phone ?? null, data.whatsapp ?? null, data.email ?? null, data.address_line ?? null,
       data.zone_id, data.sub_zone ?? null, data.lat ?? null, data.lng ?? null, data.commercial_shift ?? null,
       data.collection_frequency ?? null, data.collection_mode ?? null, data.fee ?? null, data.notes ?? null,
       req.user.id]
    );
    await client.query('COMMIT');
    const customer = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'customer.create', entityType: 'customer', entityId: customer.id, before: null, after: customer });
    res.status(201).json({ data: customer });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: { message: 'Customer Number collision — please retry.', code: 'DUPLICATE' } });
    }
    // 23503 = FK violation — a zone_id that passed the strict-id format
    // check but doesn't reference a real zone. A client error, not a server
    // failure. Found during Phase 3 Module 2 QA (was surfacing as 500).
    if (err.code === '23503') {
      return res.status(400).json({ error: { message: 'zone_id does not reference an existing zone.', code: 'VALIDATION' } });
    }
    res.status(500).json({ error: { message: 'Failed to create customer.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// PUT /api/v2/customers/:id — general field edits. Does NOT allow
// customer_number changes (dedicated endpoint below) or status changes
// (dedicated endpoint below) — matches the Discovery's API design (§23).
router.put('/:id', authenticateToken, requireRole('admin', 'gudoomiye'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid customer id.', code: 'VALIDATION' } });

  const { errors, data } = validateCustomerInput(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  if (Object.keys(data).length === 0) return res.status(400).json({ error: { message: 'No valid fields provided to update.', code: 'VALIDATION' } });

  try {
    const existing = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: { message: 'Customer not found.', code: 'NOT_FOUND' } });

    const current = existing.rows[0];
    if (!(await assertZoneWritable(req.user, current.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this customer.', code: 'FORBIDDEN' } });
    }
    if (data.zone_id !== undefined && !(await assertZoneWritable(req.user, data.zone_id))) {
      return res.status(403).json({ error: { message: 'You cannot transfer a customer into a zone you do not manage.', code: 'FORBIDDEN' } });
    }

    const fields = Object.keys(data);
    const setSql = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = fields.map((f) => data[f]);
    values.push(id);

    const result = await pool.query(
      `UPDATE customers SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`,
      values
    );
    const customer = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'customer.update', entityType: 'customer', entityId: customer.id, before: current, after: customer });
    if (data.zone_id !== undefined && data.zone_id !== current.zone_id) {
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'customer.zone_change', entityType: 'customer', entityId: customer.id, before: { zone_id: current.zone_id }, after: { zone_id: customer.zone_id } });
    }
    res.json({ data: customer });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ error: { message: 'zone_id does not reference an existing zone.', code: 'VALIDATION' } });
    }
    res.status(500).json({ error: { message: 'Failed to update customer.', code: 'INTERNAL' } });
  }
});

// PUT /api/v2/customers/:id/customer-number — dedicated endpoint, admin +
// gudoomiye (own zone). Hard-blocks on duplicate (OD-2: Customer Number
// uniqueness is NOT a warning), independent audit entry recording old/new.
router.put('/:id/customer-number', authenticateToken, requireRole('admin', 'gudoomiye'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid customer id.', code: 'VALIDATION' } });

  const raw = req.body?.customer_number;
  const newNumber = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!CUSTOMER_NUMBER_RE.test(newNumber)) {
    return res.status(400).json({ error: { message: 'Customer Number must look like C-01 (C- followed by 2 or more digits).', code: 'VALIDATION' } });
  }

  try {
    const existing = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: { message: 'Customer not found.', code: 'NOT_FOUND' } });
    const current = existing.rows[0];

    if (!(await assertZoneWritable(req.user, current.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this customer.', code: 'FORBIDDEN' } });
    }

    const dup = await pool.query('SELECT id FROM customers WHERE customer_number = $1 AND id != $2', [newNumber, id]);
    if (dup.rows.length) {
      return res.status(409).json({ error: { message: `Customer Number ${newNumber} is already assigned to another customer.`, code: 'DUPLICATE' } });
    }

    const result = await pool.query(
      `UPDATE customers SET customer_number = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [newNumber, id]
    );
    const customer = result.rows[0];
    await logAudit({
      actorId: req.user.id, actorUsername: req.user.username, action: 'customer.number_change',
      entityType: 'customer', entityId: customer.id,
      before: { customer_number: current.customer_number }, after: { customer_number: customer.customer_number },
    });
    res.json({ data: customer });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: { message: `Customer Number ${newNumber} is already assigned to another customer.`, code: 'DUPLICATE' } });
    }
    res.status(500).json({ error: { message: 'Failed to update Customer Number.', code: 'INTERNAL' } });
  }
});

// PUT /api/v2/customers/:id/status — dedicated endpoint, admin + gudoomiye
// (own zone). Archive is a status update, never a delete (Discovery §10).
router.put('/:id/status', authenticateToken, requireRole('admin', 'gudoomiye'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid customer id.', code: 'VALIDATION' } });

  const status = req.body?.status;
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: { message: `status must be one of: ${VALID_STATUSES.join(', ')}.`, code: 'VALIDATION' } });
  }

  try {
    const existing = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: { message: 'Customer not found.', code: 'NOT_FOUND' } });
    const current = existing.rows[0];

    if (!(await assertZoneWritable(req.user, current.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this customer.', code: 'FORBIDDEN' } });
    }

    const result = await pool.query(
      `UPDATE customers SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [status, id]
    );
    const customer = result.rows[0];
    await logAudit({
      actorId: req.user.id, actorUsername: req.user.username, action: 'customer.status_change',
      entityType: 'customer', entityId: customer.id,
      before: { status: current.status }, after: { status: customer.status },
    });
    res.json({ data: customer });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to update customer status.', code: 'INTERNAL' } });
  }
});

// DELETE is deliberately not implemented — archive via /:id/status instead,
// per Discovery §10 (current invoices/debts FKs already make hard delete
// unsafe for any customer with real history).

module.exports = router;
