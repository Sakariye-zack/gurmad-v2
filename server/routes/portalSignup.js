// Customer self-signup requests. Mounted inside routes/customerPortal.js, so
// every path here lives under /api/v2/customer-portal.
//
//   Public:  GET  /signup/districts            active districts (id + name only)
//            POST /signup                      submit a request
//   Staff:   GET  /signup-requests             admin (all) / gudoomiye (own district)
//            GET  /signup-requests/count       pending count, same scope
//            POST /signup-requests/:id/approve creates customer + portal account
//            POST /signup-requests/:id/reject  required reason
//
// No SMS is available, so there is no OTP: staff approval is the gate.
const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { pool, logAudit, logPortalAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { createStaffNotification, logNotificationFailure } = require('../lib/staffNotifications');
const { createCustomer, resolveUserZoneId } = require('./customers');

const router = express.Router();

const BCRYPT_ROUNDS = 12;
// Same strength rule as the portal's own reset-password route.
const PORTAL_PASSWORD_MIN = 8;
const IP_MAX_PER_HOUR = 5;
const PHONE_MAX_PER_DAY = 3;
const STAFF_ROLES = ['admin', 'gudoomiye'];

// Request-level flood guard on top of the DB-counted per-IP/per-phone limits.
const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts. Please try again later.', code: 'RATE_LIMITED' } },
});

// Canonical international form, identical to customerPortal.js canonicalPhone.
function canonicalPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('252')) return d;
  return '252' + (d.startsWith('0') ? d.slice(1) : d);
}
// Somaliland mobile: 252 + 6XXXXXXXX. Returns { canonical, local } or null.
function normaliseSomalilandPhone(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (/[^\d\s+\-()]/.test(raw)) return null;
  const canonical = canonicalPhone(raw);
  if (!/^2526\d{8}$/.test(canonical)) return null;
  return { canonical, local: '0' + canonical.slice(3) };
}
// SQL expression: canonical form of a stored phone column.
const SQL_CANON = (col) => `('252' || regexp_replace(regexp_replace(regexp_replace(COALESCE(${col},''), '\\D', '', 'g'), '^252', ''), '^0', ''))`;

function parseStrictId(raw) {
  if (!/^\d+$/.test(String(raw ?? ''))) return null;
  return parseInt(raw, 10);
}
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const vErr = (res, message, extra = {}) => res.status(400).json({ error: { message, code: 'VALIDATION', ...extra } });

async function activeAccountForPhone(canonical, db = pool) {
  const r = await db.query(
    `SELECT 1 FROM customer_portal_accounts cpa JOIN customers c ON c.id = cpa.customer_id
     WHERE c.status = 'active' AND cpa.status = 'active' AND ${SQL_CANON('c.phone')} = $1 LIMIT 1`,
    [canonical]
  );
  return r.rows.length > 0;
}

const EXISTING_ACCOUNT = { error: { message: 'You already have an account — log in or reset your password.', code: 'ACCOUNT_EXISTS' } };
const PENDING_EXISTS = { error: { message: 'A signup request for this phone number is already waiting for review. Our office will call you.', code: 'PENDING_EXISTS' } };

// ------------------------------------------------------------------ public

router.get('/signup/districts', async (req, res) => {
  try {
    const r = await pool.query(`SELECT id, name FROM zones WHERE status = 'active' ORDER BY name`);
    res.json({ data: r.rows.map((z) => ({ id: z.id, name: z.name })) });
  } catch (e) {
    res.status(500).json({ error: { message: 'Failed to load districts.', code: 'INTERNAL' } });
  }
});

router.post('/signup', signupLimiter, async (req, res) => {
  const b = req.body || {};
  const ip = req.ip || req.socket.remoteAddress || null;
  // Honeypot: a hidden field real users never fill. Pretend success, store nothing.
  if (typeof b.website === 'string' && b.website.trim() !== '') {
    return res.status(201).json({ data: { message: 'Request received.' } });
  }
  try {
    const ipCount = await pool.query(`SELECT COUNT(*)::int AS n FROM customer_signup_requests WHERE ip = $1 AND created_at > NOW() - INTERVAL '1 hour'`, [ip]);
    if (ipCount.rows[0].n >= IP_MAX_PER_HOUR) {
      return res.status(429).json({ error: { message: 'Too many signup requests. Please try again later.', code: 'RATE_LIMITED' } });
    }

    const fullName = str(b.full_name, 100);
    if (!fullName || fullName.length < 2) return vErr(res, 'Full name is required.');
    const phone = normaliseSomalilandPhone(b.phone);
    if (!phone) return vErr(res, 'Enter a valid Somaliland mobile number (e.g. 063 4123456).');
    let alt = null;
    if (typeof b.alternate_phone === 'string' && b.alternate_phone.trim()) {
      const a = normaliseSomalilandPhone(b.alternate_phone);
      if (!a) return vErr(res, 'Alternate phone / WhatsApp is not a valid Somaliland mobile number.');
      alt = a.local;
    }
    if (!['residential', 'commercial'].includes(b.customer_type)) return vErr(res, 'Customer type must be residential or commercial.');
    const businessName = str(b.business_name, 150);
    if (b.customer_type === 'commercial' && !businessName) return vErr(res, 'Business name is required for commercial customers.');
    const zoneId = parseStrictId(b.zone_id);
    if (zoneId === null) return vErr(res, 'Please choose your district.');
    const zone = await pool.query(`SELECT id, name FROM zones WHERE id = $1 AND status = 'active'`, [zoneId]);
    if (!zone.rows.length) return vErr(res, 'Please choose your district.');
    let door = null;
    if (b.door_number !== undefined && b.door_number !== null && String(b.door_number).trim() !== '') {
      door = String(b.door_number).trim();
      if (!/^\d{1,20}$/.test(door)) return vErr(res, 'Door number must contain digits only.');
    }
    let lat = null; let lng = null;
    if (b.lat !== undefined && b.lat !== null && b.lat !== '') {
      lat = Number(b.lat); lng = Number(b.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return vErr(res, 'Location is invalid.');
    }
    let billing = null;
    if (b.preferred_billing) {
      if (!['monthly', 'daily'].includes(b.preferred_billing)) return vErr(res, 'Preferred billing must be monthly or daily.');
      billing = b.preferred_billing;
    }
    const notes = typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim() : null;
    if (notes && notes.length > 1000) return vErr(res, 'Notes must be 1000 characters or fewer.');
    if (typeof b.password !== 'string' || b.password.length < PORTAL_PASSWORD_MIN || b.password.length > 200) {
      return vErr(res, `Password must be at least ${PORTAL_PASSWORD_MIN} characters.`);
    }
    if (b.password_confirm !== undefined && b.password_confirm !== b.password) return vErr(res, 'Passwords do not match.');

    const phoneCount = await pool.query(`SELECT COUNT(*)::int AS n FROM customer_signup_requests WHERE phone_canonical = $1 AND created_at > NOW() - INTERVAL '1 day'`, [phone.canonical]);
    if (phoneCount.rows[0].n >= PHONE_MAX_PER_DAY) {
      return res.status(429).json({ error: { message: 'Too many signup requests for this phone number today. Please call our office.', code: 'RATE_LIMITED' } });
    }
    if (await activeAccountForPhone(phone.canonical)) return res.status(409).json(EXISTING_ACCOUNT);
    const pending = await pool.query(`SELECT 1 FROM customer_signup_requests WHERE phone_canonical = $1 AND status = 'pending'`, [phone.canonical]);
    if (pending.rows.length) return res.status(409).json(PENDING_EXISTS);

    const hash = await bcrypt.hash(b.password, BCRYPT_ROUNDS);
    let row;
    try {
      const ins = await pool.query(
        `INSERT INTO customer_signup_requests
          (full_name, phone, phone_canonical, alternate_phone, customer_type, business_name, zone_id, area, door_number,
           address_line, lat, lng, preferred_billing, password_hash, notes, ip, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, zone_id`,
        [fullName, phone.local, phone.canonical, alt, b.customer_type, b.customer_type === 'commercial' ? businessName : null, zoneId,
         str(b.area, 100), door, str(b.address_line, 200), lat, lng, billing, hash, notes, ip, str(req.headers['user-agent'], 300)]
      );
      row = ins.rows[0];
    } catch (e) {
      if (e.code === '23505') return res.status(409).json(PENDING_EXISTS);
      throw e;
    }
    await logPortalAudit({ action: 'signup_requested', ipAddress: ip, details: { request_id: row.id, zone_id: zoneId } });

    // Staff notification: every active admin + the gudoomiye of that district.
    try {
      const recips = await pool.query(
        `SELECT id FROM v2_users WHERE is_active = TRUE AND (role = 'admin' OR (role = 'gudoomiye' AND zone = $1))`,
        [zone.rows[0].name]
      );
      for (const u of recips.rows) {
        await createStaffNotification({
          recipientId: u.id, eventType: 'customer_signup.requested',
          title: 'New customer signup request',
          body: `${fullName} — ${zone.rows[0].name}`,
          entityType: 'customer_signup_request', entityId: row.id,
        });
      }
    } catch (e) {
      logNotificationFailure('customer_signup_requested', e);
    }
    return res.status(201).json({ data: { message: 'Request received.' } });
  } catch (e) {
    return res.status(500).json({ error: { message: 'Signup request failed.', code: 'INTERNAL' } });
  }
});

// ------------------------------------------------------------------ staff

// Gudoomiye sees only their own district; returns null for "unrestricted",
// -1 for a gudoomiye without a resolvable district (sees nothing).
async function scopeZoneId(user) {
  if (user.role === 'admin') return null;
  const z = await resolveUserZoneId(user);
  return z ?? -1;
}

const LIST_COLS = `r.id, r.status, r.full_name, r.phone, r.alternate_phone, r.customer_type, r.business_name, r.zone_id, z.name AS zone_name,
  r.area, r.door_number, r.address_line, r.lat, r.lng, r.preferred_billing, r.notes, r.created_at, r.reviewed_by, r.reviewed_at,
  r.reject_reason, r.customer_id`;

router.get('/signup-requests', authenticateToken, requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const scope = await scopeZoneId(req.user);
    const params = [status];
    let where = 'r.status = $1';
    if (scope !== null) { params.push(scope); where += ` AND r.zone_id = $${params.length}`; }
    const r = await pool.query(`SELECT ${LIST_COLS} FROM customer_signup_requests r JOIN zones z ON z.id = r.zone_id WHERE ${where} ORDER BY r.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`, params);
    res.json({ data: r.rows });
  } catch (e) {
    res.status(500).json({ error: { message: 'Failed to load signup requests.', code: 'INTERNAL' } });
  }
});

router.get('/signup-requests/count', authenticateToken, requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const scope = await scopeZoneId(req.user);
    const params = [];
    let where = `status = 'pending'`;
    if (scope !== null) { params.push(scope); where += ' AND zone_id = $1'; }
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM customer_signup_requests WHERE ${where}`, params);
    res.json({ data: { pending: r.rows[0].n } });
  } catch (e) {
    res.status(500).json({ error: { message: 'Failed to load count.', code: 'INTERNAL' } });
  }
});

const NOT_FOUND = { error: { message: 'Signup request not found.', code: 'NOT_FOUND' } };
const NOT_PENDING = { error: { message: 'This signup request has already been reviewed.', code: 'NOT_PENDING' } };

router.post('/signup-requests/:id/approve', authenticateToken, requireRole(...STAFF_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json(NOT_FOUND);
  const b = req.body || {};
  const scope = await scopeZoneId(req.user);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rq = await client.query('SELECT * FROM customer_signup_requests WHERE id = $1 FOR UPDATE', [id]);
    const r = rq.rows[0];
    if (!r || (scope !== null && r.zone_id !== scope)) { await client.query('ROLLBACK'); return res.status(404).json(NOT_FOUND); }
    if (r.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json(NOT_PENDING); }
    if (await activeAccountForPhone(r.phone_canonical, client)) { await client.query('ROLLBACK'); return res.status(409).json(EXISTING_ACCOUNT); }

    const address = [r.area, r.address_line].filter(Boolean).join(', ') || null;
    const body = {
      customer_type: r.customer_type, name: r.full_name, business_name: r.business_name, phone: r.phone,
      alternate_phone: r.alternate_phone, whatsapp: r.alternate_phone, address_line: address ? address.slice(0, 200) : null,
      lat: r.lat === null ? null : Number(r.lat), lng: r.lng === null ? null : Number(r.lng), notes: r.notes,
      zone_id: b.zone_id ?? r.zone_id, group_id: b.group_id ?? null, route_id: b.route_id ?? null,
      door_number: b.door_number, billing_type: b.billing_type ?? r.preferred_billing ?? undefined,
      fee_currency: b.fee_currency ?? 'USD', fee: b.fee === undefined || b.fee === '' ? null : b.fee,
    };
    const created = await createCustomer(req.user, body, client);
    if (!created.customer) { await client.query('ROLLBACK'); return res.status(created.status).json(created.body); }
    const customer = created.customer;
    const acct = await client.query(
      `INSERT INTO customer_portal_accounts (customer_id, password_hash, status, activated_by) VALUES ($1,$2,'active',$3) RETURNING id`,
      [customer.id, r.password_hash, req.user.id]
    );
    await client.query(
      `UPDATE customer_signup_requests SET status = 'approved', reviewed_by = $2, reviewed_at = NOW(), customer_id = $3 WHERE id = $1`,
      [id, req.user.id, customer.id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'customer.create', entityType: 'customer', entityId: customer.id, before: null, after: customer });
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'customer_signup.approve', entityType: 'customer_signup_request', entityId: id,
      before: { status: 'pending' }, after: { status: 'approved', customer_id: customer.id, customer_number: customer.customer_number, portal_account_id: acct.rows[0].id } });
    await logPortalAudit({ portalAccountId: acct.rows[0].id, customerId: customer.id, action: 'account_activated', details: { via: 'signup_request', request_id: id } });
    return res.json({ data: { request_id: id, customer } });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return res.status(500).json({ error: { message: 'Failed to approve signup request.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.post('/signup-requests/:id/reject', authenticateToken, requireRole(...STAFF_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(404).json(NOT_FOUND);
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!reason) return vErr(res, 'A reason is required to reject a request.');
  if (reason.length > 500) return vErr(res, 'Reason must be 500 characters or fewer.');
  try {
    const scope = await scopeZoneId(req.user);
    const cur = await pool.query('SELECT id, status, zone_id FROM customer_signup_requests WHERE id = $1', [id]);
    const r = cur.rows[0];
    if (!r || (scope !== null && r.zone_id !== scope)) return res.status(404).json(NOT_FOUND);
    const up = await pool.query(
      `UPDATE customer_signup_requests SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(), reject_reason = $3
       WHERE id = $1 AND status = 'pending' RETURNING id`,
      [id, req.user.id, reason]
    );
    if (!up.rows.length) return res.status(409).json(NOT_PENDING);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'customer_signup.reject', entityType: 'customer_signup_request', entityId: id,
      before: { status: 'pending' }, after: { status: 'rejected', reason } });
    return res.json({ data: { request_id: id, status: 'rejected' } });
  } catch (e) {
    return res.status(500).json({ error: { message: 'Failed to reject signup request.', code: 'INTERNAL' } });
  }
});

module.exports = router;
module.exports.normaliseSomalilandPhone = normaliseSomalilandPhone;
