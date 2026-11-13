const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');

const router = express.Router();

// Group & Group-Based Collection — Change Request. Implementation Spec §16
// (API Specification), §17 (RBAC), §8 (Group Detail Page). No new role is
// created (Locked Decision, §17) — Admin/Gudoomiye write (own zone for
// Gudoomiye), Zone Accountant/Collector read-only, matching every other
// V2 module's existing pattern exactly.
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'collector'];
const WRITE_ROLES = ['admin', 'gudoomiye'];
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const VALID_STATUSES = ['active', 'inactive'];
const VALID_TYPE_FILTERS = ['all', 'residential', 'commercial'];
const CODE_RE = /^.{1,30}$/;
// Groups V2 — same vocabularies as routes.work_days / customers billing.
const WEEK_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const BILLING_TYPES = ['monthly', 'daily'];
const FEE_CURRENCIES = ['USD', 'SLSH'];
const TEXT_MAX = 1000;
// Who can lead a Group: active staff, never collectors (customers are not
// v2_users at all). A leader with a district must be in the group's
// district; a company-wide user (no district, e.g. admin) is fine.
const LEADER_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier'];

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

async function assertZoneAccess(user, zoneId) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return true;
  const myZoneId = await resolveUserZoneId(user);
  return myZoneId !== null && myZoneId === zoneId;
}

// ---------- Group CRUD ----------

// GET /api/v2/groups — Spec §16. Zone-scoped for gudoomiye/zone_accountant,
// same server-side re-check pattern as every other V2 list endpoint (closes
// the IDOR class of finding the same way Customers/Batches already do).
router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const where = [];
    const params = [];
    if (myZoneId !== null) {
      params.push(myZoneId);
      where.push(`g.zone_id = $${params.length}`);
    }
    if (req.query.zone_id) {
      const zid = parseStrictId(req.query.zone_id);
      if (zid === null) return res.status(400).json({ error: { message: 'Invalid zone_id filter.', code: 'VALIDATION' } });
      if (myZoneId !== null && zid !== myZoneId) return res.status(403).json({ error: { message: 'You do not have access to that zone.', code: 'FORBIDDEN' } });
      params.push(zid);
      where.push(`g.zone_id = $${params.length}`);
    }
    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) return res.status(400).json({ error: { message: `status must be one of: ${VALID_STATUSES.join(', ')}.`, code: 'VALIDATION' } });
      params.push(req.query.status);
      where.push(`g.status = $${params.length}`);
    }
    const leaderErr = applyLeaderFilter(req.query.leader_user_id, where, params);
    if (leaderErr) return res.status(400).json({ error: { message: leaderErr, code: 'VALIDATION' } });
    // Search — Implementation Spec §7. code/name, zone-scope already applied
    // above. 2-character minimum: shorter q is silently ignored.
    if (req.query.q) {
      const q = req.query.q.trim();
      if (q.length >= 2) {
        params.push(`%${q}%`);
        const i = params.length;
        where.push(`(g.code ILIKE $${i} OR g.name ILIKE $${i})`);
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM groups g ${whereSql}`, params);
    params.push(limit, offset);
    // customer_count/route_count are ALWAYS live-derived (never a stored,
    // cacheable counter) — Spec §8's explicit instruction against
    // hardcoding, and the same reason "31+ groups, no fixed cap" holds:
    // this is a real, unbounded query, not a fixed-size lookup.
    const result = await pool.query(
      `SELECT g.*, z.name AS zone_name,
        COALESCE(lu.full_name, lu.username) AS leader_name, lu.is_active AS leader_active,
        (SELECT COUNT(*)::int FROM customers c WHERE c.group_id = g.id AND c.status = 'active') AS customer_count,
        (SELECT COUNT(*)::int FROM routes r WHERE r.group_id = g.id) AS route_count,
        (SELECT COUNT(*)::int FROM group_zones gz WHERE gz.group_id = g.id) AS group_zone_count,
        -- Distinct collectors assigned to this group's Sub Zones (read-only display).
        (SELECT COALESCE(json_agg(json_build_object('user_id', x.id, 'name', x.name) ORDER BY x.name, x.id), '[]'::json)
           FROM (SELECT DISTINCT u.id, COALESCE(u.full_name, u.username) AS name
                 FROM routes r JOIN v2_users u ON u.id = r.collector_user_id WHERE r.group_id = g.id) x) AS collectors
       FROM groups g LEFT JOIN zones z ON g.zone_id = z.id LEFT JOIN v2_users lu ON lu.id = g.leader_user_id
       ${whereSql} ORDER BY z.name NULLS LAST, g.zone_id, COALESCE(NULLIF(g.name, ''), g.code), g.id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const rows = result.rows.map((g) => ({
      ...g,
      collector_count: (g.collectors || []).length,
      // "Empty" chip: no active customers and no Sub Zones.
      is_empty: g.customer_count === 0 && g.route_count === 0,
    }));
    res.json({ data: rows, meta: { total: countResult.rows[0].total, limit, offset } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list groups.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/groups/summary — counts for the Groups list summary cards
// (read-only). Same zone scoping and filters as the list.
router.get('/summary', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const where = [];
    const params = [];
    if (myZoneId !== null) { params.push(myZoneId); where.push(`g.zone_id = $${params.length}`); }
    if (req.query.zone_id) {
      const zid = parseStrictId(req.query.zone_id);
      if (zid === null) return res.status(400).json({ error: { message: 'Invalid zone_id filter.', code: 'VALIDATION' } });
      if (myZoneId !== null && zid !== myZoneId) return res.status(403).json({ error: { message: 'You do not have access to that zone.', code: 'FORBIDDEN' } });
      params.push(zid); where.push(`g.zone_id = $${params.length}`);
    }
    if (req.query.status) {
      if (!VALID_STATUSES.includes(req.query.status)) return res.status(400).json({ error: { message: `status must be one of: ${VALID_STATUSES.join(', ')}.`, code: 'VALIDATION' } });
      params.push(req.query.status); where.push(`g.status = $${params.length}`);
    }
    const leaderErr = applyLeaderFilter(req.query.leader_user_id, where, params);
    if (leaderErr) return res.status(400).json({ error: { message: leaderErr, code: 'VALIDATION' } });
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = await pool.query(
      `WITH gs AS (SELECT g.id, g.leader_user_id FROM groups g ${whereSql}),
            rs AS (SELECT r.* FROM routes r WHERE r.group_id IN (SELECT id FROM gs))
       SELECT
         (SELECT COUNT(*)::int FROM gs) AS groups,
         (SELECT COUNT(*)::int FROM gs WHERE leader_user_id IS NULL) AS groups_without_leader,
         (SELECT COUNT(*)::int FROM rs) AS sub_zones,
         (SELECT COUNT(*)::int FROM customers c WHERE c.group_id IN (SELECT id FROM gs) AND c.status = 'active') AS customers,
         (SELECT COUNT(*)::int FROM rs WHERE status = 'active' AND collector_user_id IS NULL) AS sub_zones_no_collector,
         (SELECT COUNT(*)::int FROM rs WHERE status = 'active' AND cashier_user_id IS NULL) AS sub_zones_no_cashier,
         (SELECT COUNT(*)::int FROM rs WHERE status = 'active'
            AND (work_days IS NULL OR jsonb_typeof(work_days) <> 'array' OR jsonb_array_length(work_days) = 0)) AS sub_zones_no_work_days`,
      params
    );
    res.json({ data: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load group summary.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/groups/:id — Spec §8 (Group Detail Page).
router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid group id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query(
      `SELECT g.*, z.name AS zone_name, COALESCE(lu.full_name, lu.username) AS leader_name, lu.role AS leader_role, lu.is_active AS leader_active
       FROM groups g LEFT JOIN zones z ON g.zone_id = z.id LEFT JOIN v2_users lu ON lu.id = g.leader_user_id WHERE g.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: { message: 'Group not found.', code: 'NOT_FOUND' } });
    const group = result.rows[0];
    if (!(await assertZoneAccess(req.user, group.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this group.', code: 'FORBIDDEN' } });
    }
    const customerCount = await pool.query(`SELECT COUNT(*)::int AS n FROM customers WHERE group_id = $1 AND status = 'active'`, [id]);
    const routeCount = await pool.query(`SELECT COUNT(*)::int AS n FROM routes WHERE group_id = $1`, [id]);
    const routes = await pool.query(`SELECT r.*, gz.name AS group_zone_name, gz.code AS group_zone_code, u.full_name AS collector_name, u.is_active AS collector_active, tk.plate_number AS truck_plate, COALESCE(cu.full_name, cu.username) AS cashier_name, cu.is_active AS cashier_active, (SELECT COUNT(*)::int FROM customers c WHERE c.route_id = r.id AND c.status = 'active') AS customer_count FROM routes r LEFT JOIN v2_users u ON u.id = r.collector_user_id LEFT JOIN v2_users cu ON cu.id = r.cashier_user_id LEFT JOIN trucks tk ON tk.id = r.truck_id LEFT JOIN group_zones gz ON gz.id = r.group_zone_id WHERE r.group_id = $1 ORDER BY r.code`, [id]);
    const zones = await pool.query(`SELECT gz.*, (SELECT COUNT(*)::int FROM routes r WHERE r.group_zone_id = gz.id) AS route_count, (SELECT COUNT(*)::int FROM customers c JOIN routes r ON r.id = c.route_id WHERE r.group_zone_id = gz.id AND c.status = 'active') AS customer_count FROM group_zones gz WHERE gz.group_id = $1 ORDER BY gz.code`, [id]);
    // Read-only impact counts (Edit form summary + "set inactive" warning).
    const extra = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM customers c WHERE c.group_id = $1 AND c.status = 'active' AND c.route_id IS NULL) AS customers_without_subzone,
         (SELECT COUNT(*)::int FROM customers c JOIN routes r ON r.id = c.route_id WHERE c.group_id = $1 AND c.status = 'active' AND r.status = 'active') AS customers_in_active_subzones,
         (SELECT COUNT(*)::int FROM routes r WHERE r.group_id = $1 AND r.status = 'active') AS active_sub_zones,
         (SELECT COUNT(DISTINCT r.collector_user_id)::int FROM routes r WHERE r.group_id = $1 AND r.collector_user_id IS NOT NULL) AS collectors,
         (SELECT COUNT(DISTINCT r.cashier_user_id)::int FROM routes r WHERE r.group_id = $1 AND r.cashier_user_id IS NOT NULL) AS cashiers`,
      [id]
    );
    const x = extra.rows[0];
    res.json({
      data: {
        ...group,
        customer_count: customerCount.rows[0].n,
        route_count: routeCount.rows[0].n,
        routes: routes.rows,
        zones: zones.rows,
        counts: {
          customers: customerCount.rows[0].n,
          zones: zones.rows.length,
          sub_zones: routeCount.rows[0].n,
          active_sub_zones: x.active_sub_zones,
          collectors: x.collectors,
          cashiers: x.cashiers,
          customers_without_subzone: x.customers_without_subzone,
          customers_in_active_subzones: x.customers_in_active_subzones,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load group.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/groups/:id/customers — paginated customer list for the Group
// Detail page (Spec §8), filterable by status/customer_type/route_id.
router.get('/:id/customers', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid group id.', code: 'VALIDATION' } });
  try {
    const groupRes = await pool.query('SELECT zone_id FROM groups WHERE id = $1', [id]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: { message: 'Group not found.', code: 'NOT_FOUND' } });
    if (!(await assertZoneAccess(req.user, groupRes.rows[0].zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this group.', code: 'FORBIDDEN' } });
    }
    const where = ['c.group_id = $1'];
    const params = [id];
    if (req.query.status) { params.push(req.query.status); where.push(`c.status = $${params.length}`); }
    else { where.push(`c.status != 'archived'`); }
    if (req.query.customer_type) { params.push(req.query.customer_type); where.push(`c.customer_type = $${params.length}`); }
    if (req.query.route_id) {
      const rid = parseStrictId(req.query.route_id);
      if (rid === null) return res.status(400).json({ error: { message: 'Invalid route_id filter.', code: 'VALIDATION' } });
      params.push(rid); where.push(`c.route_id = $${params.length}`);
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM customers c WHERE ${where.join(' AND ')}`, params);
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT c.id, c.customer_number, c.name, c.business_name, c.customer_type, c.status, c.route_id
       FROM customers c WHERE ${where.join(' AND ')} ORDER BY c.name LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: result.rows, meta: { total: countResult.rows[0].total, limit, offset } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load group customers.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/groups/:id/eligible-customers — read-only preview, no side
// effects (Spec §16). Powers the Group-based batch-creation UI's Customer
// Type filter (Locked Decision #8 / §26-5): All / Residential / Commercial.
// The filter is a selection-narrowing convenience ONLY — it does not itself
// authorize anything; DR-7 is independently re-checked at actual batch
// creation time in routes/batches.js regardless of what this preview shows.
router.get('/:id/eligible-customers', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid group id.', code: 'VALIDATION' } });
  const filter = req.query.customer_type_filter || 'all';
  if (!VALID_TYPE_FILTERS.includes(filter)) {
    return res.status(400).json({ error: { message: `customer_type_filter must be one of: ${VALID_TYPE_FILTERS.join(', ')}.`, code: 'VALIDATION' } });
  }
  try {
    const groupRes = await pool.query('SELECT zone_id FROM groups WHERE id = $1', [id]);
    if (groupRes.rows.length === 0) return res.status(404).json({ error: { message: 'Group not found.', code: 'NOT_FOUND' } });
    if (!(await assertZoneAccess(req.user, groupRes.rows[0].zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this group.', code: 'FORBIDDEN' } });
    }
    const params = [id];
    let typeSql = '';
    if (filter !== 'all') { params.push(filter); typeSql = ` AND customer_type = $${params.length}`; }
    const result = await pool.query(
      `SELECT id, customer_type FROM customers WHERE group_id = $1 AND status = 'active'${typeSql}`,
      params
    );
    const residential = result.rows.filter((r) => r.customer_type === 'residential').length;
    const commercial = result.rows.filter((r) => r.customer_type === 'commercial').length;
    res.json({
      data: {
        customer_ids: result.rows.map((r) => r.id),
        count: result.rows.length,
        customer_type_breakdown: { residential, commercial },
      },
    });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to resolve eligible customers.', code: 'INTERNAL' } });
  }
});

function validateGroupInput(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  if (!partial) {
    const zoneId = parseStrictId(String(body.zone_id ?? ''));
    if (zoneId === null) errors.push('zone_id is required and must be a valid zone.');
    else out.zone_id = zoneId;
  }
  if (!partial || body.code !== undefined) {
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!CODE_RE.test(code)) errors.push('code is required and must be 1-30 characters.');
    else out.code = code;
  }
  if (body.name !== undefined) out.name = body.name === null ? null : String(body.name).trim().slice(0, 100) || null;
  if (body.status !== undefined) {
    if (!VALID_STATUSES.includes(body.status)) errors.push(`status must be one of: ${VALID_STATUSES.join(', ')}.`);
    else out.status = body.status;
  }
  // ---- Groups V2 fields (all optional) ----
  if (body.leader_user_id !== undefined) {
    if (body.leader_user_id === null || body.leader_user_id === '') out.leader_user_id = null;
    else {
      const lid = parseStrictId(String(body.leader_user_id));
      if (lid === null) errors.push('leader_user_id must be a valid user id or null.');
      else out.leader_user_id = lid;
    }
  }
  for (const f of ['description', 'notes']) {
    if (body[f] === undefined) continue;
    if (body[f] === null) { out[f] = null; continue; }
    if (typeof body[f] !== 'string') { errors.push(`${f} must be text.`); continue; }
    const v = body[f].trim();
    if (v.length > TEXT_MAX) errors.push(`${f} must be at most ${TEXT_MAX} characters.`);
    else out[f] = v || null;
  }
  // Map center: both or neither (same rule as routes.start_lat/start_lng).
  if (body.center_lat !== undefined || body.center_lng !== undefined) {
    const la = body.center_lat;
    const ln = body.center_lng;
    const blank = (v) => v === null || v === undefined || v === '';
    if (blank(la) && blank(ln)) { out.center_lat = null; out.center_lng = null; }
    else if (typeof la !== 'number' || typeof ln !== 'number' || !Number.isFinite(la) || !Number.isFinite(ln) || la < -90 || la > 90 || ln < -180 || ln > 180) {
      errors.push('center_lat and center_lng must both be valid coordinates (or both null).');
    } else { out.center_lat = la; out.center_lng = ln; }
  }
  if (body.default_work_days !== undefined) {
    if (body.default_work_days === null) out.default_work_days = null;
    else if (!Array.isArray(body.default_work_days) || body.default_work_days.some((d) => !WEEK_DAYS.includes(d))) errors.push(`default_work_days must be a list of: ${WEEK_DAYS.join(', ')}.`);
    else {
      const days = WEEK_DAYS.filter((d) => body.default_work_days.includes(d));
      out.default_work_days = days.length ? JSON.stringify(days) : null;
    }
  }
  if (body.default_billing_type !== undefined) {
    if (body.default_billing_type === null || body.default_billing_type === '') out.default_billing_type = null;
    else if (!BILLING_TYPES.includes(body.default_billing_type)) errors.push(`default_billing_type must be one of: ${BILLING_TYPES.join(', ')}.`);
    else out.default_billing_type = body.default_billing_type;
  }
  if (body.default_fee_currency !== undefined) {
    if (body.default_fee_currency === null || body.default_fee_currency === '') out.default_fee_currency = null;
    else if (!FEE_CURRENCIES.includes(body.default_fee_currency)) errors.push(`default_fee_currency must be one of: ${FEE_CURRENCIES.join(', ')}.`);
    else out.default_fee_currency = body.default_fee_currency;
  }
  if (body.default_fee !== undefined) {
    if (body.default_fee === null || body.default_fee === '') out.default_fee = null;
    else if (typeof body.default_fee !== 'number' || !Number.isFinite(body.default_fee) || body.default_fee < 0) errors.push('default_fee must be a non-negative number.');
    else out.default_fee = body.default_fee;
  }
  return { errors, data: out };
}

// ?leader_user_id=<id> or ?leader_user_id=none (groups with no leader).
function applyLeaderFilter(raw, where, params) {
  if (raw === undefined || raw === '') return null;
  if (raw === 'none') { where.push('g.leader_user_id IS NULL'); return null; }
  const lid = parseStrictId(String(raw));
  if (lid === null) return 'Invalid leader_user_id filter.';
  params.push(lid);
  where.push(`g.leader_user_id = $${params.length}`);
  return null;
}

// Group leader: an ACTIVE staff user (LEADER_ROLES — never a collector) who
// is company-wide (no district) or works in the group's district.
async function leaderError(leaderId, districtId) {
  if (leaderId === undefined || leaderId === null) return null;
  const r = await pool.query(
    'SELECT u.role, u.is_active, u.zone, z.id AS zone_id FROM v2_users u LEFT JOIN zones z ON z.name = u.zone WHERE u.id = $1', [leaderId]);
  const u = r.rows[0];
  if (!u || !LEADER_ROLES.includes((u.role || '').toLowerCase()) || !u.is_active) {
    return 'leader_user_id must reference an active staff user (not a collector).';
  }
  if (u.zone && (u.zone_id === null || Number(u.zone_id) !== Number(districtId))) return 'That leader does not work in this district.';
  return null;
}

// POST /api/v2/groups — admin, gudoomiye (own zone). No fixed cap on Group
// count per Zone (Locked Decision #1 / Hierarchy — "31+ groups, no
// hardcoded maximum"): this is a real, unbounded table, not an enum.
router.post('/', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const { errors, data } = validateGroupInput(req.body, { partial: false });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  if (!(await assertZoneAccess(req.user, data.zone_id))) {
    return res.status(403).json({ error: { message: 'You cannot create a group outside your assigned zone.', code: 'FORBIDDEN' } });
  }
  try {
    const lErr = await leaderError(data.leader_user_id, data.zone_id);
    if (lErr) return res.status(400).json({ error: { message: lErr, code: 'VALIDATION' } });
    const dup = await pool.query('SELECT id FROM groups WHERE zone_id = $1 AND code = $2', [data.zone_id, data.code]);
    if (dup.rows.length) return res.status(409).json({ error: { message: `Group code "${data.code}" is already in use in this zone.`, code: 'DUPLICATE' } });

    const result = await pool.query(
      `INSERT INTO groups (zone_id, code, name, status, created_by, leader_user_id, description, center_lat, center_lng,
                           default_work_days, default_billing_type, default_fee_currency, default_fee, notes)
       VALUES ($1,$2,$3,COALESCE($4,'active'),$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [data.zone_id, data.code, data.name ?? null, data.status ?? null, req.user.id, data.leader_user_id ?? null, data.description ?? null,
        data.center_lat ?? null, data.center_lng ?? null, data.default_work_days ?? null, data.default_billing_type ?? null,
        data.default_fee_currency ?? null, data.default_fee ?? null, data.notes ?? null]
    );
    const group = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'group.create', entityType: 'group', entityId: group.id, before: null, after: group });
    res.status(201).json({ data: group });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'Group code is already in use in this zone.', code: 'DUPLICATE' } });
    if (err.code === '23503') return res.status(400).json({ error: { message: 'zone_id does not reference an existing zone.', code: 'VALIDATION' } });
    res.status(500).json({ error: { message: 'Failed to create group.', code: 'INTERNAL' } });
  }
});

// PUT /api/v2/groups/:id — admin, gudoomiye (own zone). zone_id is
// immutable via this route (not accepted) — moving a Group to a different
// Zone is a materially different, undecided operation (Discovery §26 non-
// blocking item on renaming/lifecycle), not silently allowed here.
router.put('/:id', authenticateToken, requireRole(...WRITE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid group id.', code: 'VALIDATION' } });
  const { errors, data } = validateGroupInput(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  if (Object.keys(data).length === 0) return res.status(400).json({ error: { message: 'No valid fields provided to update.', code: 'VALIDATION' } });
  try {
    const existing = await pool.query('SELECT * FROM groups WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: { message: 'Group not found.', code: 'NOT_FOUND' } });
    const current = existing.rows[0];
    if (!(await assertZoneAccess(req.user, current.zone_id))) {
      return res.status(403).json({ error: { message: 'You do not have access to this group.', code: 'FORBIDDEN' } });
    }
    // An unchanged leader is not re-checked (they may since have been deactivated).
    const lErr = data.leader_user_id !== undefined && data.leader_user_id === current.leader_user_id ? null : await leaderError(data.leader_user_id, current.zone_id);
    if (lErr) return res.status(400).json({ error: { message: lErr, code: 'VALIDATION' } });
    if (data.code) {
      const dup = await pool.query('SELECT id FROM groups WHERE zone_id = $1 AND code = $2 AND id != $3', [current.zone_id, data.code, id]);
      if (dup.rows.length) return res.status(409).json({ error: { message: `Group code "${data.code}" is already in use in this zone.`, code: 'DUPLICATE' } });
    }
    const fields = Object.keys(data);
    const setSql = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = fields.map((f) => data[f]);
    values.push(id);
    const result = await pool.query(`UPDATE groups SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`, values);
    const group = result.rows[0];
    await logAudit({
      actorId: req.user.id, actorUsername: req.user.username,
      action: data.status !== undefined && data.status !== current.status ? 'group.status_change' : 'group.update',
      entityType: 'group', entityId: group.id, before: current, after: group,
    });
    res.json({ data: group });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'Group code is already in use in this zone.', code: 'DUPLICATE' } });
    res.status(500).json({ error: { message: 'Failed to update group.', code: 'INTERNAL' } });
  }
});

// DELETE is deliberately not implemented — matches the existing Zones/
// Customers convention of archive-via-status rather than hard delete, and
// avoids the unresolved question of what happens to customers/routes/
// batches still referencing a deleted Group.

module.exports = router;
