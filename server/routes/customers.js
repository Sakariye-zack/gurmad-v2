const express = require('express');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
// P1 Functional Gaps — Customer Detail's Collection History section
// reuses Module 8's own getCollectionHistory(), exactly like
// customerPortal.js already does for the portal's equivalent view — no
// new query, no duplicated calculation.
const { getCollectionHistory } = require('../lib/reportsCalculations');
const { getInvoiceBalancesBulk, getCurrentExchangeRate, EPSILON } = require('../lib/financialCalculations');
const { toCsv } = require('../lib/csvImportExport'); // toCsv applies csvFormulaSafe to every cell
const { validateDr7ForCollector } = require('../lib/collectionValidation');
const { nationalDigits, formatPhoneLocal } = require('../lib/phone');
const { hierarchyParts } = require('../lib/hierarchy');

const router = express.Router();

const VALID_TYPES = ['residential', 'commercial'];
const VALID_STATUSES = ['active', 'suspended', 'archived'];
const VALID_SHIFTS = ['day', 'night'];
const BILLING_TYPES = ['monthly', 'daily'];
const FEE_CURRENCIES = ['USD', 'SLSH'];
const WEEK_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
const CUSTOMER_NUMBER_RE = /^C-\d{2,}$/;
// Matches reports.js's own OPERATIONAL_ROLES exactly — this endpoint
// exposes the identical data reports.js's collection-history route
// already does, just customer-scoped for the Customer Detail page.
const COLLECTION_HISTORY_ROLES = ['admin', 'gudoomiye', 'zone_accountant'];

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

// Door number (route #): trimmed; blank -> null; max 20 chars. Returns
// { value } or { error }.
function normaliseDoor(v) {
  if (v === undefined || v === null) return { value: null };
  if (typeof v !== 'string' && typeof v !== 'number') return { error: 'door_number must be a string or number.' };
  const s = String(v).trim();
  if (s === '') return { value: null };
  if (s.length > 20) return { error: 'door_number must be at most 20 characters.' };
  return { value: s };
}
// Customer # is C- + door digits (leading zeros ignored, min 2 digits).
function customerNumberFromDoor(door) {
  return 'C-' + String(door).replace(/^0+(?=\d)/, '').padStart(2, '0');
}

// Creates a pending door/number change request after checking the one-pending
// rule and uniqueness. Returns { request } or { status, error }.
async function createNumberRequest(user, current, { newDoor, newNumber }, db = pool) {
  const pending = await db.query(`SELECT id FROM customer_number_change_requests WHERE customer_id = $1 AND status = 'pending'`, [current.id]);
  if (pending.rows.length) return { status: 409, error: { message: 'This customer already has a pending door/number change request.', code: 'PENDING_EXISTS' } };
  const numDup = await db.query('SELECT id FROM customers WHERE customer_number = $1 AND id != $2', [newNumber, current.id]);
  if (numDup.rows.length) return { status: 409, error: { message: `Customer Number ${newNumber} is already assigned to another customer.`, code: 'DUPLICATE' } };
  if (newDoor) {
    const doorDup = await db.query('SELECT id FROM customers WHERE door_number = $1 AND id != $2', [newDoor, current.id]);
    if (doorDup.rows.length) return { status: 409, error: DOOR_DUP.error };
  }
  try {
    const r = await db.query(
      `INSERT INTO customer_number_change_requests (customer_id, old_door, new_door, old_number, new_number, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [current.id, current.door_number, newDoor, current.customer_number, newNumber, user.id]
    );
    const request = r.rows[0];
    return { request };
  } catch (err) {
    if (err.code === '23505') return { status: 409, error: { message: 'This customer already has a pending door/number change request.', code: 'PENDING_EXISTS' } };
    throw err;
  }
}

function auditNumberRequest(user, current, request) {
  return logAudit({ actorId: user.id, actorUsername: user.username, action: 'customer.number_change_request', entityType: 'customer', entityId: current.id,
    before: { door_number: current.door_number, customer_number: current.customer_number }, after: { door_number: request.new_door, customer_number: request.new_number, request_id: request.id } });
}

const DOOR_DUP = { error: { message: 'That door number is already used by another customer.', code: 'DUPLICATE' } };

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
  if (body.billing_type !== undefined) {
    if (body.billing_type !== null && !BILLING_TYPES.includes(body.billing_type)) errors.push(`billing_type must be one of: ${BILLING_TYPES.join(', ')}.`);
    else out.billing_type = body.billing_type;
  }
  if (body.fee_currency !== undefined) {
    if (!FEE_CURRENCIES.includes(body.fee_currency)) errors.push(`fee_currency must be one of: ${FEE_CURRENCIES.join(', ')}.`);
    else out.fee_currency = body.fee_currency;
  }
  if (body.work_days !== undefined) {
    if (body.work_days === null) out.work_days = null;
    else if (!Array.isArray(body.work_days) || body.work_days.some((d) => !WEEK_DAYS.includes(d))) errors.push(`work_days must be a list of: ${WEEK_DAYS.join(', ')}.`);
    else out.work_days = JSON.stringify(WEEK_DAYS.filter((d) => body.work_days.includes(d)));
  }
  if (body.notes !== undefined) {
    const notes = body.notes ? String(body.notes) : '';
    if (notes.length > 2000) {
      errors.push('notes must be 2000 characters or fewer.');
    } else {
      out.notes = notes || null;
    }
  }

  // Group & Group-Based Collection — Change Request, Implementation Spec
  // §6. group_id/route_id are OPTIONAL on every create/update (Locked
  // Decision §26-1: initially and indefinitely nullable, no forced/fake
  // default). null explicitly clears the field (a customer can be moved
  // back to ungrouped). Cross-entity validation (Group belongs to the
  // customer's Zone, Route belongs to the selected Group) happens in the
  // route handlers below, where the customer's own zone_id is known.
  if (body.group_id !== undefined) {
    if (body.group_id === null) {
      out.group_id = null;
    } else {
      const gid = parseStrictId(String(body.group_id));
      if (gid === null) errors.push('group_id must be a valid group id or null.');
      else out.group_id = gid;
    }
  }
  if (body.route_id !== undefined) {
    if (body.route_id === null) {
      out.route_id = null;
    } else {
      const rid = parseStrictId(String(body.route_id));
      if (rid === null) errors.push('route_id must be a valid route id or null.');
      else out.route_id = rid;
    }
  }

  return { errors, data: out };
}

// Group & Group-Based Collection — Change Request, Implementation Spec §6.
// Group must belong to the customer's own Zone; Route (if given) must
// belong to the EFFECTIVE group — `effectiveGroupId` is resolved by the
// caller as: the new group_id if this request is changing it, otherwise
// the customer's existing group_id (PUT) or undefined (POST, where
// group_id is always part of `data` when present). Returns an error
// message string, or null if valid.
async function validateGroupRoute(data, zoneId, effectiveGroupId) {
  if (data.group_id) {
    const g = await pool.query('SELECT zone_id FROM groups WHERE id = $1', [data.group_id]);
    if (g.rows.length === 0) return 'group_id does not reference an existing group.';
    if (g.rows[0].zone_id !== zoneId) return 'The selected group does not belong to this customer\'s zone.';
  }
  if (data.route_id) {
    const r = await pool.query('SELECT group_id FROM routes WHERE id = $1', [data.route_id]);
    if (r.rows.length === 0) return 'route_id does not reference an existing route.';
    if (!effectiveGroupId || r.rows[0].group_id !== effectiveGroupId) return 'The selected route does not belong to the selected group.';
  }
  return null;
}

async function assertZoneWritable(user, zoneId) {
  // Gudoomiye/zone_accountant may only write within their own zone.
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return true;
  const myZoneId = await resolveUserZoneId(user);
  return myZoneId !== null && myZoneId === zoneId;
}

// ---------------------------------------------------------------------------
// Customers list (GET /, /summary, /export.csv) — one shared query builder so
// the list, its summary cards and the CSV always apply the same scoping and
// filters.
//
// Scoping is exactly the historical one: gudoomiye/zone_accountant see their
// own zone, every other authenticated role sees all customers. Money data
// (balances, owes filter/totals, last payment) follows the invoice module's
// rules instead (routes/invoices.js VIEW_ROLES + zone scope, which also
// zone-scopes cashiers): roles outside BALANCE_ROLES never receive it, and a
// zone-scoped cashier only gets it for customers of their own zone.
// ---------------------------------------------------------------------------
const BALANCE_ROLES = ['admin', 'cashier', 'gudoomiye', 'zone_accountant'];
const BALANCE_ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'cashier'];
const LIST_SORTS = ['customer_number', 'name', 'balance', 'created_at', 'last_payment'];
const MONEY_SORTS = ['balance', 'last_payment'];
const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 100;
const CSV_MAX_ROWS = 20000;
const BULK_MAX = 500;
// Same "has a real location" rule as the Map page (routes/map.js).
const HAS_LOCATION_SQL = 'COALESCE(c.lat IS NOT NULL AND c.lng IS NOT NULL AND NOT (c.lat = 0 AND c.lng = 0), FALSE)';
// Effective work days: the customer's own override when set, else its Sub Zone's (lib/dailyLists.js rule).
const WORK_DAYS_SQL = `CASE WHEN jsonb_typeof(c.work_days) = 'array' AND jsonb_array_length(c.work_days) > 0 THEN c.work_days ELSE rt.work_days END`;
// Debts V2: a payment on a standalone debt (invoice_id NULL) is a payment too.
const LAST_PAYMENT_SQL = `GREATEST((SELECT MAX(p.created_at) FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.customer_id = c.id AND p.status = 'recorded'),
  (SELECT MAX(p.created_at) FROM payments p JOIN debts d ON d.id = p.debt_id WHERE d.customer_id = c.id AND p.status = 'recorded'))`;
const LIST_JOINS = `FROM customers c JOIN zones z ON c.zone_id = z.id
       LEFT JOIN groups g ON g.id = c.group_id
       LEFT JOIN routes rt ON rt.id = c.route_id
       LEFT JOIN group_zones gz ON gz.id = rt.group_zone_id
       LEFT JOIN v2_users col ON col.id = rt.collector_user_id
       LEFT JOIN customer_portal_accounts pa ON pa.customer_id = c.id`;
// Per-customer open balance, set-based, for FILTERING/SORTING/TOTALS only.
// Same rules as getInvoiceBalancesBulk (lib/financialCalculations.js):
// non-voided open invoices, recorded payments incl. method 'debt', USD
// invoice = SUM(amount_usd), SLSH invoice = frozen amount_invoice_currency
// with the legacy fallback at the payment's own / current rate, open when
// outstanding > EPSILON. The per-row figures the page DISPLAYS come from
// getInvoiceBalancesBulk itself (attachBalances below); a test asserts both
// agree with getInvoiceBalance.
const balanceLateral = (rateRef) => `LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(x.o) FILTER (WHERE x.cur = 'USD'), 0) AS usd,
                COALESCE(SUM(x.o) FILTER (WHERE x.cur = 'SLSH'), 0) AS slsh,
                COUNT(*)::int AS n
         FROM (
           SELECT CASE WHEN i.currency = 'SLSH' THEN 'SLSH' ELSE 'USD' END AS cur,
                  (i.invoice_total - i.discount_amount) - COALESCE((
                    SELECT SUM(CASE WHEN i.currency = 'SLSH'
                                    THEN COALESCE(p.amount_invoice_currency,
                                                  CASE WHEN p.currency = 'SLSH' THEN p.amount ELSE p.amount_usd * COALESCE(er.rate, ${rateRef}::numeric) END)
                                    ELSE p.amount_usd END)
                    FROM payments p LEFT JOIN exchange_rates er ON er.id = p.exchange_rate_id
                    WHERE p.invoice_id = i.id AND p.status = 'recorded'), 0) AS o
           FROM invoices i WHERE i.customer_id = c.id AND i.status IN ('unpaid', 'partial')
         ) x WHERE x.o > ${EPSILON}
       ) bal ON TRUE`;

async function resolveBalanceScope(user) {
  const role = (user.role || '').toLowerCase();
  if (!BALANCE_ROLES.includes(role)) return { allowed: false, zoneId: null };
  // Mirrors routes/invoices.js resolveUserZoneId exactly.
  if (!BALANCE_ZONE_SCOPED_ROLES.includes(role) || !user.zone) return { allowed: true, zoneId: null };
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return { allowed: true, zoneId: r.rows[0]?.id ?? null };
}

const qerr = (status, message, code = 'VALIDATION') => ({ error: { status, body: { error: { message, code } } } });

function flag(v) {
  if (v === undefined || v === '') return null;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return undefined; // invalid
}

// Builds WHERE/params/joins for the list family. `mode` is 'list', 'summary'
// or 'csv'. Returns { error } or the query parts.
async function buildCustomerQuery(req, mode) {
  const q = req.query;
  const myZoneId = await resolveUserZoneId(req.user);
  const bal = await resolveBalanceScope(req.user);
  const where = [];
  const params = [];
  const ph = (v) => { params.push(v); return `$${params.length}`; };

  if (myZoneId !== null) where.push(`c.zone_id = ${ph(myZoneId)}`);

  // status: legacy values keep their meaning ('archived', 'all', anything
  // else = not archived — e.g. callers passing 'active'); 'active_only' and
  // 'suspended' are the strict filters used by the redesigned list.
  const status = q.status;
  if (status === 'archived') where.push(`c.status = 'archived'`);
  else if (status === 'all') { /* no filter */ }
  else if (status === 'active_only') where.push(`c.status = 'active'`);
  else if (status === 'suspended') where.push(`c.status = 'suspended'`);
  else where.push(`c.status != 'archived'`);

  if (q.customer_type) {
    if (!VALID_TYPES.includes(q.customer_type)) return qerr(400, 'Invalid customer_type filter.');
    where.push(`c.customer_type = ${ph(q.customer_type)}`);
  }
  if (q.zone_id) {
    const zid = parseStrictId(String(q.zone_id));
    if (zid === null) return qerr(400, 'Invalid zone_id filter.');
    if (myZoneId !== null && zid !== myZoneId) return qerr(403, 'You do not have access to that zone.', 'FORBIDDEN');
    where.push(`c.zone_id = ${ph(zid)}`);
  }
  const searchTerm = q.q || q.search;
  if (typeof searchTerm === 'string' && searchTerm.trim()) {
    const term = searchTerm.trim();
    const like = ph(`%${term}%`);
    const conds = [`c.customer_number ILIKE ${like}`, `c.name ILIKE ${like}`, `c.business_name ILIKE ${like}`, `c.phone ILIKE ${like}`, `c.door_number ILIKE ${like}`];
    // Phone typed in any style (0634..., 634..., +252 63 ...) matches however it was stored.
    const digits = nationalDigits(term);
    if (digits) {
      const d = ph(`%${digits}`);
      conds.push(`regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g') LIKE ${d}`);
      conds.push(`regexp_replace(COALESCE(c.alternate_phone, ''), '\\D', '', 'g') LIKE ${d}`);
      conds.push(`regexp_replace(COALESCE(c.whatsapp, ''), '\\D', '', 'g') LIKE ${d}`);
    }
    where.push(`(${conds.join(' OR ')})`);
  }
  const idFilter = (name, sql) => {
    if (!q[name]) return null;
    const id = parseStrictId(String(q[name]));
    if (id === null) return qerr(400, `Invalid ${name} filter.`);
    where.push(sql(ph(id)));
    return null;
  };
  for (const [name, sql] of [
    ['group_id', (p) => `c.group_id = ${p}`],
    ['group_zone_id', (p) => `c.route_id IN (SELECT id FROM routes WHERE group_zone_id = ${p})`],
    ['route_id', (p) => `c.route_id = ${p}`],
    ['collector_id', (p) => `rt.collector_user_id = ${p}`],
  ]) {
    const e = idFilter(name, sql);
    if (e) return e;
  }
  if (q.billing_type) {
    if (!BILLING_TYPES.includes(q.billing_type)) return qerr(400, 'Invalid billing_type filter.');
    where.push(`c.billing_type = ${ph(q.billing_type)}`);
  }
  const hasLocation = flag(q.has_location);
  if (hasLocation === undefined) return qerr(400, 'has_location must be 0 or 1.');
  if (hasLocation !== null) where.push(hasLocation ? HAS_LOCATION_SQL : `NOT ${HAS_LOCATION_SQL}`);
  const noSubzone = flag(q.no_subzone);
  if (noSubzone === undefined) return qerr(400, 'no_subzone must be 0 or 1.');
  if (noSubzone === true) where.push('c.route_id IS NULL');
  const debt = flag(q.suspended_for_debt);
  if (debt === undefined) return qerr(400, 'suspended_for_debt must be 0 or 1.');
  if (debt === true) where.push(`c.status = 'suspended' AND c.suspended_reason = 'debt'`);
  const portal = flag(q.portal);
  if (portal === undefined) return qerr(400, 'portal must be 0 or 1.');
  if (portal === true) where.push(`pa.status = 'active'`);
  if (portal === false) where.push(`(pa.id IS NULL OR pa.status <> 'active')`);
  const owes = flag(q.owes);
  if (owes === undefined) return qerr(400, 'owes must be 0 or 1.');

  let sort = null;
  if (q.sort !== undefined && q.sort !== '') {
    if (!LIST_SORTS.includes(q.sort)) return qerr(400, `sort must be one of: ${LIST_SORTS.join(', ')}.`);
    sort = q.sort;
  }
  const dir = String(q.dir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const withBalance = mode === 'list' ? flag(q.with_balance) === true : mode === 'csv';

  // Money data is refused (not silently dropped) when explicitly asked for by a role that may not see it.
  if (!bal.allowed && ((mode === 'list' && withBalance) || owes === true || MONEY_SORTS.includes(sort))) {
    return qerr(403, 'You do not have access to customer balances.', 'FORBIDDEN');
  }

  // The balance lateral is only joined when something needs it.
  const needBal = bal.allowed && (owes !== null || sort === 'balance' || mode === 'summary');
  // Both values below are server-resolved numbers (a zones.id and the
  // exchange_rates rate), inlined as literals rather than bound parameters
  // because not every query built from these parts references them (an
  // unreferenced bound parameter is a Postgres error).
  let rateRef = 'NULL';
  let rateValue = null;
  let inBalZone = 'TRUE';
  if (bal.allowed && bal.zoneId !== null) inBalZone = `c.zone_id = ${Number(bal.zoneId)}`;
  if (needBal) {
    const rate = await getCurrentExchangeRate();
    rateValue = rate ? parseFloat(rate.rate) : null;
    if (Number.isFinite(rateValue)) rateRef = String(rateValue);
  }
  if (owes === true) where.push(`bal.n > 0 AND ${inBalZone}`);
  if (owes === false) where.push(`NOT (bal.n > 0 AND ${inBalZone})`);

  let orderSql = 'c.created_at DESC, c.id DESC';
  if (sort === 'customer_number') orderSql = `length(c.customer_number) ${dir}, c.customer_number ${dir}, c.id ${dir}`;
  else if (sort === 'name') orderSql = `lower(c.name) ${dir}, c.id ${dir}`;
  else if (sort === 'created_at') orderSql = `c.created_at ${dir}, c.id ${dir}`;
  // Balance: USD-equivalent of both currencies at the current rate (SLSH counts 0 without a rate).
  else if (sort === 'balance') orderSql = `(CASE WHEN ${inBalZone} THEN bal.usd + CASE WHEN ${rateRef}::numeric > 0 THEN bal.slsh / ${rateRef}::numeric ELSE 0 END ELSE 0 END) ${dir}, c.id ${dir}`;
  else if (sort === 'last_payment') orderSql = `(CASE WHEN ${inBalZone} THEN ${LAST_PAYMENT_SQL} END) ${dir} NULLS LAST, c.id ${dir}`;

  const joins = `${LIST_JOINS}${needBal ? `\n       ${balanceLateral(rateRef)}` : ''}`;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return { where, params, whereSql, joins, orderSql, bal, inBalZone, needBal, withBalance, rateValue };
}

function listSelect(built) {
  const { bal, inBalZone } = built;
  return `c.*, z.name AS zone_name, z.zone_code, gz.id AS group_zone_id, gz.name AS group_zone_name, gz.code AS group_zone_code,
              concat_ws(' › ', NULLIF(COALESCE(g.name, g.code), ''), z.name, NULLIF(COALESCE(gz.name, gz.code), ''), NULLIF(COALESCE(rt.name, rt.code), '')) AS path,
              g.code AS group_code, g.name AS group_name,
              rt.name AS route_name, rt.code AS route_code, rt.status AS route_status,
              rt.collector_user_id AS collector_id, COALESCE(col.full_name, col.username) AS collector_name,
              ${WORK_DAYS_SQL} AS effective_work_days,
              ${HAS_LOCATION_SQL} AS has_location,
              pa.status AS portal_status,
              ${bal.allowed ? `CASE WHEN ${inBalZone} THEN ${LAST_PAYMENT_SQL} END` : 'NULL::timestamp'} AS last_payment_at`;
}

// Per-row balances for the given customer rows, from getInvoiceBalancesBulk
// (ONE invoice query + ONE bulk balance query for the whole page — never
// per-row queries). Adds balance {USD, SLSH}, open_invoice_count and
// oldest_open_invoice_id; null for rows outside the viewer's balance scope.
async function attachBalances(rows, bal) {
  const eligible = [];
  for (const r of rows) {
    r.balance = null;
    r.open_invoice_count = null;
    r.oldest_open_invoice_id = null;
    if (bal.allowed && (bal.zoneId === null || r.zone_id === bal.zoneId)) {
      r.balance = { USD: 0, SLSH: 0 };
      r.open_invoice_count = 0;
      eligible.push(r);
    }
  }
  if (!eligible.length) return rows;
  const byId = new Map(eligible.map((r) => [r.id, r]));
  const inv = await pool.query(
    `SELECT id, customer_id FROM invoices WHERE customer_id = ANY($1::int[]) AND status IN ('unpaid', 'partial') ORDER BY created_at, id`,
    [eligible.map((r) => r.id)]
  );
  const balances = await getInvoiceBalancesBulk(inv.rows.map((r) => r.id));
  for (const i of inv.rows) {
    const b = balances.get(i.id);
    if (!b || !(b.outstanding > EPSILON)) continue;
    const row = byId.get(i.customer_id);
    row.balance[b.currency] += b.outstanding;
    row.open_invoice_count += 1;
    if (row.oldest_open_invoice_id === null) row.oldest_open_invoice_id = i.id;
  }
  for (const r of eligible) {
    r.balance.USD = Math.round(r.balance.USD * 100) / 100;
    r.balance.SLSH = Math.round(r.balance.SLSH * 100) / 100;
  }
  return rows;
}

const sendQueryError = (res, built) => res.status(built.error.status).json(built.error.body);

// GET /api/v2/customers — list, search, filter, sort, paginate. Zone-scoped
// for gudoomiye/zone_accountant, enforced server-side (closes the IDOR
// finding from Discovery §25 — every route re-checks scope, not just this
// one). Backwards compatible: without `page` it keeps the historical
// limit/offset behaviour (default 50, max 200) used by the pickers on other
// pages; with `page` it paginates (page_size default 25, max 100).
router.get('/', authenticateToken, async (req, res) => {
  try {
    const built = await buildCustomerQuery(req, 'list');
    if (built.error) return sendQueryError(res, built);
    const paged = req.query.page !== undefined && req.query.page !== '';
    let limit;
    let offset;
    let page = null;
    if (paged) {
      page = parseStrictId(String(req.query.page));
      if (page === null || page < 1) return res.status(400).json({ error: { message: 'page must be a positive integer.', code: 'VALIDATION' } });
      limit = Math.min(Math.max(parseInt(req.query.page_size, 10) || PAGE_SIZE_DEFAULT, 1), PAGE_SIZE_MAX);
      offset = (page - 1) * limit;
    } else {
      limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    }
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total ${built.joins} ${built.whereSql}`, built.params);
    const params = [...built.params, limit, offset];
    const result = await pool.query(
      `SELECT ${listSelect(built)}
       ${built.joins}
       ${built.whereSql}
       ORDER BY ${built.orderSql}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const rows = result.rows;
    if (built.withBalance) await attachBalances(rows, built.bal);
    const total = countResult.rows[0].total;
    const meta = { total, limit, offset };
    if (paged) Object.assign(meta, { page, page_size: limit, pages: Math.max(1, Math.ceil(total / limit)) });
    meta.can_see_balance = built.bal.allowed;
    res.json({ data: rows, meta });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list customers.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/customers/summary — counts for the list's summary cards, with
// the same scoping and filters as the list (pagination/sort ignored).
// `owing` is null for roles that may not see balances.
router.get('/summary', authenticateToken, async (req, res) => {
  try {
    const built = await buildCustomerQuery(req, 'summary');
    if (built.error) return sendQueryError(res, built);
    const owingCols = built.needBal
      ? `, COUNT(*) FILTER (WHERE bal.n > 0 AND ${built.inBalZone})::int AS owing_count,
           COALESCE(SUM(bal.usd) FILTER (WHERE ${built.inBalZone}), 0) AS owing_usd,
           COALESCE(SUM(bal.slsh) FILTER (WHERE ${built.inBalZone}), 0) AS owing_slsh`
      : '';
    const r = (await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE c.status = 'active')::int AS active,
              COUNT(*) FILTER (WHERE c.status = 'suspended')::int AS suspended,
              COUNT(*) FILTER (WHERE c.status = 'suspended' AND c.suspended_reason = 'debt')::int AS suspended_for_debt,
              COUNT(*) FILTER (WHERE NOT ${HAS_LOCATION_SQL})::int AS without_location,
              COUNT(*) FILTER (WHERE c.route_id IS NULL)::int AS without_subzone,
              COUNT(*) FILTER (WHERE pa.status = 'active')::int AS with_portal
              ${owingCols}
       ${built.joins} ${built.whereSql}`,
      built.params
    )).rows[0];
    const round2 = (v) => Math.round(parseFloat(v) * 100) / 100;
    res.json({ data: {
      total: r.total, active: r.active, suspended: r.suspended, suspended_for_debt: r.suspended_for_debt,
      without_location: r.without_location, without_subzone: r.without_subzone, with_portal: r.with_portal,
      owing: built.needBal ? { count: r.owing_count, USD: round2(r.owing_usd), SLSH: round2(r.owing_slsh) } : null,
    } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load customer summary.', code: 'INTERNAL' } });
  }
});

const DAY_LABELS = { sat: 'Sat', sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri' };

// GET /api/v2/customers/export.csv — the list's current filters, scoping and
// sort, as CSV (formula-safe). Over CSV_MAX_ROWS -> 413, never truncated.
// Balance columns only for roles that may see balances.
router.get('/export.csv', authenticateToken, async (req, res) => {
  try {
    const built = await buildCustomerQuery(req, 'csv');
    if (built.error) return sendQueryError(res, built);
    const rows = (await pool.query(
      `SELECT ${listSelect(built)} ${built.joins} ${built.whereSql}
       ORDER BY ${req.query.sort ? built.orderSql : 'length(c.customer_number), c.customer_number, c.id'}
       LIMIT ${CSV_MAX_ROWS + 1}`,
      built.params
    )).rows;
    if (rows.length > CSV_MAX_ROWS) {
      return res.status(413).json({ error: { message: `More than ${CSV_MAX_ROWS.toLocaleString('en-US')} customers match — narrow the filters and export again.`, code: 'TOO_MANY_ROWS' } });
    }
    if (built.bal.allowed) await attachBalances(rows, built.bal);
    const columns = [
      { key: 'customer_number', label: 'Customer #' }, { key: 'name', label: 'Name' }, { key: 'business_name', label: 'Business' },
      { key: 'customer_type', label: 'Type' }, { key: 'phone_fmt', label: 'Phone' }, { key: 'alternate_fmt', label: 'Alternate phone' },
      { key: 'whatsapp_fmt', label: 'WhatsApp' }, { key: 'h_group', label: 'Group' }, { key: 'h_district', label: 'District' },
      { key: 'h_zone', label: 'Zone' }, { key: 'h_subzone', label: 'Sub Zone' }, { key: 'door_number', label: 'Door #' },
      { key: 'billing_type', label: 'Billing type' }, { key: 'fee_fmt', label: 'Fee' }, { key: 'fee_currency', label: 'Fee currency' },
      { key: 'collector_name', label: 'Collector' }, { key: 'work_days_fmt', label: 'Work days' }, { key: 'status', label: 'Status' },
      { key: 'suspended_reason', label: 'Suspended reason' },
    ];
    if (built.bal.allowed) columns.push({ key: 'bal_usd', label: 'Balance USD' }, { key: 'bal_slsh', label: 'Balance SLSH' });
    const csv = toCsv(rows.map((r) => {
      const h = hierarchyParts(r);
      const days = Array.isArray(r.effective_work_days) ? r.effective_work_days : [];
      return {
        ...r,
        phone_fmt: formatPhoneLocal(r.phone), alternate_fmt: formatPhoneLocal(r.alternate_phone), whatsapp_fmt: formatPhoneLocal(r.whatsapp),
        h_group: h.group, h_district: h.district, h_zone: h.zone, h_subzone: h.subZone,
        fee_fmt: r.fee == null ? '' : (r.fee_currency === 'SLSH' ? String(Math.round(parseFloat(r.fee))) : parseFloat(r.fee).toFixed(2)),
        work_days_fmt: days.map((d) => DAY_LABELS[d] || d).join(' '),
        bal_usd: r.balance ? r.balance.USD.toFixed(2) : '',
        bal_slsh: r.balance ? String(Math.round(r.balance.SLSH)) : '',
      };
    }), columns);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + csv);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to export customers.', code: 'INTERNAL' } });
  }
});

// POST /api/v2/customers/bulk/assign-subzone {customer_ids (max 500), route_id}
// admin + gudoomiye (own zone). Moves customers to one Sub Zone (route) and
// its Group in ONE transaction, with the same hierarchy rules as
// PUT /:id (group belongs to the customer's district, route belongs to the
// group) and the same zone scope. Only route_id/group_id change — door /
// Customer # rules are untouched. Customers that cannot move are skipped
// with a reason (not_found, out_of_scope, archived, district_mismatch,
// already_assigned, collector_type_mismatch [DR-7]).
router.post('/bulk/assign-subzone', authenticateToken, requireRole('admin', 'gudoomiye'), async (req, res) => {
  const body = req.body || {};
  const raw = body.customer_ids;
  if (!Array.isArray(raw) || raw.length === 0) return res.status(400).json({ error: { message: 'customer_ids must be a non-empty list.', code: 'VALIDATION' } });
  if (raw.length > BULK_MAX) return res.status(400).json({ error: { message: `At most ${BULK_MAX} customers can be moved at once.`, code: 'TOO_MANY' } });
  const ids = [];
  for (const v of raw) {
    const id = typeof v === 'number' ? (Number.isInteger(v) && v > 0 ? v : null) : parseStrictId(String(v));
    if (!id) return res.status(400).json({ error: { message: 'customer_ids must contain customer ids only.', code: 'VALIDATION' } });
    if (!ids.includes(id)) ids.push(id);
  }
  const routeId = parseStrictId(String(body.route_id ?? ''));
  if (routeId === null) return res.status(400).json({ error: { message: 'route_id is required.', code: 'VALIDATION' } });

  const client = await pool.connect();
  let route;
  let updatedRows = [];
  const before = new Map();
  const skipped = [];
  try {
    await client.query('BEGIN');
    const rr = await client.query(
      `SELECT r.id, r.code, r.name, r.status, r.group_id, r.collector_user_id, g.zone_id, g.status AS group_status
       FROM routes r JOIN groups g ON g.id = r.group_id WHERE r.id = $1 FOR SHARE OF r`, [routeId]);
    route = rr.rows[0];
    if (!route) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Sub Zone not found.', code: 'NOT_FOUND' } }); }
    if (!(await assertZoneWritable(req.user, route.zone_id))) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'You cannot assign customers to a Sub Zone outside your zone.', code: 'FORBIDDEN' } });
    }
    if (route.status !== 'active' || route.group_status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'The selected Sub Zone (or its Group) is not active.', code: 'INACTIVE' } });
    }
    // DR-7: the Sub Zone's collector (same employee lookup as lib/dailyLists.js).
    const emp = route.collector_user_id
      ? (await client.query(`SELECT id FROM employees WHERE user_id = $1 AND status <> 'archived' ORDER BY id LIMIT 1`, [route.collector_user_id])).rows[0]
      : null;
    const myZoneId = ZONE_SCOPED_ROLES.includes((req.user.role || '').toLowerCase()) ? await resolveUserZoneId(req.user) : null;
    const scoped = myZoneId !== null || ZONE_SCOPED_ROLES.includes((req.user.role || '').toLowerCase());
    const custs = new Map((await client.query(
      `SELECT id, customer_number, zone_id, status, customer_type, commercial_shift, route_id, group_id
       FROM customers WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [ids])).rows.map((c) => [c.id, c]));
    const dr7Cache = new Map();
    const toMove = [];
    for (const id of ids) {
      const c = custs.get(id);
      if (!c) { skipped.push({ id, reason: 'not_found' }); continue; }
      if (scoped && c.zone_id !== myZoneId) { skipped.push({ id, reason: 'out_of_scope' }); continue; }
      if (c.status === 'archived') { skipped.push({ id, reason: 'archived' }); continue; }
      if (c.zone_id !== route.zone_id) { skipped.push({ id, reason: 'district_mismatch' }); continue; }
      if (c.route_id === route.id && c.group_id === route.group_id) { skipped.push({ id, reason: 'already_assigned' }); continue; }
      if (emp) {
        const shift = c.customer_type === 'commercial' ? (c.commercial_shift || 'day') : null;
        const key = `${c.customer_type}:${shift}`;
        if (!dr7Cache.has(key)) dr7Cache.set(key, await validateDr7ForCollector(emp.id, { customer_type: c.customer_type, commercial_shift: shift }));
        const dr7 = dr7Cache.get(key);
        if (!dr7.ok && dr7.code === 'DR7_BLOCK') { skipped.push({ id, reason: 'collector_type_mismatch', message: dr7.error }); continue; }
      }
      before.set(id, { route_id: c.route_id, group_id: c.group_id });
      toMove.push(id);
    }
    if (toMove.length) {
      updatedRows = (await client.query(
        `UPDATE customers SET route_id = $1, group_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = ANY($3::int[]) RETURNING id, route_id, group_id`,
        [route.id, route.group_id, toMove])).rows;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    return res.status(500).json({ error: { message: 'Failed to assign Sub Zone.', code: 'INTERNAL' } });
  }
  client.release();

  try {
    const actor = { actorId: req.user.id, actorUsername: req.user.username };
    for (const u of updatedRows) {
      const b = before.get(u.id);
      await logAudit({ ...actor, action: 'customer.update', entityType: 'customer', entityId: u.id,
        before: b, after: { route_id: u.route_id, group_id: u.group_id, via: 'bulk_assign_subzone' } });
      if (b.route_id !== u.route_id) await logAudit({ ...actor, action: 'customer.route_change', entityType: 'customer', entityId: u.id, before: { route_id: b.route_id }, after: { route_id: u.route_id } });
      if (b.group_id !== u.group_id) await logAudit({ ...actor, action: 'customer.group_change', entityType: 'customer', entityId: u.id, before: { group_id: b.group_id }, after: { group_id: u.group_id } });
    }
    await logAudit({ ...actor, action: 'customer.bulk_assign_subzone', entityType: 'route', entityId: route.id, before: null,
      after: { route_id: route.id, group_id: route.group_id, requested: ids.length, updated_ids: updatedRows.map((u) => u.id), skipped } });
  } catch (err) {
    // The move is committed; an audit write failure must not misreport it as failed.
    console.error('bulk assign-subzone audit failed:', err && err.message);
  }

  res.json({ data: { updated: updatedRows.length, updated_ids: updatedRows.map((u) => u.id), skipped } });
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

// GET /api/v2/customers/number-requests — door/number change requests
// (admin sees all; gudoomiye only their own zone). ?status=pending|approved|rejected|all, ?customer_id=
router.get('/number-requests', authenticateToken, requireRole('admin', 'gudoomiye'), async (req, res) => {
  try {
    const where = [];
    const params = [];
    const status = req.query.status || 'pending';
    if (status !== 'all') {
      if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: { message: 'Invalid status filter.', code: 'VALIDATION' } });
      params.push(status);
      where.push(`r.status = $${params.length}`);
    }
    if (req.query.customer_id) {
      const cid = parseStrictId(String(req.query.customer_id));
      if (cid === null) return res.status(400).json({ error: { message: 'Invalid customer_id filter.', code: 'VALIDATION' } });
      params.push(cid);
      where.push(`r.customer_id = $${params.length}`);
    }
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null) {
      params.push(myZoneId);
      where.push(`c.zone_id = $${params.length}`);
    }
    const result = await pool.query(
      `SELECT r.*, c.name AS customer_name, c.zone_id, u.username AS requested_by_username, u.full_name AS requested_by_name
       FROM customer_number_change_requests r
       JOIN customers c ON c.id = r.customer_id
       LEFT JOIN v2_users u ON u.id = r.requested_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY r.created_at DESC LIMIT 200`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list number change requests.', code: 'INTERNAL' } });
  }
});

// POST /api/v2/customers/number-requests/:id/approve — admin only. Re-checks
// uniqueness, then updates door + customer number in one transaction.
router.post('/number-requests/:id/approve', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid request id.', code: 'VALIDATION' } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rq = await client.query('SELECT * FROM customer_number_change_requests WHERE id = $1 FOR UPDATE', [id]);
    if (rq.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Request not found.', code: 'NOT_FOUND' } }); }
    const request = rq.rows[0];
    if (request.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: 'This request has already been decided.', code: 'NOT_PENDING' } }); }
    const cu = await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [request.customer_id]);
    const before = cu.rows[0];
    const numDup = await client.query('SELECT id FROM customers WHERE customer_number = $1 AND id != $2', [request.new_number, request.customer_id]);
    if (numDup.rows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: `Customer Number ${request.new_number} is now assigned to another customer.`, code: 'DUPLICATE' } }); }
    if (request.new_door) {
      const doorDup = await client.query('SELECT id FROM customers WHERE door_number = $1 AND id != $2', [request.new_door, request.customer_id]);
      if (doorDup.rows.length) { await client.query('ROLLBACK'); return res.status(409).json(DOOR_DUP); }
    }
    const upd = await client.query(
      `UPDATE customers SET door_number = $1, customer_number = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 RETURNING *`,
      [request.new_door, request.new_number, request.customer_id]
    );
    const done = await client.query(
      `UPDATE customer_number_change_requests SET status = 'approved', decided_by = $1, decided_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [req.user.id, id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'customer.number_change_approve', entityType: 'customer', entityId: request.customer_id,
      before: { door_number: before.door_number, customer_number: before.customer_number }, after: { door_number: upd.rows[0].door_number, customer_number: upd.rows[0].customer_number, request_id: id } });
    res.json({ data: done.rows[0], customer: upd.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: { message: 'That door or Customer Number is already used by another customer.', code: 'DUPLICATE' } });
    res.status(500).json({ error: { message: 'Failed to approve request.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// POST /api/v2/customers/number-requests/:id/reject — admin only.
router.post('/number-requests/:id/reject', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid request id.', code: 'VALIDATION' } });
  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim().slice(0, 500) : null;
  try {
    const r = await pool.query(
      `UPDATE customer_number_change_requests SET status = 'rejected', decided_by = $1, decided_at = CURRENT_TIMESTAMP, reason = $2
       WHERE id = $3 AND status = 'pending' RETURNING *`,
      [req.user.id, reason, id]
    );
    if (r.rows.length === 0) {
      const ex = await pool.query('SELECT status FROM customer_number_change_requests WHERE id = $1', [id]);
      if (ex.rows.length === 0) return res.status(404).json({ error: { message: 'Request not found.', code: 'NOT_FOUND' } });
      return res.status(409).json({ error: { message: 'This request has already been decided.', code: 'NOT_PENDING' } });
    }
    const request = r.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'customer.number_change_reject', entityType: 'customer', entityId: request.customer_id,
      before: { customer_number: request.old_number }, after: { requested_number: request.new_number, request_id: id, reason } });
    res.json({ data: request });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to reject request.', code: 'INTERNAL' } });
  }
});

// GET /api/v2/customers/:id
router.get('/:id', authenticateToken, async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid customer id.', code: 'VALIDATION' } });
  try {
    const result = await pool.query(`SELECT c.*, z.name AS zone_name, gz.id AS group_zone_id, gz.name AS group_zone_name, gz.code AS group_zone_code
       FROM customers c JOIN zones z ON c.zone_id = z.id
       LEFT JOIN routes rt ON rt.id = c.route_id LEFT JOIN group_zones gz ON gz.id = rt.group_zone_id
       WHERE c.id = $1`, [id]);
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

// GET /api/v2/customers/:id/collection-history — P1 Functional Gaps.
// Reuses getCollectionHistory() with the same wide "all time" window
// customerPortal.js's own equivalent route already established (the
// function requires explicit bounds; there is no separate "all time"
// mode). IDOR-checked identically to GET /:id above.
router.get('/:id/collection-history', authenticateToken, requireRole(...COLLECTION_HISTORY_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid customer id.', code: 'VALIDATION' } });
  try {
    const custRes = await pool.query('SELECT zone_id FROM customers WHERE id = $1', [id]);
    if (custRes.rows.length === 0) return res.status(404).json({ error: { message: 'Customer not found.', code: 'NOT_FOUND' } });
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && custRes.rows[0].zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this customer.', code: 'FORBIDDEN' } });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const rows = await getCollectionHistory({
      customerId: id, periodStart: '1970-01-01', periodEnd: new Date(Date.now() + 24 * 60 * 60 * 1000),
      limit, offset,
    });
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load collection history.', code: 'INTERNAL' } });
  }
});

// POST /api/v2/customers — admin, gudoomiye (own zone only).
// Reusable create — the ONE customer-creation path (staff form + portal
// signup approval). Runs every create rule (validation, door/number
// uniqueness, zone scope, group/route hierarchy, billing defaults). Uses
// `db` for the INSERT so a caller can run it inside its own transaction
// (the caller owns BEGIN/COMMIT and the audit write in that case).
// Returns { customer } or { status, body }.
async function createCustomer(user, body, db = null) {
  const { errors, data } = validateCustomerInput(body || {}, { partial: false });
  if (errors.length) return { status: 400, body: { error: { message: errors.join(' '), code: 'VALIDATION' } } };

  const door = normaliseDoor(body?.door_number);
  if (door.error) return { status: 400, body: { error: { message: door.error, code: 'VALIDATION' } } };
  if (door.value === null || !/^\d+$/.test(door.value)) {
    return { status: 400, body: { error: { message: 'door_number is required and must contain digits only.', code: 'VALIDATION' } } };
  }

  const writable = await assertZoneWritable(user, data.zone_id);
  if (!writable) {
    return { status: 403, body: { error: { message: 'You cannot create a customer outside your assigned zone.', code: 'FORBIDDEN' } } };
  }

  // Group must belong to the selected Zone; Route (if given) must belong to
  // the selected Group. Both are optional (§26-1).
  const groupRouteError = await validateGroupRoute(data, data.zone_id, data.group_id);
  if (groupRouteError) return { status: 400, body: { error: { message: groupRouteError, code: 'VALIDATION' } } };

  const customerNumber = customerNumberFromDoor(door.value); // leading zeros ignored: 09301 == 9301
  const dup = await pool.query('SELECT id FROM customers WHERE customer_number = $1', [customerNumber]);
  if (dup.rows.length) return { status: 409, body: { error: { message: `Customer Number ${customerNumber} is already assigned to another customer — use a different door number.`, code: 'DUPLICATE' } } };

  const ownTx = !db;
  const client = db || await pool.connect();
  try {
    if (ownTx) await client.query('BEGIN');
    else await client.query('SAVEPOINT create_customer');
    const result = await client.query(
      `INSERT INTO customers
        (customer_number, customer_type, name, business_name, phone, alternate_phone, whatsapp, email,
         address_line, zone_id, sub_zone, lat, lng, commercial_shift, collection_frequency, collection_mode,
         fee, notes, registered_by, group_id, route_id, door_number, billing_type, fee_currency, work_days)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       RETURNING *`,
      [customerNumber, data.customer_type, data.name, data.business_name ?? null, data.phone,
       data.alternate_phone ?? null, data.whatsapp ?? null, data.email ?? null, data.address_line ?? null,
       data.zone_id, data.sub_zone ?? null, data.lat ?? null, data.lng ?? null, data.commercial_shift ?? null,
       data.collection_frequency ?? null, data.collection_mode ?? null, data.fee ?? null, data.notes ?? null,
       user.id, data.group_id ?? null, data.route_id ?? null, door.value,
       // Houses are billed once a month; businesses per working day.
       data.billing_type ?? (data.customer_type === 'commercial' ? 'daily' : 'monthly'),
       data.fee_currency ?? 'USD', data.work_days ?? null]
    );
    if (ownTx) await client.query('COMMIT');
    else await client.query('RELEASE SAVEPOINT create_customer');
    const customer = result.rows[0];
    if (ownTx) await logAudit({ actorId: user.id, actorUsername: user.username, action: 'customer.create', entityType: 'customer', entityId: customer.id, before: null, after: customer });
    return { customer };
  } catch (err) {
    if (ownTx) await client.query('ROLLBACK');
    else await client.query('ROLLBACK TO SAVEPOINT create_customer');
    if (err.code === '23505') {
      if (err.constraint === 'idx_customers_door_number') return { status: 409, body: DOOR_DUP };
      return { status: 409, body: { error: { message: 'That Customer Number is already assigned to another customer.', code: 'DUPLICATE' } } };
    }
    // 23503 = FK violation — a zone_id that passed the strict-id format
    // check but doesn't reference a real zone (client error, not 500).
    if (err.code === '23503') {
      return { status: 400, body: { error: { message: 'zone_id does not reference an existing zone.', code: 'VALIDATION' } } };
    }
    return { status: 500, body: { error: { message: 'Failed to create customer.', code: 'INTERNAL' } } };
  } finally {
    if (ownTx) client.release();
  }
}

router.post('/', authenticateToken, requireRole('admin', 'gudoomiye'), async (req, res) => {
  const r = await createCustomer(req.user, req.body);
  if (r.customer) return res.status(201).json({ data: r.customer });
  return res.status(r.status).json(r.body);
});

// PUT /api/v2/customers/:id — general field edits. Does NOT allow
// customer_number changes (dedicated endpoint below) or status changes
// (dedicated endpoint below) — matches the Discovery's API design (§23).
router.put('/:id', authenticateToken, requireRole('admin', 'gudoomiye'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid customer id.', code: 'VALIDATION' } });

  const { errors, data } = validateCustomerInput(req.body, { partial: true });
  if (errors.length) return res.status(400).json({ error: { message: errors.join(' '), code: 'VALIDATION' } });
  // A changed door is never written here — it becomes an admin-approved request.
  let requestedDoor; // undefined = door not in body
  if (req.body && 'door_number' in req.body) {
    const door = normaliseDoor(req.body.door_number);
    if (door.error) return res.status(400).json({ error: { message: door.error, code: 'VALIDATION' } });
    requestedDoor = door.value;
  }
  if (Object.keys(data).length === 0 && requestedDoor === undefined) return res.status(400).json({ error: { message: 'No valid fields provided to update.', code: 'VALIDATION' } });

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

    // Group & Group-Based Collection — Change Request, Implementation Spec
    // §6/§7. effectiveZoneId/effectiveGroupId resolve what this update
    // leaves in effect (the new value if this request changes it,
    // otherwise the customer's current one) so a partial update (e.g.
    // route_id only) is still validated against the correct zone/group.
    const effectiveZoneId = data.zone_id !== undefined ? data.zone_id : current.zone_id;
    const effectiveGroupId = data.group_id !== undefined ? data.group_id : current.group_id;
    const groupRouteError = await validateGroupRoute(data, effectiveZoneId, effectiveGroupId);
    if (groupRouteError) return res.status(400).json({ error: { message: groupRouteError, code: 'VALIDATION' } });
    // District moved while keeping the current group: that group must belong to the new district.
    if (data.zone_id !== undefined && data.group_id === undefined && current.group_id && data.zone_id !== current.zone_id) {
      const g = await pool.query('SELECT zone_id FROM groups WHERE id = $1', [current.group_id]);
      if (g.rows[0] && g.rows[0].zone_id !== data.zone_id) {
        return res.status(400).json({ error: { message: 'The customer\'s current group does not belong to the new district — choose a group in that district (or none).', code: 'VALIDATION' } });
      }
    }

    // Door change (differs from current) -> pending request; other fields still apply.
    let numberRequest = null;
    let needRequest = false;
    if (requestedDoor !== undefined && requestedDoor !== (current.door_number ?? null)) {
      if (requestedDoor === null || !/^[0-9]+$/.test(requestedDoor)) {
        return res.status(400).json({ error: { message: 'door_number must contain digits only.', code: 'VALIDATION' } });
      }
      // Same derived C-number (e.g. 09401 vs 9401) is not a change: keep the current door.
      needRequest = customerNumberFromDoor(requestedDoor) !== current.customer_number;
      // Legacy customer with no door whose number already matches: just record the door.
      if (!needRequest && current.door_number == null) data.door_number = requestedDoor;
    }
    const hasOtherFields = Object.keys(data).length > 0;
    if (!hasOtherFields && !needRequest) {
      return res.status(200).json({ data: current });
    }

    const fields = Object.keys(data);
    const setSql = fields.map((f, i) => `${f} = $${i + 1}`).join(', ');
    const values = fields.map((f) => data[f]);
    values.push(id);
    const updateSql = `UPDATE customers SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`;

    let result = null;
    if (needRequest) {
      // Request + other-field UPDATE share one transaction (no orphan pending request).
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const made = await createNumberRequest(req.user, current, { newDoor: requestedDoor, newNumber: customerNumberFromDoor(requestedDoor) }, client);
        if (made.error) {
          await client.query('ROLLBACK');
          return res.status(made.status).json({ error: made.error });
        }
        numberRequest = made.request;
        if (hasOtherFields) result = await client.query(updateSql, values);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      await auditNumberRequest(req.user, current, numberRequest);
      if (!hasOtherFields) return res.status(202).json({ data: numberRequest });
    } else {
      result = await pool.query(updateSql, values);
    }
    const customer = result.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'customer.update', entityType: 'customer', entityId: customer.id, before: current, after: customer });
    if (data.zone_id !== undefined && data.zone_id !== current.zone_id) {
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'customer.zone_change', entityType: 'customer', entityId: customer.id, before: { zone_id: current.zone_id }, after: { zone_id: customer.zone_id } });
    }
    // Group & Group-Based Collection — Change Request, Implementation Spec
    // §7/§20/§26-2. A movement is JUST this audited field update — no
    // reconciliation of any existing batch/task is performed anywhere in
    // this route (Locked Decision: automatic active-batch/task
    // reconciliation is explicitly OUT OF SCOPE). Historical batches.group_id
    // is never touched here, since nothing in this codebase writes it from
    // a live join to customers.group_id (see routes/batches.js).
    if (data.group_id !== undefined && data.group_id !== current.group_id) {
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'customer.group_change', entityType: 'customer', entityId: customer.id, before: { group_id: current.group_id }, after: { group_id: customer.group_id } });
    }
    if (data.route_id !== undefined && data.route_id !== current.route_id) {
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'customer.route_change', entityType: 'customer', entityId: customer.id, before: { route_id: current.route_id }, after: { route_id: customer.route_id } });
    }
    res.json(numberRequest ? { data: customer, number_request: numberRequest } : { data: customer });
  } catch (err) {
    if (err.code === '23505' && err.constraint === 'idx_customers_door_number') return res.status(409).json(DOOR_DUP);
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

    // Customer # always equals C-<door>: derive the door from the number.
    const newDoor = newNumber.slice(2);
    const normalisedNumber = customerNumberFromDoor(newDoor);
    if (normalisedNumber === current.customer_number) {
      return res.status(400).json({ error: { message: 'That is already the current Customer Number.', code: 'VALIDATION' } });
    }
    // Number changes need admin approval.
    const made = await createNumberRequest(req.user, current, { newDoor, newNumber: normalisedNumber });
    if (made.error) return res.status(made.status).json({ error: made.error });
    await auditNumberRequest(req.user, current, made.request);
    return res.status(202).json({ data: made.request });
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

    // F3 debt suspension: a status set here is a manual decision. Leaving
    // 'suspended' clears the suspension fields; a fresh manual suspension is
    // recorded as reason 'manual' (never auto-reactivated). Re-saving an
    // already-suspended customer keeps its existing reason.
    const result = await pool.query(
      `UPDATE customers SET status = $1::varchar,
         suspended_reason = CASE WHEN $1::varchar <> 'suspended' THEN NULL WHEN status = 'suspended' THEN suspended_reason ELSE 'manual' END,
         suspended_at = CASE WHEN $1::varchar <> 'suspended' THEN NULL WHEN status = 'suspended' THEN suspended_at ELSE CURRENT_TIMESTAMP END,
         suspended_by = CASE WHEN $1::varchar <> 'suspended' THEN NULL WHEN status = 'suspended' THEN suspended_by ELSE $3::int END,
         updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
      [status, id, req.user.id]
    );
    const customer = result.rows[0];
    await logAudit({
      actorId: req.user.id, actorUsername: req.user.username, action: 'customer.status_change',
      entityType: 'customer', entityId: customer.id,
      before: { status: current.status, suspended_reason: current.suspended_reason ?? null },
      after: { status: customer.status, suspended_reason: customer.suspended_reason ?? null },
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
module.exports.createCustomer = createCustomer;
module.exports.resolveUserZoneId = resolveUserZoneId;
