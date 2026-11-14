const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { pool, logAudit } = require('../db');
const { sniffFileType } = require('../lib/fileSniff');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  computeExpectedForPeriod, hasOverlappingCashout, EPSILON, DENOMINATIONS, CURRENCIES,
  getCashoutControls, getCurrentRate, computeBreakdownForPeriod, listElectronicPayments, normalizeCashCount,
  normalizeElectronicConfirm, resolveElectronicConfirm, buildBreakdown, classifyVariance, computeDepositStatus, requiredDeposit,
  listUncoveredPayments,
} = require('../lib/cashoutCalculations');
const { computeAssignment } = require('../lib/cashierAssignment');
const { getTimezone } = require('../lib/autoBilling');
const { buildCashoutDocx } = require('../lib/documentGenerators');
const { rejectIfInfected } = require('../lib/virusScan');
const { createStaffNotification, logNotificationFailure } = require('../lib/staffNotifications');

const router = express.Router();

// Workflow clarification (this checkpoint): Cashier receives/records money
// (Module 6, already closed); Head of Cashiers performs/manages the Cashout
// & reconciliation. Create/manage authority sits with Head of Cashiers (+
// Admin), NOT the cashier — a deliberate narrowing from the original
// Discovery's carried-forward RBAC, per this turn's explicit business
// clarification, not silently invented.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
const VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'];
const CREATE_ROLES = ['admin', 'head_of_cashiers'];
const APPROVE_ROLES = ['admin', 'gudoomiye']; // frozen, unchanged from Discovery §12
const VOID_ROLES = ['admin'];
// Resolving a cashier shortage is a management action, same authority
// tier as creating the cashout itself — not an approval-tier action.
const RESOLVE_SHORTAGE_ROLES = ['admin', 'head_of_cashiers'];
// Cashout V2 deposit step: Head of Cashiers records where approved cash
// went; only an admin verifies it (and never their own deposit).
const DEPOSIT_RECORD_ROLES = ['admin', 'head_of_cashiers'];
const DEPOSIT_ACCOUNT_TYPES = ['safe', 'bank', 'mobile'];
const DEPOSIT_STATUSES = ['not_required', 'not_deposited', 'partial', 'deposited', 'verified', 'variance'];
// A cashout may not cover time that has not happened yet (V2 body only —
// the legacy body keeps its original rules). One minute of clock skew.
const FUTURE_SKEW_MS = 60 * 1000;

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'cashouts');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — signed slips/photos, not a general DMS
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.includes(file.mimetype)),
});
const DOCUMENT_TYPES = ['signed_cashout_form', 'deposit_slip', 'cash_handover_evidence', 'receipt', 'shortage_explanation', 'approval_document', 'other', 'merchant_statement'];
const kindOf = (documentType) => (documentType === 'merchant_statement' ? 'statement' : documentType === 'signed_cashout_form' ? 'signed' : 'other');
// True when the cashout holds manually recorded ZAAD/eDahab money, i.e. a
// merchant statement should back it.
function needsStatement(cashout) {
  const c = cashout.breakdown && cashout.breakdown.currencies;
  if (!c) return false;
  return ['USD', 'SLSH'].some((cur) => ['zaad', 'edahab'].some((m) => Number(c[cur] && c[cur][m] && c[cur][m].manual_expected) > 0));
}

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

async function generateCashoutNumber(client) {
  const seq = await client.query(`SELECT nextval('cashout_number_seq') AS n`);
  const n = Number(seq.rows[0].n);
  return `CO-${String(n).padStart(6, '0')}`;
}

const isZoneScoped = (user) => ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase());
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s));

// Deposits of the given cashouts (with account + people names), grouped by cashout id.
async function loadDeposits(cashoutIds, client = pool) {
  const byId = new Map();
  if (!cashoutIds.length) return byId;
  const r = await client.query(
    `SELECT d.*, a.name AS account_name, a.type AS account_type,
            dep.full_name AS deposited_by_name, dep.username AS deposited_by_username,
            ver.full_name AS verified_by_name, ver.username AS verified_by_username
     FROM cashout_deposits d
     JOIN cashout_deposit_accounts a ON a.id = d.deposit_account_id
     LEFT JOIN v2_users dep ON dep.id = d.deposited_by
     LEFT JOIN v2_users ver ON ver.id = d.verified_by
     WHERE d.cashout_id = ANY($1::int[])
     ORDER BY d.deposited_at ASC, d.id ASC`,
    [cashoutIds]
  );
  for (const row of r.rows) {
    if (!byId.has(row.cashout_id)) byId.set(row.cashout_id, []);
    byId.get(row.cashout_id).push(row);
  }
  return byId;
}

// Exchange rate in force when each legacy cashout (no counted breakdown,
// legacy slsh_amount present) was created — values its SLSH cash to deposit.
async function loadLegacyRates(cashouts, client = pool) {
  const ids = cashouts.filter((c) => !(c.breakdown && c.breakdown.mode === 'counted') && Number(c.slsh_amount) > 0.004).map((c) => c.id);
  const out = new Map();
  if (!ids.length) return out;
  const r = await client.query(
    `SELECT co.id, (SELECT er.rate FROM exchange_rates er WHERE er.effective_from <= co.created_at ORDER BY er.effective_from DESC LIMIT 1) AS rate
     FROM cashouts co WHERE co.id = ANY($1::int[])`, [ids]);
  for (const row of r.rows) if (row.rate !== null) out.set(row.id, Number(row.rate));
  return out;
}

// Derived deposit fields. Only an APPROVED cashout has a deposit status.
function depositInfo(cashout, deposits = [], legacyRate = null) {
  const required = requiredDeposit(cashout, legacyRate);
  const deposited = { USD: 0, SLSH: 0 };
  for (const d of deposits) if (!d.voided_at) deposited[d.currency] += Number(d.amount);
  return {
    deposit_status: cashout.status === 'approved' ? computeDepositStatus(required, deposits) : null,
    deposit_required: required,
    deposited: { USD: Number(deposited.USD.toFixed(2)), SLSH: Number(deposited.SLSH.toFixed(2)) },
  };
}

// Who did what, when — from the audit log for this cashout and its
// attachments / shortage / deposits. Action + actor + time only (never the
// before/after payloads, which can carry storage internals).
async function loadTimeline(cashoutId, client = pool) {
  const r = await client.query(
    `SELECT a.id, a.action, a.actor_username, a.created_at, a.entity_type, a.entity_id,
            a.after_data->>'reason' AS reason, a.after_data->>'rejection_reason' AS rejection_reason,
            a.after_data->>'voided_reason' AS voided_reason, a.after_data->>'document_type' AS document_type
     FROM v2_audit_log a
     WHERE (a.entity_type = 'cashout' AND a.entity_id = $1)
        OR (a.entity_type = 'cashout_attachment' AND a.entity_id IN (SELECT id FROM cashout_attachments WHERE cashout_id = $1))
        OR (a.entity_type = 'cashout_shortage' AND a.entity_id IN (SELECT id FROM cashout_shortages WHERE cashout_id = $1))
        OR (a.entity_type = 'cashout_deposit' AND a.entity_id IN (SELECT id FROM cashout_deposits WHERE cashout_id = $1))
     ORDER BY a.created_at ASC, a.id ASC`,
    [cashoutId]
  );
  return r.rows.map((x) => ({
    id: x.id, action: x.action, actor: x.actor_username, at: x.created_at, entity_type: x.entity_type,
    note: x.action === 'cashout.reject' ? x.rejection_reason : x.action === 'cashout.void' ? x.voided_reason : (x.document_type || x.reason || null),
  }));
}

const CASHOUT_DETAIL_SQL = `
  SELECT cashouts.*, zones.name AS zone_name,
         cashier.full_name AS cashier_name, cashier.username AS cashier_username,
         hoc.full_name AS head_of_cashiers_name, hoc.username AS head_of_cashiers_username,
         preparer.full_name AS created_by_name, preparer.username AS created_by_username,
         approver.full_name AS approved_by_name, approver.username AS approved_by_username
  FROM cashouts
  LEFT JOIN zones ON cashouts.zone_id = zones.id
  LEFT JOIN v2_users cashier ON cashier.id = cashouts.cashier_id
  LEFT JOIN v2_users hoc ON hoc.id = cashouts.head_of_cashiers_id
  LEFT JOIN v2_users preparer ON preparer.id = cashouts.created_by
  LEFT JOIN v2_users approver ON approver.id = cashouts.approved_by
  WHERE cashouts.id = $1`;

// ---------- List / Detail ----------

router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const where = [];
    const params = [];
    if (myZoneId !== null) { params.push(myZoneId); where.push(`cashouts.zone_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); where.push(`cashouts.status = $${params.length}`); }
    // V2 filters (all optional, additive): district, cashier, period range,
    // needs-admin, deposit status (derived, applied after the query).
    if (req.query.zone_id) {
      const z = parseStrictId(String(req.query.zone_id));
      if (z === null) return res.status(400).json({ error: { message: 'zone_id must be a numeric id.', code: 'VALIDATION' } });
      params.push(z); where.push(`cashouts.zone_id = $${params.length}`);
    }
    if (req.query.cashier_id) {
      const c = parseStrictId(String(req.query.cashier_id));
      if (c === null) return res.status(400).json({ error: { message: 'cashier_id must be a numeric id.', code: 'VALIDATION' } });
      params.push(c); where.push(`cashouts.cashier_id = $${params.length}`);
    }
    if (req.query.date_from) {
      if (!isDate(req.query.date_from)) return res.status(400).json({ error: { message: 'date_from must be YYYY-MM-DD.', code: 'VALIDATION' } });
      params.push(req.query.date_from); where.push(`cashouts.period_end > $${params.length}::date`);
    }
    if (req.query.date_to) {
      if (!isDate(req.query.date_to)) return res.status(400).json({ error: { message: 'date_to must be YYYY-MM-DD.', code: 'VALIDATION' } });
      params.push(req.query.date_to); where.push(`cashouts.period_start < ($${params.length}::date + 1)`);
    }
    if (req.query.needs_admin === '1') where.push('cashouts.needs_admin = TRUE');
    if (req.query.has_shortage === '1') where.push(`cashouts.shortage > 0 AND cashouts.status IN ('pending', 'approved')`);
    const depositFilter = req.query.deposit_status || null;
    if (depositFilter && !DEPOSIT_STATUSES.includes(depositFilter)) {
      return res.status(400).json({ error: { message: `deposit_status must be one of: ${DEPOSIT_STATUSES.join(', ')}.`, code: 'VALIDATION' } });
    }
    // P1 Functional Gaps — q search (2-char minimum, same ILIKE pattern as
    // every other module): cashout number, and (V2) the cashier's name.
    if (req.query.q) {
      const q = req.query.q.trim();
      if (q.length >= 2) {
        params.push(`%${q}%`);
        where.push(`(cashouts.cashout_number ILIKE $${params.length} OR cashier.full_name ILIKE $${params.length} OR cashier.username ILIKE $${params.length})`);
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT cashouts.*, zones.name AS zone_name, cashier.full_name AS cashier_name, cashier.username AS cashier_username,
        (SELECT COUNT(*) FROM cashout_attachments ca WHERE ca.cashout_id = cashouts.id AND ca.voided_at IS NULL AND ca.document_type = 'signed_cashout_form') > 0 AS has_signed_document
       FROM cashouts LEFT JOIN zones ON cashouts.zone_id = zones.id
       LEFT JOIN v2_users cashier ON cashier.id = cashouts.cashier_id
       ${whereSql} ORDER BY cashouts.created_at DESC`,
      params
    );
    const approved = result.rows.filter((r) => r.status === 'approved');
    const deposits = await loadDeposits(approved.map((r) => r.id));
    const rates = await loadLegacyRates(approved);
    let rows = result.rows.map(({ covered_payment_ids: ids, ...r }) => ({ ...r, covered_payment_count: ids ? ids.length : null, ...depositInfo(r, deposits.get(r.id) || [], rates.get(r.id)) }));
    if (depositFilter) rows = rows.filter((r) => r.deposit_status === depositFilter);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list cashouts.', code: 'INTERNAL' } });
  }
});

// GET /meta — what the New Cashout form needs: the denominations (single
// source: lib/cashoutCalculations.js), the current tolerance/threshold and
// the active deposit accounts. Registered BEFORE '/:id'.
router.get('/meta', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const controls = await getCashoutControls();
    const accounts = await pool.query(`SELECT id, name, type, account_ref FROM cashout_deposit_accounts WHERE active = TRUE ORDER BY name`);
    const since = await require('../lib/cashoutCalculations').getCashoutV2Since();
    res.json({ data: { denominations: DENOMINATIONS, currencies: CURRENCIES, controls, deposit_accounts: accounts.rows, cashout_v2_since: since } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load cashout settings.', code: 'INTERNAL' } });
  }
});

// GET /summary — list-page cards: received this month per currency (live
// cashouts created this month), pending / needs-admin / with-shortage
// counts, and approved cashouts whose cash is not fully deposited.
router.get('/summary', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const zoneSql = myZoneId !== null ? 'AND zone_id = $1' : '';
    const params = myZoneId !== null ? [myZoneId] : [];
    const counts = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'pending' AND needs_admin)::int AS needs_admin,
              COUNT(*) FILTER (WHERE status IN ('pending', 'approved') AND shortage > 0)::int AS with_shortage
       FROM cashouts WHERE TRUE ${zoneSql}`, params);
    // "This month" in the company's timezone.
    const tz = await getTimezone();
    const tzParam = `$${params.length + 1}`;
    const month = await pool.query(
      `SELECT breakdown, actual_amount FROM cashouts
       WHERE status IN ('pending', 'approved')
         AND created_at >= (date_trunc('month', NOW() AT TIME ZONE ${tzParam}) AT TIME ZONE ${tzParam}) ${zoneSql}`, [...params, tz]);
    const received = { USD: 0, SLSH: 0 };
    for (const r of month.rows) {
      const b = r.breakdown;
      if (b && b.mode === 'counted' && b.totals) { received.USD += Number(b.totals.USD.actual || 0); received.SLSH += Number(b.totals.SLSH.actual || 0); }
      else received.USD += Number(r.actual_amount || 0);
    }
    const approved = await pool.query(
      `SELECT id, status, breakdown, cash_amount, slsh_amount, deposit_exempt FROM cashouts WHERE status = 'approved' ${zoneSql}`, params);
    const deposits = await loadDeposits(approved.rows.map((r) => r.id));
    const rates = await loadLegacyRates(approved.rows);
    let notDeposited = 0;
    let unverified = 0;
    for (const r of approved.rows) {
      const ds = deposits.get(r.id) || [];
      const st = depositInfo(r, ds, rates.get(r.id)).deposit_status;
      if (st === 'not_deposited' || st === 'partial' || st === 'variance') notDeposited += 1;
      unverified += ds.filter((d) => !d.voided_at && !d.verified_at).length;
    }
    res.json({ data: {
      ...counts.rows[0], not_deposited: notDeposited, unverified_deposits: unverified,
      received_this_month: { USD: Number(received.USD.toFixed(2)), SLSH: Number(received.SLSH.toFixed(2)) },
    } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load cashout summary.', code: 'INTERNAL' } });
  }
});

// GET /uncovered — "Not yet cashed out" panel (see listUncoveredPayments).
// Head of Cashiers / admin see every cashier; gudoomiye / zone accountant
// only cashiers of their own district (none when they have no district).
router.get('/uncovered', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    if (isZoneScoped(req.user) && !req.user.zone) return res.json({ data: [] });
    const rows = await listUncoveredPayments({ zoneName: isZoneScoped(req.user) ? req.user.zone : null });
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load uncovered payments.', code: 'INTERNAL' } });
  }
});

// ---------- Deposit accounts (admin-managed) ----------

router.get('/deposit-accounts', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const all = req.query.all === '1' && req.user.role === 'admin';
    const r = await pool.query(`SELECT * FROM cashout_deposit_accounts ${all ? '' : 'WHERE active = TRUE'} ORDER BY active DESC, name`);
    res.json({ data: r.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list deposit accounts.', code: 'INTERNAL' } });
  }
});

function validateDepositAccount(body, partial) {
  const out = {};
  if (body.name !== undefined || !partial) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 100) return { error: 'name is required (up to 100 characters).' };
    out.name = name;
  }
  if (body.type !== undefined || !partial) {
    if (!DEPOSIT_ACCOUNT_TYPES.includes(body.type)) return { error: `type must be one of: ${DEPOSIT_ACCOUNT_TYPES.join(', ')}.` };
    out.type = body.type;
  }
  if (body.account_ref !== undefined) {
    if (body.account_ref !== null && (typeof body.account_ref !== 'string' || body.account_ref.trim().length > 100)) return { error: 'account_ref must be up to 100 characters.' };
    out.account_ref = body.account_ref ? body.account_ref.trim() || null : null;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') return { error: 'active must be true or false.' };
    out.active = body.active;
  }
  return { data: out };
}

router.post('/deposit-accounts', authenticateToken, requireRole('admin'), async (req, res) => {
  const v = validateDepositAccount(req.body || {}, false);
  if (v.error) return res.status(400).json({ error: { message: v.error, code: 'VALIDATION' } });
  try {
    const r = await pool.query(
      `INSERT INTO cashout_deposit_accounts (name, type, account_ref, active, created_by) VALUES ($1, $2, $3, COALESCE($4, TRUE), $5) RETURNING *`,
      [v.data.name, v.data.type, v.data.account_ref ?? null, v.data.active ?? null, req.user.id]
    );
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout_deposit_account.create', entityType: 'cashout_deposit_account', entityId: r.rows[0].id, before: null, after: r.rows[0] });
    res.status(201).json({ data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'A deposit account with this name already exists.', code: 'CONFLICT' } });
    res.status(500).json({ error: { message: 'Failed to create deposit account.', code: 'INTERNAL' } });
  }
});

router.put('/deposit-accounts/:accountId', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.accountId);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid deposit account id.', code: 'VALIDATION' } });
  const v = validateDepositAccount(req.body || {}, true);
  if (v.error) return res.status(400).json({ error: { message: v.error, code: 'VALIDATION' } });
  const fields = Object.keys(v.data);
  if (!fields.length) return res.status(400).json({ error: { message: 'No valid fields provided to update.', code: 'VALIDATION' } });
  try {
    const before = await pool.query('SELECT * FROM cashout_deposit_accounts WHERE id = $1', [id]);
    if (!before.rows.length) return res.status(404).json({ error: { message: 'Deposit account not found.', code: 'NOT_FOUND' } });
    const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const r = await pool.query(`UPDATE cashout_deposit_accounts SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`, [id, ...fields.map((f) => v.data[f])]);
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout_deposit_account.update', entityType: 'cashout_deposit_account', entityId: id, before: before.rows[0], after: r.rows[0] });
    res.json({ data: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: { message: 'A deposit account with this name already exists.', code: 'CONFLICT' } });
    res.status(500).json({ error: { message: 'Failed to update deposit account.', code: 'INTERNAL' } });
  }
});

// GET /cashiers — user-reported gap (Phase 10 Billing audit): the New
// Cashout form's 'Cashier' field was a raw numeric user-id text input —
// Head of Cashiers had to already know a cashier's internal database id
// by heart, the exact same class of bug already fixed once this session
// for Employees' "Linked user account ID" field. GET /v2/users (the
// obvious source) is admin-only, and employees.js's VIEW_ROLES doesn't
// include head_of_cashiers either — so this is a small, narrowly-scoped
// new endpoint rather than widening either of those admin-facing
// surfaces: id/username/full_name/zone only, role='cashier' only,
// same CREATE_ROLES as the cashout form itself. Registered BEFORE
// '/:id' for the same reason as reconciliation-preview below.
router.get('/cashiers', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, full_name, zone FROM v2_users WHERE role = 'cashier' AND is_active = TRUE ORDER BY full_name, username`
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list cashiers.', code: 'INTERNAL' } });
  }
});

// Read-only helper for the Cashout Form's own reconciliation preview
// (Head of Cashiers picks a cashier + period, sees server-computed expected
// amount before submitting) — same computation the create route itself
// uses, never a second independently-derived copy. Registered BEFORE
// '/:id' — Express matches routes in declaration order, and ':id' would
// otherwise swallow this literal path.
// GET /assignment-preview — the cashier's assignment panel: his Sub Zones
// and what was "sent" to him (open invoices of those customers) vs what he
// and other channels collected in the period. INFORMATION ONLY — never part
// of the expected/actual/shortage figures. Same roles as the preview.
router.get('/assignment-preview', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  const cashierId = parseStrictId(req.query.cashier_id || '');
  if (cashierId === null) return res.status(400).json({ error: { message: 'cashier_id is required.', code: 'VALIDATION' } });
  const periodStart = new Date(req.query.period_start);
  const periodEnd = new Date(req.query.period_end);
  if (isNaN(periodStart) || isNaN(periodEnd) || periodStart >= periodEnd) {
    return res.status(400).json({ error: { message: 'A valid period_start before period_end is required.', code: 'VALIDATION' } });
  }
  try {
    res.json({ data: await computeAssignment(cashierId, periodStart, periodEnd) });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to compute the assignment panel.', code: 'INTERNAL' } });
  }
});

router.get('/reconciliation-preview', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  const cashierId = parseStrictId(req.query.cashier_id || '');
  if (cashierId === null) return res.status(400).json({ error: { message: 'cashier_id is required.', code: 'VALIDATION' } });
  const periodStart = new Date(req.query.period_start);
  const periodEnd = new Date(req.query.period_end);
  if (isNaN(periodStart) || isNaN(periodEnd) || periodStart >= periodEnd) {
    return res.status(400).json({ error: { message: 'A valid period_start before period_end is required.', code: 'VALIDATION' } });
  }
  try {
    const recon = await computeExpectedForPeriod(cashierId, periodStart, periodEnd);
    const overlap = await hasOverlappingCashout(cashierId, periodStart, periodEnd, pool);
    // V2 (additive): expected per currency + method, the auto-verified
    // electronic payments with their transaction codes, and the controls
    // the create route will apply.
    const expected = await computeBreakdownForPeriod(cashierId, periodStart, periodEnd);
    const { breakdown } = buildBreakdown(expected);
    const electronic = await listElectronicPayments(cashierId, periodStart, periodEnd);
    const controls = await getCashoutControls();
    const rate = await getCurrentRate();
    res.json({ data: { ...recon, overlapsExistingCashout: overlap, breakdown, electronic, controls, rate, periodInFuture: periodEnd.getTime() > Date.now() + FUTURE_SKEW_MS } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to compute reconciliation preview.', code: 'INTERNAL' } });
  }
});

router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cashout id.', code: 'VALIDATION' } });
  try {
    // User-reported gap (Phase 10 Billing audit, continued sweep): the
    // 'Accountability' section previously showed raw numeric ids ('#33',
    // '#13') for all four roles — additive-only name joins (4 separate
    // LEFT JOINs since each references v2_users for a different column),
    // no existing field changed.
    const coRes = await pool.query(CASHOUT_DETAIL_SQL, [id]);
    if (coRes.rows.length === 0) return res.status(404).json({ error: { message: 'Cashout not found.', code: 'NOT_FOUND' } });
    const cashout = coRes.rows[0];
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && cashout.zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this cashout.', code: 'FORBIDDEN' } });
    }
    // debt: a genuine CUSTOMER-owed Debt independently linked to this
    // cashout (legitimate, unrelated use of debts.cashout_id) — kept
    // entirely separate from the cashier's own shortage below. A cashier
    // shortage is NEVER represented as a row in this table.
    const debt = await pool.query('SELECT * FROM debts WHERE cashout_id = $1', [id]);
    // shortage: the cashier accountability/reconciliation-liability record
    // (new model, this pass) — the correct place a shortage lives.
    const shortage = await pool.query('SELECT * FROM cashout_shortages WHERE cashout_id = $1', [id]);
    const attachments = await pool.query('SELECT * FROM cashout_attachments WHERE cashout_id = $1 AND voided_at IS NULL ORDER BY uploaded_at ASC', [id]);
    // asOf = cashout.created_at: a historical document must show the exact
    // figures true when it was created, never drift as later payments land
    // inside the same time window (see cashoutCalculations.js's own comment).
    // V2 rows recompute from their exact covered payment ids (never drift);
    // older rows from their period up to their creation time.
    const scope = { paymentIds: cashout.covered_payment_ids || null };
    const recon = await computeExpectedForPeriod(cashout.cashier_id, cashout.period_start, cashout.period_end, pool, cashout.created_at, scope);
    // shortage_record (not `shortage`) — cashouts.shortage is the numeric
    // amount column already spread in from ...cashout; naming the record
    // object the same key would silently shadow that number in the
    // response (a real bug caught during this pass's own verification).
    // V2 (additive): deposits + derived status, the auto-verified electronic
    // payments (same asOf snapshot), and the action timeline.
    const deposits = (await loadDeposits([id])).get(id) || [];
    const electronic = await listElectronicPayments(cashout.cashier_id, cashout.period_start, cashout.period_end, pool, cashout.created_at, scope);
    const timeline = await loadTimeline(id);
    const rates = await loadLegacyRates([cashout]);
    const { covered_payment_ids: coveredIds, ...rest } = cashout;
    res.json({ data: {
      ...rest, covered_payment_count: coveredIds ? coveredIds.length : null,
      statement_required: needsStatement(cashout), statement_count: attachments.rows.filter((a) => a.kind === 'statement').length,
      debt: debt.rows[0] || null, shortage_record: shortage.rows[0] || null, attachments: attachments.rows, reconciliation: recon,
      deposits, ...depositInfo(cashout, deposits, rates.get(id)), electronic, timeline,
    } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load cashout.', code: 'INTERNAL' } });
  }
});

// Real, downloadable .docx of the same official document rendered on
// screen — same authorization boundary as the JSON detail route (zone-
// scoped, VIEW_ROLES). Additive to this module only, no change to any
// other route's shape.
router.get('/:id/document.docx', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cashout id.', code: 'VALIDATION' } });
  try {
    // Same name-join fix as the JSON detail route above — the printed
    // document had the identical raw-id gap.
    const coRes = await pool.query(CASHOUT_DETAIL_SQL, [id]);
    if (coRes.rows.length === 0) return res.status(404).json({ error: { message: 'Cashout not found.', code: 'NOT_FOUND' } });
    const cashout = coRes.rows[0];
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && cashout.zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this cashout.', code: 'FORBIDDEN' } });
    }
    const scope = { paymentIds: cashout.covered_payment_ids || null };
    const recon = await computeExpectedForPeriod(cashout.cashier_id, cashout.period_start, cashout.period_end, pool, cashout.created_at, scope);
    const shortageRes = await pool.query('SELECT * FROM cashout_shortages WHERE cashout_id = $1', [id]);
    const deposits = (await loadDeposits([id])).get(id) || [];
    const electronic = await listElectronicPayments(cashout.cashier_id, cashout.period_start, cashout.period_end, pool, cashout.created_at, scope);
    const rates = await loadLegacyRates([cashout]);
    const st = await pool.query(`SELECT COUNT(*)::int AS n FROM cashout_attachments WHERE cashout_id = $1 AND kind = 'statement' AND voided_at IS NULL`, [id]);
    const buffer = await buildCashoutDocx(cashout, recon, shortageRes.rows[0] || null, {
      deposits, ...depositInfo(cashout, deposits, rates.get(id)), electronic, statement_count: st.rows[0].n, statement_required: needsStatement(cashout),
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${cashout.cashout_number}.docx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to generate document.', code: 'INTERNAL' } });
  }
});

// GET /:id/transactions — user-requested (Phase 10, 'link garee' the
// Collection Summary / breakdown sections): those numbers previously had
// no way to drill into what actually backs them — this returns the real
// underlying payment rows. Same zone-scope + asOf snapshot rule as the
// reconciliation figures themselves (computeExpectedForPeriod) — a
// cashout's document is a frozen historical view, so a payment recorded
// AFTER this cashout was created must never silently appear here even if
// its own timestamp falls inside the period.
router.get('/:id/transactions', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cashout id.', code: 'VALIDATION' } });
  try {
    const coRes = await pool.query('SELECT * FROM cashouts WHERE id = $1', [id]);
    if (coRes.rows.length === 0) return res.status(404).json({ error: { message: 'Cashout not found.', code: 'NOT_FOUND' } });
    const cashout = coRes.rows[0];
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && cashout.zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this cashout.', code: 'FORBIDDEN' } });
    }
    // V2 rows: exactly the covered payment ids; older rows: the period up to creation.
    const byIds = Array.isArray(cashout.covered_payment_ids);
    const result = await pool.query(
      `SELECT payments.id, payments.amount, payments.currency, payments.method, payments.amount_usd, payments.created_at,
              payments.reference_code, payments.channel, payments.status,
              invoices.invoice_number, payments.debt_id, customers.name AS customer_name, COALESCE(invoices.customer_number_snapshot, customers.customer_number) AS customer_number
       FROM payments
       LEFT JOIN invoices ON payments.invoice_id = invoices.id
       LEFT JOIN debts ON debts.id = payments.debt_id
       JOIN customers ON customers.id = COALESCE(invoices.customer_id, debts.customer_id)
       WHERE ${byIds ? 'payments.id = ANY($1::int[])' : `payments.cashier_id = $1 AND (payments.status = 'recorded' OR (payments.converted_by_payment_id IS NOT NULL AND payments.reversed_at >= $4))
         AND payments.created_at >= $2 AND payments.created_at < $3 AND payments.created_at < $4`}
       ORDER BY payments.created_at ASC`,
      byIds ? [cashout.covered_payment_ids] : [cashout.cashier_id, cashout.period_start, cashout.period_end, cashout.created_at]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load transactions.', code: 'INTERNAL' } });
  }
});

// ---------- Create (atomic: cashout + shortage-debt, one transaction) ----------

router.post('/', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  const { zone_id, cashier_id, period_start, period_end, shortage_reason, remarks } = req.body || {};
  // Cashout V2 only: the old "type the actual amount" body is gone — the
  // cash must be counted (cash_count) and manually recorded electronic
  // payments confirmed (electronic_confirm).
  if (!req.body || req.body.cash_count === undefined) {
    return res.status(400).json({ error: { message: 'This request format is no longer accepted — count the cash (cash_count) instead of typing an actual amount.', code: 'LEGACY_FORMAT_REMOVED' } });
  }
  const zoneId = parseStrictId(String(zone_id ?? ''));
  const cashierId = parseStrictId(String(cashier_id ?? ''));
  if (zoneId === null || cashierId === null) return res.status(400).json({ error: { message: 'zone_id and cashier_id are required.', code: 'VALIDATION' } });
  const periodStart = new Date(period_start);
  const periodEnd = new Date(period_end);
  if (isNaN(periodStart) || isNaN(periodEnd) || periodStart >= periodEnd) {
    return res.status(400).json({ error: { message: 'A valid period_start before period_end is required.', code: 'VALIDATION' } });
  }
  if (periodEnd.getTime() > Date.now() + FUTURE_SKEW_MS) {
    return res.status(400).json({ error: { message: 'The period cannot end in the future — payments recorded later would fall outside this cashout.', code: 'PERIOD_IN_FUTURE' } });
  }
  const cashCount = normalizeCashCount(req.body.cash_count);
  if (cashCount.error) return res.status(400).json({ error: { message: cashCount.error, code: 'VALIDATION' } });
  const confirm = normalizeElectronicConfirm(req.body.electronic_confirm);
  if (confirm.error) return res.status(400).json({ error: { message: confirm.error, code: confirm.code || 'VALIDATION' } });
  const reasonText = typeof shortage_reason === 'string' ? shortage_reason.trim() : '';
  if (reasonText.length > 1000) return res.status(400).json({ error: { message: 'shortage_reason can be at most 1000 characters.', code: 'VALIDATION' } });
  const remarksText = typeof remarks === 'string' ? remarks.trim() : '';
  if (remarksText.length > 1000) return res.status(400).json({ error: { message: 'remarks can be at most 1000 characters.', code: 'VALIDATION' } });

  const myZoneId = await resolveUserZoneId(req.user);
  if (myZoneId !== null && zoneId !== myZoneId) {
    return res.status(403).json({ error: { message: 'You cannot create a cashout outside your zone.', code: 'FORBIDDEN' } });
  }
  // Head of Cashiers identity is server-resolved for the actor performing
  // this reconciliation — never trusted from the client.
  const headOfCashiersId = req.user.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Advisory lock keyed on cashier_id, held for the rest of this
    // transaction: serialises creates (and approvals) for one cashier so
    // two cannot both pass the overlap check. Auto-released at COMMIT/ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock($1)', [cashierId]);
    const zoneRes = await client.query('SELECT id, name FROM zones WHERE id = $1', [zoneId]);
    if (zoneRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Zone not found.', code: 'NOT_FOUND' } });
    }
    // The cashier must be an active cashier, and the cashout is filed under
    // the cashier's own district.
    const cashierRes = await client.query(`SELECT id, role, is_active, zone FROM v2_users WHERE id = $1`, [cashierId]);
    const cashier = cashierRes.rows[0];
    if (!cashier || cashier.role !== 'cashier' || !cashier.is_active) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'cashier_id must be an active cashier.', code: 'INVALID_CASHIER' } });
    }
    if (cashier.zone !== zoneRes.rows[0].name) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: "zone_id must be the cashier's own district.", code: 'ZONE_MISMATCH' } });
    }
    // Double-counting guard — no two live cashouts for the same cashier may
    // cover overlapping time.
    const overlap = await hasOverlappingCashout(cashierId, periodStart, periodEnd, client);
    if (overlap) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'This cashier already has a cashout covering an overlapping period.', code: 'PERIOD_OVERLAP' } });
    }

    // Server-authoritative figures from real recorded payments. One
    // statement gives the per-currency/per-method lines, the exact legacy
    // grand total (expected_amount) and the covered payment ids; every
    // other figure is then derived from exactly those ids.
    const expectedLines = await computeBreakdownForPeriod(cashierId, periodStart, periodEnd, client);
    const expected = expectedLines.expectedAmount;
    const coveredIds = expectedLines.paymentIds;
    const recon = await computeExpectedForPeriod(cashierId, periodStart, periodEnd, client, null, { paymentIds: coveredIds });
    const controls = await getCashoutControls(client);
    // Manually recorded electronic payments of exactly the covered set: the
    // head ticks each one found on the merchant statement.
    const electronicRows = await listElectronicPayments(cashierId, periodStart, periodEnd, client, null, { paymentIds: coveredIds });
    const manual = {};
    for (const row of electronicRows) {
      if (row.gateway_verified) continue;
      const cur = row.currency === 'SLSH' ? 'SLSH' : 'USD';
      manual[cur] = manual[cur] || {};
      (manual[cur][row.method] = manual[cur][row.method] || []).push({ id: row.id, amount: row.amount });
    }
    const resolved = resolveElectronicConfirm(confirm.entries, manual);
    if (resolved.error) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: resolved.error, code: resolved.code || 'VALIDATION' } });
    }
    const built = buildBreakdown(expectedLines, { cashTotals: cashCount.totals, electronicTotals: resolved.totals, electronicDetail: resolved.detail, rate: await getCurrentRate(client) });
    if (built.error) {
      await client.query('ROLLBACK');
      return res.status(built.error.code === 'NO_EXCHANGE_RATE' ? 409 : 400).json({ error: built.error });
    }
    const { actual_amount: actual, cash_amount: cash, zaad_amount: zaad, edahab_amount: edahab, slsh_amount: slsh } = built.legacy;
    // Cumulative escalation: the cashier's other unpaid shortages of live cashouts.
    const prior = await client.query(
      `SELECT COALESCE(SUM(cs.shortage_amount), 0) AS total FROM cashout_shortages cs JOIN cashouts co ON co.id = cs.cashout_id
       WHERE cs.cashier_id = $1 AND cs.status = 'unpaid' AND co.status IN ('pending', 'approved')`, [cashierId]);
    const priorUnpaid = Number(prior.rows[0].total);
    const variance = classifyVariance({ expectedAmount: expected, actualAmount: actual, grossShortageUsd: built.breakdown.gross_shortage_usd, priorUnpaidUsd: priorUnpaid, controls });
    const { shortage, surplus } = variance;

    // Tolerance rule: a shortage above the tolerance needs a reason; within
    // it the cashout is "balanced" and the reason optional. When the whole
    // shortage comes from electronic payments not found on the statement
    // (no cash short) and the head explained every one of them, those
    // notes are the reason.
    let effectiveReason = reasonText;
    if (variance.reasonRequired && !effectiveReason) {
      const cashShort = ['USD', 'SLSH'].some((cur) => Number(built.breakdown.currencies[cur].cash.diff) < 0);
      const lines = [];
      let allExplained = true;
      for (const cur of ['USD', 'SLSH']) for (const m of ['zaad', 'edahab']) {
        const d = resolved.detail[cur] && resolved.detail[cur][m];
        if (!d || !d.unconfirmed_ids.length) continue;
        if (d.unexplained_ids.length) allExplained = false;
        lines.push(`${m.toUpperCase()} ${cur}: ${[d.note, ...d.unconfirmed_ids.map((id) => d.notes[id] && `#${id} ${d.notes[id]}`)].filter(Boolean).join('; ')}`);
      }
      if (!cashShort && allExplained && lines.length) effectiveReason = `Not found on the merchant statement — ${lines.join(' | ')}`.slice(0, 1000);
    }
    if (variance.reasonRequired && !effectiveReason) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'A shortage_reason is required when there is a shortage.', code: 'VALIDATION' } });
    }
    // Assignment panel snapshot (information only).
    const assignment = await computeAssignment(cashierId, periodStart, periodEnd, client);
    const breakdown = {
      ...built.breakdown,
      control: {
        net_shortage_usd: Number(shortage.toFixed(6)), surplus_usd: Number(surplus.toFixed(6)),
        control_shortage_usd: variance.controlShortage, prior_unpaid_shortage_usd: Number(priorUnpaid.toFixed(6)),
        cumulative_shortage_usd: variance.cumulativeShortage, status: variance.status, needs_admin: variance.needsAdmin, ...controls,
      },
    };

    const cashoutNumber = await generateCashoutNumber(client);
    const inserted = await client.query(
      `INSERT INTO cashouts (cashout_number, zone_id, cashier_id, head_of_cashiers_id, period_start, period_end,
        expected_amount, actual_amount, cash_amount, zaad_amount, edahab_amount, slsh_amount, shortage, surplus,
        shortage_reason, remarks, status, created_by,
        breakdown, count_detail, needs_admin, variance_status, control_shortage_usd, tolerance_usd, admin_threshold_usd, covered_payment_ids, assignment_snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *`,
      [cashoutNumber, zoneId, cashierId, headOfCashiersId, periodStart, periodEnd, expected, actual, cash, zaad, edahab, slsh,
        shortage, surplus, effectiveReason || null, remarksText || null, req.user.id,
        JSON.stringify(breakdown), JSON.stringify(cashCount.detail), variance.needsAdmin, variance.status,
        variance.controlShortage, controls.tolerance_usd, controls.admin_threshold_usd, coveredIds, JSON.stringify(assignment)]
    );
    const { covered_payment_ids: storedIds, ...cashout } = inserted.rows[0];

    // Atomic shortage -> cashout_shortages, in the SAME transaction (cashier
    // accountability, never a customer Debt). A shortage inside the
    // tolerance is still recorded — with an explicit system reason.
    let shortageRecord = null;
    if (shortage > 0) {
      const reasonForRecord = effectiveReason || `Within tolerance ($${controls.tolerance_usd.toFixed(2)}) — no reason required.`;
      const shortageInsert = await client.query(
        `INSERT INTO cashout_shortages (cashout_id, cashier_id, expected_amount, actual_amount, shortage_amount, currency, reason, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'USD',$6,'unpaid',$7) RETURNING *`,
        [cashout.id, cashierId, expected, actual, shortage, reasonForRecord, req.user.id]
      );
      shortageRecord = shortageInsert.rows[0];
    }

    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout.create', entityType: 'cashout', entityId: cashout.id, before: null, after: { ...cashout, covered_payment_count: storedIds.length } });
    if (shortageRecord) {
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout_shortage.create', entityType: 'cashout_shortage', entityId: shortageRecord.id, before: null, after: shortageRecord });
    }
    // Manually recorded electronic money and (necessarily, at creation) no
    // merchant statement file yet: audited, never blocking. The statement is
    // uploaded right after creation (kind 'statement').
    if (needsStatement(cashout)) {
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout.statement_missing', entityType: 'cashout', entityId: cashout.id, before: null,
        after: { stage: 'create', manual_electronic_payments: Object.values(manual).reduce((a, byM) => a + Object.values(byM).reduce((b, l) => b + l.length, 0), 0) } });
    }
    // Escalation: tell every active admin. Best-effort: a notification
    // failure never undoes the cashout.
    if (cashout.needs_admin) {
      try {
        const admins = await pool.query(`SELECT id FROM v2_users WHERE role = 'admin' AND is_active = TRUE`);
        for (const a of admins.rows) {
          if (a.id === req.user.id) continue;
          await createStaffNotification({
            recipientId: a.id, eventType: 'cashout.needs_admin', entityType: 'cashout', entityId: cashout.id,
            title: `Cashout ${cashout.cashout_number} needs admin approval`,
            body: `Cumulative unresolved shortage of $${variance.cumulativeShortage.toFixed(2)} is above the $${controls.admin_threshold_usd.toFixed(2)} admin-approval threshold.`,
          });
        }
      } catch (e) {
        logNotificationFailure('cashout.needs_admin', e);
      }
    }
    res.status(201).json({ data: { ...cashout, covered_payment_count: storedIds.length, shortage_record: shortageRecord, reconciliation: recon } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: { message: 'Duplicate cashout number — retry.', code: 'CONFLICT' } });
    res.status(500).json({ error: { message: 'Failed to create cashout.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// ---------- Cashout Shortage resolution ----------
// Manual, audited resolution only — NO automatic recovery mechanism.
// Cashout V2 rules: only on a live (pending/approved) cashout; never by
// whoever prepared it; an escalated (needs_admin) cashout's shortage is
// resolved by an admin; the recovered amount cannot exceed the shortage.
router.put('/:id/shortage/resolve', authenticateToken, requireRole(...RESOLVE_SHORTAGE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cashout id.', code: 'VALIDATION' } });
  const resolvedAmount = Number(req.body?.resolved_amount);
  const notes = (req.body?.resolution_notes || '').trim();
  if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
    return res.status(400).json({ error: { message: 'resolved_amount must be a positive number.', code: 'VALIDATION' } });
  }
  if (Math.abs(resolvedAmount * 100 - Math.round(resolvedAmount * 100)) > 1e-6) {
    return res.status(400).json({ error: { message: 'resolved_amount can have at most 2 decimals.', code: 'VALIDATION' } });
  }
  if (!notes) return res.status(400).json({ error: { message: 'resolution_notes is required.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const coRes = await client.query('SELECT * FROM cashouts WHERE id = $1 FOR UPDATE', [id]);
    if (!coRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Cashout not found.', code: 'NOT_FOUND' } }); }
    const cashout = coRes.rows[0];
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && cashout.zone_id !== myZoneId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'You do not have access to this cashout.', code: 'FORBIDDEN' } });
    }
    if (!['pending', 'approved'].includes(cashout.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'Only the shortage of a pending or approved cashout can be resolved.', code: 'NOT_LIVE' } });
    }
    if (cashout.created_by === req.user.id || cashout.head_of_cashiers_id === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'The preparer of a cashout cannot resolve its shortage.', code: 'FORBIDDEN' } });
    }
    if (cashout.needs_admin && req.user.role !== 'admin') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'This shortage is above the admin threshold — only an admin can resolve it.', code: 'NEEDS_ADMIN_APPROVAL' } });
    }
    const shortageRes = await client.query('SELECT * FROM cashout_shortages WHERE cashout_id = $1 FOR UPDATE', [id]);
    if (shortageRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'No shortage record exists for this cashout.', code: 'NOT_FOUND' } });
    }
    const shortage = shortageRes.rows[0];
    if (shortage.status !== 'unpaid') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: shortage.status === 'paid' ? 'This shortage is already resolved.' : 'This shortage was cancelled.', code: 'CONFLICT' } });
    }
    if (resolvedAmount > Number(shortage.shortage_amount) + EPSILON) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: `resolved_amount cannot exceed the shortage ($${Number(shortage.shortage_amount).toFixed(2)}).`, code: 'VALIDATION' } });
    }
    const updated = await client.query(
      `UPDATE cashout_shortages SET status = 'paid', resolved_amount = $1, resolved_at = NOW(), resolved_by = $2, resolution_notes = $3, updated_at = NOW() WHERE id = $4 RETURNING *`,
      [resolvedAmount, req.user.id, notes, shortage.id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout_shortage.resolve', entityType: 'cashout_shortage', entityId: shortage.id, before: shortage, after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: { message: 'Failed to resolve shortage.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// A rejected or voided cashout's shortage is cancelled in the same
// transaction: it is no longer a cashier liability and can never be
// deducted from pay. Returns the cancelled row (or null).
async function cancelShortage(client, cashoutId, user, reason) {
  const r = await client.query(
    `UPDATE cashout_shortages SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2, cancelled_reason = $3, updated_at = NOW()
     WHERE cashout_id = $1 AND status = 'unpaid' RETURNING *`, [cashoutId, user.id, reason]);
  return r.rows[0] || null;
}
async function auditCancelledShortage(user, row) {
  if (!row) return;
  await logAudit({ actorId: user.id, actorUsername: user.username, action: 'cashout_shortage.cancel', entityType: 'cashout_shortage', entityId: row.id, before: { status: 'unpaid' }, after: row });
}

// Locks a cashout for a state change: the cashier advisory lock FIRST (the
// same lock create takes — consistent order, so approve and a concurrent
// create for the same cashier serialise), then the row.
async function lockCashoutForChange(client, id) {
  const peek = await client.query('SELECT cashier_id FROM cashouts WHERE id = $1', [id]);
  if (!peek.rows.length) return null;
  await client.query('SELECT pg_advisory_xact_lock($1)', [peek.rows[0].cashier_id]);
  const r = await client.query('SELECT * FROM cashouts WHERE id = $1 FOR UPDATE', [id]);
  return r.rows[0] || null;
}

// ---------- Approve / Reject / Void ----------

// head_of_cashiers passes the role gate ONLY so it gets a clear answer
// (NEEDS_ADMIN_APPROVAL for an escalated cashout, FORBIDDEN otherwise) —
// Head of Cashiers prepares cashouts and can never approve one; approval
// authority stays exactly APPROVE_ROLES.
router.put('/:id/approve', authenticateToken, requireRole(...APPROVE_ROLES, 'head_of_cashiers'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cashout id.', code: 'VALIDATION' } });
  const role = (req.user.role || '').toLowerCase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cashout = await lockCashoutForChange(client, id);
    if (!cashout) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Cashout not found.', code: 'NOT_FOUND' } }); }
    if (!APPROVE_ROLES.includes(role)) {
      await client.query('ROLLBACK');
      if (cashout.needs_admin) return res.status(403).json({ error: { message: 'This cashout\'s shortage is above the admin-approval threshold — only an admin can approve it.', code: 'NEEDS_ADMIN_APPROVAL' } });
      return res.status(403).json({ error: { message: 'You do not have permission to perform this action.', code: 'FORBIDDEN' } });
    }
    if (role === 'gudoomiye' && cashout.zone_id !== await resolveUserZoneId(req.user)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'This cashout is outside your zone.', code: 'FORBIDDEN' } });
    }
    // Only a pending cashout can be approved (approved = final; rejected /
    // voided were sent back or cancelled and must be redone).
    if (cashout.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: cashout.status === 'approved' ? 'This cashout was already approved.' : `A ${cashout.status} cashout cannot be approved.`, code: 'CONFLICT' } });
    }
    // Self-approval prevention (Phase 7) + Cashout V2 maker-checker: the
    // approver is never the creator, the cashier whose money this is, nor
    // the Head of Cashiers who reconciled it.
    if (cashout.created_by === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'You cannot approve a cashout you created yourself.', code: 'FORBIDDEN' } });
    }
    if (cashout.cashier_id === req.user.id || cashout.head_of_cashiers_id === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'The cashier or the preparer of a cashout cannot approve it.', code: 'FORBIDDEN' } });
    }
    if (cashout.needs_admin && role !== 'admin') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'This cashout\'s shortage is above the admin-approval threshold — only an admin can approve it.', code: 'NEEDS_ADMIN_APPROVAL' } });
    }
    const signedRes = await client.query(`SELECT 1 FROM cashout_attachments WHERE cashout_id = $1 AND document_type = 'signed_cashout_form' AND voided_at IS NULL LIMIT 1`, [id]);
    if (signedRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'Upload the signed cashout document before approving.', code: 'SIGNED_DOCUMENT_REQUIRED' } });
    }
    // Re-check the double-counting guard under the cashier lock.
    if (await hasOverlappingCashout(cashout.cashier_id, cashout.period_start, cashout.period_end, client, id)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'Another live cashout of this cashier overlaps this period.', code: 'PERIOD_OVERLAP' } });
    }
    const updated = await client.query(
      `UPDATE cashouts SET status = 'approved', approved_by = $1, approved_at = NOW(), rejection_reason = NULL, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [req.user.id, id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout.approve', entityType: 'cashout', entityId: id, before: cashout, after: updated.rows[0] });
    if (needsStatement(cashout)) {
      const st = await pool.query(`SELECT COUNT(*)::int AS n FROM cashout_attachments WHERE cashout_id = $1 AND kind = 'statement' AND voided_at IS NULL`, [id]);
      if (st.rows[0].n === 0) {
        await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout.statement_missing', entityType: 'cashout', entityId: id, before: null, after: { stage: 'approve' } });
      }
    }
    const { covered_payment_ids: _ids, ...out } = updated.rows[0];
    res.json({ data: out });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: { message: 'Failed to approve cashout.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

router.put('/:id/reject', authenticateToken, requireRole(...APPROVE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cashout id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'A reason is required to reject a cashout.', code: 'VALIDATION' } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cashout = await lockCashoutForChange(client, id);
    if (!cashout) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Cashout not found.', code: 'NOT_FOUND' } }); }
    if ((req.user.role || '').toLowerCase() === 'gudoomiye' && cashout.zone_id !== await resolveUserZoneId(req.user)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'This cashout is outside your zone.', code: 'FORBIDDEN' } });
    }
    if (cashout.created_by === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'You cannot reject a cashout you created yourself.', code: 'FORBIDDEN' } });
    }
    if (cashout.cashier_id === req.user.id || cashout.head_of_cashiers_id === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'The cashier or the preparer of a cashout cannot reject it.', code: 'FORBIDDEN' } });
    }
    // Only a pending cashout can be rejected (a voided one must never flip to rejected).
    if (cashout.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: `A ${cashout.status} cashout cannot be rejected.`, code: 'CONFLICT' } });
    }
    if (cashout.needs_admin && req.user.role !== 'admin') {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'This cashout\'s shortage is above the admin threshold — only an admin can reject it.', code: 'NEEDS_ADMIN_APPROVAL' } });
    }
    const updated = await client.query(
      `UPDATE cashouts SET status = 'rejected', approved_by = $1, approved_at = NOW(), rejection_reason = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [req.user.id, reason, id]
    );
    const cancelled = await cancelShortage(client, id, req.user, `Cashout rejected: ${reason}`);
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout.reject', entityType: 'cashout', entityId: id, before: cashout, after: updated.rows[0] });
    await auditCancelledShortage(req.user, cancelled);
    const { covered_payment_ids: _ids, ...out } = updated.rows[0];
    res.json({ data: out });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: { message: 'Failed to reject cashout.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// Void, not delete (OD-1) — allowed only pre-approval (pending or rejected).
// Row + audit trail always preserved; its shortage is cancelled.
router.put('/:id/void', authenticateToken, requireRole(...VOID_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cashout id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'A reason is required to void a cashout.', code: 'VALIDATION' } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cashout = await lockCashoutForChange(client, id);
    if (!cashout) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Cashout not found.', code: 'NOT_FOUND' } }); }
    if (cashout.status === 'approved') { await client.query('ROLLBACK'); return res.status(400).json({ error: { message: 'Cannot void an approved cashout — it is a finalized financial record.', code: 'VALIDATION' } }); }
    if (cashout.status === 'voided') { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: 'This cashout is already voided.', code: 'CONFLICT' } }); }
    const updated = await client.query(
      `UPDATE cashouts SET status = 'voided', voided_at = NOW(), voided_by = $1, voided_reason = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [req.user.id, reason, id]
    );
    const cancelled = await cancelShortage(client, id, req.user, `Cashout voided: ${reason}`);
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout.void', entityType: 'cashout', entityId: id, before: cashout, after: updated.rows[0] });
    await auditCancelledShortage(req.user, cancelled);
    const { covered_payment_ids: _ids, ...out } = updated.rows[0];
    res.json({ data: out });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: { message: 'Failed to void cashout.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// ---------- Attachments ----------

router.post('/:id/attachments', authenticateToken, requireRole(...VIEW_ROLES), upload.single('file'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cashout id.', code: 'VALIDATION' } });
  if (!req.file) return res.status(400).json({ error: { message: 'No file uploaded, or the file type is not allowed (PDF/JPG/JPEG/PNG only).', code: 'VALIDATION' } });
  // Content-sniffing validation (Future CR promoted to in-scope, Phase 10
  // Gap Audit) — see lib/fileSniff.js. diskStorage means the file is
  // already written by the time this handler runs; read it back to sniff.
  if (!sniffFileType(fs.readFileSync(req.file.path), req.file.mimetype)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: { message: 'File content does not match its claimed type.', code: 'VALIDATION' } });
  }
  if (await rejectIfInfected(req, res, { filePath: req.file.path, label: 'cashout_attachment' })) return;
  const documentType = req.body.document_type;
  if (!DOCUMENT_TYPES.includes(documentType)) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: { message: `document_type must be one of: ${DOCUMENT_TYPES.join(', ')}.`, code: 'VALIDATION' } });
  }
  try {
    const coRes = await pool.query('SELECT zone_id, status FROM cashouts WHERE id = $1', [id]);
    if (coRes.rows.length === 0) {
      fs.unlink(req.file.path, () => {});
      return res.status(404).json({ error: { message: 'Cashout not found.', code: 'NOT_FOUND' } });
    }
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && coRes.rows[0].zone_id !== myZoneId) {
      fs.unlink(req.file.path, () => {});
      return res.status(403).json({ error: { message: 'You do not have access to this cashout.', code: 'FORBIDDEN' } });
    }
    const inserted = await pool.query(
      `INSERT INTO cashout_attachments (cashout_id, document_type, original_filename, storage_path, mime_type, file_size, uploaded_by, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, documentType, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.id, kindOf(documentType)]
    );
    const attachment = inserted.rows[0];
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout.attachment_upload', entityType: 'cashout_attachment', entityId: attachment.id, before: null, after: { ...attachment, storage_path: '(redacted from audit log)' } });
    res.status(201).json({ data: attachment });
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: { message: 'Failed to upload attachment.', code: 'INTERNAL' } });
  }
});

// File contents — server-side authorized only (never a public/static path),
// per the explicit document-security instruction.
router.get('/:id/attachments/:attachmentId/file', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  const attachmentId = parseStrictId(req.params.attachmentId);
  if (id === null || attachmentId === null) return res.status(400).json({ error: { message: 'Invalid id.', code: 'VALIDATION' } });
  try {
    const coRes = await pool.query('SELECT zone_id FROM cashouts WHERE id = $1', [id]);
    if (coRes.rows.length === 0) return res.status(404).json({ error: { message: 'Cashout not found.', code: 'NOT_FOUND' } });
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && coRes.rows[0].zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this cashout.', code: 'FORBIDDEN' } });
    }
    const attRes = await pool.query('SELECT * FROM cashout_attachments WHERE id = $1 AND cashout_id = $2 AND voided_at IS NULL', [attachmentId, id]);
    if (attRes.rows.length === 0) return res.status(404).json({ error: { message: 'Attachment not found.', code: 'NOT_FOUND' } });
    const filePath = path.join(UPLOAD_DIR, attRes.rows[0].storage_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: { message: 'File no longer exists on disk.', code: 'NOT_FOUND' } });
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to load attachment.', code: 'INTERNAL' } });
  }
});

// Soft-void an attachment (preserve audit history, never a hard delete of
// financial evidence, per the explicit document-security instruction).
router.delete('/:id/attachments/:attachmentId', authenticateToken, requireRole('admin'), async (req, res) => {
  const id = parseStrictId(req.params.id);
  const attachmentId = parseStrictId(req.params.attachmentId);
  if (id === null || attachmentId === null) return res.status(400).json({ error: { message: 'Invalid id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'A reason is required to remove an attachment.', code: 'VALIDATION' } });
  try {
    const existing = await pool.query('SELECT * FROM cashout_attachments WHERE id = $1 AND cashout_id = $2', [attachmentId, id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: { message: 'Attachment not found.', code: 'NOT_FOUND' } });
    // A slip that backs a live deposit cannot be removed (void the deposit first).
    const inUse = await pool.query('SELECT 1 FROM cashout_deposits WHERE attachment_id = $1 AND voided_at IS NULL LIMIT 1', [attachmentId]);
    if (inUse.rows.length) return res.status(409).json({ error: { message: 'This slip backs a recorded deposit — void that deposit first.', code: 'ATTACHMENT_IN_USE' } });
    const updated = await pool.query(
      `UPDATE cashout_attachments SET voided_at = NOW(), voided_by = $1, voided_reason = $2 WHERE id = $3 RETURNING *`,
      [req.user.id, reason, attachmentId]
    );
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout.attachment_void', entityType: 'cashout_attachment', entityId: attachmentId, before: existing.rows[0], after: updated.rows[0] });
    res.json({ data: { success: true } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to remove attachment.', code: 'INTERNAL' } });
  }
});

// ---------- Deposits (Cashout V2) ----------
// Only an APPROVED cashout's cash can be deposited. A bank / mobile-money
// deposit needs its slip (a 'deposit_slip' attachment of this cashout,
// uploaded first through POST /:id/attachments); a safe drop may omit it.
// Over- or under-depositing is allowed and shows as 'variance' / 'partial'
// — the system records what happened, it never forces numbers to match.

async function lockCashoutForDeposit(client, id, user) {
  const coRes = await client.query('SELECT * FROM cashouts WHERE id = $1 FOR UPDATE', [id]);
  if (!coRes.rows.length) return { status: 404, error: { message: 'Cashout not found.', code: 'NOT_FOUND' } };
  const cashout = coRes.rows[0];
  const myZoneId = await resolveUserZoneId(user);
  if (myZoneId !== null && cashout.zone_id !== myZoneId) return { status: 403, error: { message: 'You do not have access to this cashout.', code: 'FORBIDDEN' } };
  return { cashout };
}

router.post('/:id/deposits', authenticateToken, requireRole(...DEPOSIT_RECORD_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cashout id.', code: 'VALIDATION' } });
  const body = req.body || {};
  const accountId = parseStrictId(String(body.deposit_account_id ?? ''));
  if (accountId === null) return res.status(400).json({ error: { message: 'deposit_account_id is required.', code: 'VALIDATION' } });
  const currency = body.currency;
  if (!CURRENCIES.includes(currency)) return res.status(400).json({ error: { message: 'currency must be USD or SLSH.', code: 'VALIDATION' } });
  const amount = Number(body.amount);
  if (typeof body.amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: { message: 'amount must be a positive number.', code: 'VALIDATION' } });
  if (currency === 'SLSH' && !Number.isInteger(amount)) return res.status(400).json({ error: { message: 'SLSH amounts must be whole numbers.', code: 'VALIDATION' } });
  if (currency === 'USD' && Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return res.status(400).json({ error: { message: 'USD amounts can have at most 2 decimals.', code: 'VALIDATION' } });
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > 1000) return res.status(400).json({ error: { message: 'note can be at most 1000 characters.', code: 'VALIDATION' } });
  let attachmentId = null;
  if (body.attachment_id !== undefined && body.attachment_id !== null) {
    attachmentId = parseStrictId(String(body.attachment_id));
    if (attachmentId === null) return res.status(400).json({ error: { message: 'attachment_id must be a numeric id.', code: 'VALIDATION' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await lockCashoutForDeposit(client, id, req.user);
    if (locked.error) { await client.query('ROLLBACK'); return res.status(locked.status).json({ error: locked.error }); }
    if (locked.cashout.status !== 'approved') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'Only an approved cashout can be deposited.', code: 'NOT_APPROVED' } });
    }
    const acc = await client.query('SELECT * FROM cashout_deposit_accounts WHERE id = $1', [accountId]);
    if (!acc.rows.length || !acc.rows[0].active) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'Choose an active deposit account.', code: 'VALIDATION' } });
    }
    if (attachmentId !== null) {
      const att = await client.query(
        `SELECT id FROM cashout_attachments WHERE id = $1 AND cashout_id = $2 AND document_type = 'deposit_slip' AND voided_at IS NULL`, [attachmentId, id]);
      if (!att.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: { message: 'attachment_id must be a deposit slip uploaded to this cashout.', code: 'VALIDATION' } });
      }
      const used = await client.query('SELECT 1 FROM cashout_deposits WHERE attachment_id = $1 AND voided_at IS NULL LIMIT 1', [attachmentId]);
      if (used.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { message: 'This slip already backs another deposit.', code: 'SLIP_ALREADY_USED' } });
      }
    } else if (acc.rows[0].type !== 'safe') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'A deposit slip is required for a bank or mobile-money deposit.', code: 'SLIP_REQUIRED' } });
    }
    const ins = await client.query(
      `INSERT INTO cashout_deposits (cashout_id, deposit_account_id, currency, amount, attachment_id, note, deposited_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, accountId, currency, amount, attachmentId, note || null, req.user.id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout.deposit_create', entityType: 'cashout_deposit', entityId: ins.rows[0].id, before: null, after: ins.rows[0] });
    res.status(201).json({ data: ins.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ error: { message: 'This slip already backs another deposit.', code: 'SLIP_ALREADY_USED' } });
    res.status(500).json({ error: { message: 'Failed to record deposit.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

async function changeDeposit(req, res, kind) {
  const id = parseStrictId(req.params.id);
  const depositId = parseStrictId(req.params.depositId);
  if (id === null || depositId === null) return res.status(400).json({ error: { message: 'Invalid id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (kind === 'void' && !reason) return res.status(400).json({ error: { message: 'A reason is required to void a deposit.', code: 'VALIDATION' } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await lockCashoutForDeposit(client, id, req.user);
    if (locked.error) { await client.query('ROLLBACK'); return res.status(locked.status).json({ error: locked.error }); }
    const dRes = await client.query('SELECT * FROM cashout_deposits WHERE id = $1 AND cashout_id = $2 FOR UPDATE', [depositId, id]);
    if (!dRes.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Deposit not found.', code: 'NOT_FOUND' } }); }
    const dep = dRes.rows[0];
    if (dep.voided_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: 'This deposit was voided.', code: 'CONFLICT' } }); }
    if (dep.verified_at) { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: 'This deposit is already verified.', code: 'CONFLICT' } }); }
    let updated;
    if (kind === 'verify') {
      // Maker-checker: whoever recorded a deposit never verifies it.
      if (dep.deposited_by === req.user.id) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: { message: 'You cannot verify a deposit you recorded yourself.', code: 'FORBIDDEN' } });
      }
      updated = await client.query('UPDATE cashout_deposits SET verified_by = $1, verified_at = NOW() WHERE id = $2 RETURNING *', [req.user.id, depositId]);
    } else {
      updated = await client.query('UPDATE cashout_deposits SET voided_at = NOW(), voided_by = $1, voided_reason = $2 WHERE id = $3 RETURNING *', [req.user.id, reason, depositId]);
    }
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: `cashout.deposit_${kind}`, entityType: 'cashout_deposit', entityId: depositId, before: dep, after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: { message: `Failed to ${kind} deposit.`, code: 'INTERNAL' } });
  } finally {
    client.release();
  }
}

router.put('/:id/deposits/:depositId/verify', authenticateToken, requireRole('admin'), (req, res) => changeDeposit(req, res, 'verify'));
router.put('/:id/deposits/:depositId/void', authenticateToken, requireRole('admin'), (req, res) => changeDeposit(req, res, 'void'));

module.exports = router;
