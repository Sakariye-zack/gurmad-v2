const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { pool, logAudit } = require('../db');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { computeExpectedForPeriod, hasOverlappingCashout, EPSILON } = require('../lib/cashoutCalculations');
const { buildCashoutDocx } = require('../lib/documentGenerators');

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
const DOCUMENT_TYPES = ['signed_cashout_form', 'deposit_slip', 'cash_handover_evidence', 'receipt', 'shortage_explanation', 'approval_document', 'other'];

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

// ---------- List / Detail ----------

router.get('/', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  try {
    const myZoneId = await resolveUserZoneId(req.user);
    const where = [];
    const params = [];
    if (myZoneId !== null) { params.push(myZoneId); where.push(`cashouts.zone_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); where.push(`cashouts.status = $${params.length}`); }
    // P1 Functional Gaps — q search, cashout_number only, per explicit
    // scope. 2-char minimum, same ILIKE pattern as every other module.
    if (req.query.q) {
      const q = req.query.q.trim();
      if (q.length >= 2) { params.push(`%${q}%`); where.push(`cashouts.cashout_number ILIKE $${params.length}`); }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT cashouts.*, zones.name AS zone_name,
        (SELECT COUNT(*) FROM cashout_attachments ca WHERE ca.cashout_id = cashouts.id AND ca.voided_at IS NULL AND ca.document_type = 'signed_cashout_form') > 0 AS has_signed_document
       FROM cashouts LEFT JOIN zones ON cashouts.zone_id = zones.id
       ${whereSql} ORDER BY cashouts.created_at DESC`,
      params
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to list cashouts.', code: 'INTERNAL' } });
  }
});

// Read-only helper for the Cashout Form's own reconciliation preview
// (Head of Cashiers picks a cashier + period, sees server-computed expected
// amount before submitting) — same computation the create route itself
// uses, never a second independently-derived copy. Registered BEFORE
// '/:id' — Express matches routes in declaration order, and ':id' would
// otherwise swallow this literal path.
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
    res.json({ data: { ...recon, overlapsExistingCashout: overlap } });
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to compute reconciliation preview.', code: 'INTERNAL' } });
  }
});

router.get('/:id', authenticateToken, requireRole(...VIEW_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cashout id.', code: 'VALIDATION' } });
  try {
    const coRes = await pool.query(`SELECT cashouts.*, zones.name AS zone_name FROM cashouts LEFT JOIN zones ON cashouts.zone_id = zones.id WHERE cashouts.id = $1`, [id]);
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
    const recon = await computeExpectedForPeriod(cashout.cashier_id, cashout.period_start, cashout.period_end, pool, cashout.created_at);
    // shortage_record (not `shortage`) — cashouts.shortage is the numeric
    // amount column already spread in from ...cashout; naming the record
    // object the same key would silently shadow that number in the
    // response (a real bug caught during this pass's own verification).
    res.json({ data: { ...cashout, debt: debt.rows[0] || null, shortage_record: shortage.rows[0] || null, attachments: attachments.rows, reconciliation: recon } });
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
    const coRes = await pool.query(`SELECT cashouts.*, zones.name AS zone_name FROM cashouts LEFT JOIN zones ON cashouts.zone_id = zones.id WHERE cashouts.id = $1`, [id]);
    if (coRes.rows.length === 0) return res.status(404).json({ error: { message: 'Cashout not found.', code: 'NOT_FOUND' } });
    const cashout = coRes.rows[0];
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null && cashout.zone_id !== myZoneId) {
      return res.status(403).json({ error: { message: 'You do not have access to this cashout.', code: 'FORBIDDEN' } });
    }
    const recon = await computeExpectedForPeriod(cashout.cashier_id, cashout.period_start, cashout.period_end, pool, cashout.created_at);
    const shortageRes = await pool.query('SELECT * FROM cashout_shortages WHERE cashout_id = $1', [id]);
    const buffer = await buildCashoutDocx(cashout, recon, shortageRes.rows[0] || null);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${cashout.cashout_number}.docx"`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: { message: 'Failed to generate document.', code: 'INTERNAL' } });
  }
});

// ---------- Create (atomic: cashout + shortage-debt, one transaction) ----------

router.post('/', authenticateToken, requireRole(...CREATE_ROLES), async (req, res) => {
  const { zone_id, cashier_id, period_start, period_end, actual_amount, cash_amount, zaad_amount, edahab_amount, slsh_amount, shortage_reason, remarks } = req.body;

  const zoneId = parseStrictId(String(zone_id ?? ''));
  const cashierId = parseStrictId(String(cashier_id ?? ''));
  if (zoneId === null || cashierId === null) return res.status(400).json({ error: { message: 'zone_id and cashier_id are required.', code: 'VALIDATION' } });
  const periodStart = new Date(period_start);
  const periodEnd = new Date(period_end);
  if (isNaN(periodStart) || isNaN(periodEnd) || periodStart >= periodEnd) {
    return res.status(400).json({ error: { message: 'A valid period_start before period_end is required.', code: 'VALIDATION' } });
  }
  const actual = parseFloat(actual_amount);
  if (isNaN(actual) || actual < 0) return res.status(400).json({ error: { message: 'actual_amount must be a non-negative number.', code: 'VALIDATION' } });
  const cash = parseFloat(cash_amount) || 0, zaad = parseFloat(zaad_amount) || 0, edahab = parseFloat(edahab_amount) || 0, slsh = parseFloat(slsh_amount) || 0;
  const methodSum = cash + zaad + edahab + slsh;
  if (Math.abs(methodSum - actual) > EPSILON) {
    return res.status(400).json({ error: { message: `Method breakdown (${methodSum.toFixed(2)}) does not sum to actual_amount (${actual.toFixed(2)}).`, code: 'VALIDATION' } });
  }

  const myZoneId = await resolveUserZoneId(req.user);
  if (myZoneId !== null && zoneId !== myZoneId) {
    return res.status(403).json({ error: { message: 'You cannot create a cashout outside your zone.', code: 'FORBIDDEN' } });
  }
  // Head of Cashiers identity is server-resolved for the actor performing
  // this reconciliation — never trusted from the client — mirroring the
  // T2.8-H cashier-identity fix and Module 6's own cashier_id precedent.
  const headOfCashiersId = req.user.id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Advisory lock keyed on cashier_id, held for the rest of this
    // transaction: a new cashout is a fresh INSERT with no existing row to
    // FOR UPDATE, so without this, two concurrent creates for the same
    // cashier could both pass the overlap check before either commits.
    // pg_advisory_xact_lock auto-releases at COMMIT/ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock($1)', [cashierId]);
    const zoneRes = await client.query('SELECT id FROM zones WHERE id = $1', [zoneId]);
    if (zoneRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Zone not found.', code: 'NOT_FOUND' } });
    }
    // Double-counting guard (§ db.js comment) — no two non-voided cashouts
    // for the same cashier may cover overlapping time.
    const overlap = await hasOverlappingCashout(cashierId, periodStart, periodEnd, client);
    if (overlap) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'This cashier already has a cashout covering an overlapping period.', code: 'PERIOD_OVERLAP' } });
    }

    // Server-authoritative expected amount — computed from real recorded
    // payments, never trusted from client input.
    const recon = await computeExpectedForPeriod(cashierId, periodStart, periodEnd, client);
    const expected = recon.expectedAmount;
    const diff = expected - actual;
    const shortage = diff > EPSILON ? diff : 0;
    const surplus = diff < -EPSILON ? -diff : 0;

    if (shortage > 0 && !(shortage_reason || '').trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'A shortage_reason is required when there is a shortage.', code: 'VALIDATION' } });
    }

    const cashoutNumber = await generateCashoutNumber(client);
    const inserted = await client.query(
      `INSERT INTO cashouts (cashout_number, zone_id, cashier_id, head_of_cashiers_id, period_start, period_end,
        expected_amount, actual_amount, cash_amount, zaad_amount, edahab_amount, slsh_amount, shortage, surplus,
        shortage_reason, remarks, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',$17) RETURNING *`,
      [cashoutNumber, zoneId, cashierId, headOfCashiersId, periodStart, periodEnd, expected, actual, cash, zaad, edahab, slsh,
        shortage, surplus, shortage_reason || null, remarks || null, req.user.id]
    );
    const cashout = inserted.rows[0];

    // Atomic shortage -> cashout_shortages, in the SAME transaction —
    // resolving the architecture conflict flagged in the prior checkpoint.
    // NOT a debts row: a Cashout Shortage is cashier accountability, never
    // a customer-owed Debt (approved architecture decision, this pass).
    // If this insert fails, the whole transaction (including the cashout
    // row itself) rolls back — the cashout is never left half-recorded.
    let shortageRecord = null;
    if (shortage > 0) {
      const shortageInsert = await client.query(
        `INSERT INTO cashout_shortages (cashout_id, cashier_id, expected_amount, actual_amount, shortage_amount, currency, reason, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'USD',$6,'unpaid',$7) RETURNING *`,
        [cashout.id, cashierId, expected, actual, shortage, shortage_reason.trim(), req.user.id]
      );
      shortageRecord = shortageInsert.rows[0];
    }

    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout.create', entityType: 'cashout', entityId: cashout.id, before: null, after: cashout });
    if (shortageRecord) {
      await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout_shortage.create', entityType: 'cashout_shortage', entityId: shortageRecord.id, before: null, after: shortageRecord });
    }
    res.status(201).json({ data: { ...cashout, shortage_record: shortageRecord, reconciliation: recon } });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: { message: 'Duplicate cashout number — retry.', code: 'CONFLICT' } });
    res.status(500).json({ error: { message: 'Failed to create cashout.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// ---------- Cashout Shortage resolution ----------
// Manual, audited resolution only — NO automatic recovery mechanism
// (salary/payroll deduction, auto-debt, auto-accounting-entry) is
// implemented anywhere, per explicit instruction. This route records
// WHO resolved it, HOW MUCH was actually recovered, and WHY/notes —
// nothing more.
router.put('/:id/shortage/resolve', authenticateToken, requireRole(...RESOLVE_SHORTAGE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cashout id.', code: 'VALIDATION' } });
  const resolvedAmount = parseFloat(req.body?.resolved_amount);
  const notes = (req.body?.resolution_notes || '').trim();
  if (isNaN(resolvedAmount) || resolvedAmount <= 0) {
    return res.status(400).json({ error: { message: 'resolved_amount must be a positive number.', code: 'VALIDATION' } });
  }
  if (!notes) return res.status(400).json({ error: { message: 'resolution_notes is required.', code: 'VALIDATION' } });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shortageRes = await client.query('SELECT * FROM cashout_shortages WHERE cashout_id = $1 FOR UPDATE', [id]);
    if (shortageRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'No shortage record exists for this cashout.', code: 'NOT_FOUND' } });
    }
    const shortage = shortageRes.rows[0];
    if (shortage.status === 'paid') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: { message: 'This shortage is already resolved.', code: 'CONFLICT' } });
    }
    const myZoneId = await resolveUserZoneId(req.user);
    if (myZoneId !== null) {
      const coRes = await client.query('SELECT zone_id FROM cashouts WHERE id = $1', [id]);
      if (coRes.rows[0]?.zone_id !== myZoneId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: { message: 'You do not have access to this cashout.', code: 'FORBIDDEN' } });
      }
    }
    const updated = await client.query(
      `UPDATE cashout_shortages SET status = 'paid', resolved_amount = $1, resolved_at = NOW(), resolved_by = $2, resolution_notes = $3, updated_at = NOW() WHERE id = $4 RETURNING *`,
      [resolvedAmount, req.user.id, notes, shortage.id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout_shortage.resolve', entityType: 'cashout_shortage', entityId: shortage.id, before: shortage, after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to resolve shortage.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// ---------- Approve / Reject / Void ----------

router.put('/:id/approve', authenticateToken, requireRole(...APPROVE_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cashout id.', code: 'VALIDATION' } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM cashouts WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Cashout not found.', code: 'NOT_FOUND' } }); }
    const cashout = existing.rows[0];
    if ((req.user.role || '').toLowerCase() === 'gudoomiye' && cashout.zone_id !== await resolveUserZoneId(req.user)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'This cashout is outside your zone.', code: 'FORBIDDEN' } });
    }
    // Phase 7 Approval Engine Discovery/Decisions — Future CR promoted to
    // in-scope: self-approval prevention, mirroring the exact pattern
    // already proven in Procurement (routes/procurement.js) and Inventory
    // Adjustments (routes/inventory.js). This is the ONE explicitly-
    // authorized narrow addition to this route — no other line changes.
    if (cashout.created_by === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'You cannot approve a cashout you created yourself.', code: 'FORBIDDEN' } });
    }
    const signedRes = await client.query(`SELECT 1 FROM cashout_attachments WHERE cashout_id = $1 AND document_type = 'signed_cashout_form' AND voided_at IS NULL LIMIT 1`, [id]);
    if (signedRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { message: 'Upload the signed cashout document before approving.', code: 'SIGNED_DOCUMENT_REQUIRED' } });
    }
    if (cashout.status === 'approved') { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: 'This cashout was already approved.', code: 'CONFLICT' } }); }
    if (cashout.status === 'voided') { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: 'Cannot approve a voided cashout.', code: 'CONFLICT' } }); }
    const updated = await client.query(
      `UPDATE cashouts SET status = 'approved', approved_by = $1, approved_at = NOW(), rejection_reason = NULL, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [req.user.id, id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout.approve', entityType: 'cashout', entityId: id, before: cashout, after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
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
    const existing = await client.query('SELECT * FROM cashouts WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Cashout not found.', code: 'NOT_FOUND' } }); }
    const cashout = existing.rows[0];
    if ((req.user.role || '').toLowerCase() === 'gudoomiye' && cashout.zone_id !== await resolveUserZoneId(req.user)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'This cashout is outside your zone.', code: 'FORBIDDEN' } });
    }
    // Phase 7 Approval Engine Discovery/Decisions — same narrow,
    // explicitly-authorized self-approval-prevention addition as /approve above.
    if (cashout.created_by === req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: { message: 'You cannot reject a cashout you created yourself.', code: 'FORBIDDEN' } });
    }
    if (cashout.status === 'approved') { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: 'An already-approved cashout cannot be rejected.', code: 'CONFLICT' } }); }
    const updated = await client.query(
      `UPDATE cashouts SET status = 'rejected', approved_by = $1, approved_at = NOW(), rejection_reason = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [req.user.id, reason, id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout.reject', entityType: 'cashout', entityId: id, before: cashout, after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: { message: 'Failed to reject cashout.', code: 'INTERNAL' } });
  } finally {
    client.release();
  }
});

// Void, not delete (OD-1) — allowed only pre-approval, matching the
// reference system's own reasoning (an unapproved cashout is a draft, not
// yet a finalized financial fact). Row + audit trail always preserved.
router.put('/:id/void', authenticateToken, requireRole(...VOID_ROLES), async (req, res) => {
  const id = parseStrictId(req.params.id);
  if (id === null) return res.status(400).json({ error: { message: 'Invalid cashout id.', code: 'VALIDATION' } });
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: { message: 'A reason is required to void a cashout.', code: 'VALIDATION' } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM cashouts WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: { message: 'Cashout not found.', code: 'NOT_FOUND' } }); }
    const cashout = existing.rows[0];
    if (cashout.status === 'approved') { await client.query('ROLLBACK'); return res.status(400).json({ error: { message: 'Cannot void an approved cashout — it is a finalized financial record.', code: 'VALIDATION' } }); }
    if (cashout.status === 'voided') { await client.query('ROLLBACK'); return res.status(409).json({ error: { message: 'This cashout is already voided.', code: 'CONFLICT' } }); }
    const updated = await client.query(
      `UPDATE cashouts SET status = 'voided', voided_at = NOW(), voided_by = $1, voided_reason = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [req.user.id, reason, id]
    );
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorUsername: req.user.username, action: 'cashout.void', entityType: 'cashout', entityId: id, before: cashout, after: updated.rows[0] });
    res.json({ data: updated.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
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
      `INSERT INTO cashout_attachments (cashout_id, document_type, original_filename, storage_path, mime_type, file_size, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, documentType, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.id]
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

module.exports = router;
