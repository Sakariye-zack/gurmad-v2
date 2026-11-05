// Automatic invoicing.
//  - Monthly customers: ONE invoice per month (fixed fee, own currency), generated from the 28th.
//  - Daily customers: ONE invoice per visit the collector marked serviced.
// Customers with billing_type NULL (legacy) are never auto-billed. Customers with no fee are
// skipped and reported. Idempotent: re-running never creates a second invoice.
const { pool } = require('../db');
const { insertInvoice } = require('./invoiceInsert');

const DEFAULT_TZ = 'Africa/Mogadishu';
const ADVISORY_LOCK_KEY = 74120028; // serialises runs across processes

async function getTimezone() {
  try {
    const r = await pool.query(`SELECT timezone FROM company_settings WHERE timezone IS NOT NULL AND timezone <> '' ORDER BY id LIMIT 1`);
    const tz = r.rows[0]?.timezone || DEFAULT_TZ;
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }); // validates
    return tz;
  } catch (_) {
    return DEFAULT_TZ;
  }
}

// Local calendar parts of an instant in a timezone.
function localParts(now, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const g = (t) => parts.find((p) => p.type === t).value;
  const year = Number(g('year')); const month = Number(g('month')); const day = Number(g('day'));
  const pad = (n) => String(n).padStart(2, '0');
  return { year, month, day, hour: Number(g('hour')), minute: Number(g('minute')),
    date: `${year}-${pad(month)}-${pad(day)}`, period: `${year}-${pad(month)}` };
}

function shiftDate(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function prevPeriod(period) {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

async function resolveCreatedBy(client, triggeredBy) {
  if (triggeredBy) return triggeredBy;
  const r = await client.query(`SELECT id FROM v2_users WHERE role = 'admin' AND is_active = TRUE ORDER BY id LIMIT 1`);
  if (!r.rows[0]) throw new Error('No active admin user available to own auto-generated invoices.');
  return r.rows[0].id;
}

const skipEntry = (c, reason) => ({ customer_id: c.id, customer_number: c.customer_number, name: c.name, reason });
const hasFee = (fee) => fee !== null && fee !== undefined && Number(fee) > 0;

// Wraps a run in a transaction + advisory lock. A billing_runs row is written only when informative:
// something was created, it is a manual run (triggeredBy set), it is the first run for that
// (kind, period_key), or it failed. This stops hourly catch-up ticks flooding the table.
async function recordedRun(kind, periodKey, triggeredBy, work) {
  const client = await pool.connect();
  const startedAt = new Date();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY]);
    const createdBy = await resolveCreatedBy(client, triggeredBy);
    const result = await work(client, createdBy);
    await client.query('COMMIT');
    let runId = null;
    // "First" means first SUCCESSFUL row: error rows must not suppress the first success record.
    const first = (await pool.query(`SELECT 1 FROM billing_runs WHERE kind = $1 AND period_key = $2 AND error IS NULL LIMIT 1`, [kind, periodKey])).rows.length === 0;
    if (result.created > 0 || triggeredBy || first) {
      const ins = await pool.query(
        `INSERT INTO billing_runs (kind, period_key, started_at, finished_at, created_count, skipped, triggered_by) VALUES ($1,$2,$3,NOW(),$4,$5,$6) RETURNING id`,
        [kind, periodKey, startedAt, result.created, JSON.stringify(result.skipped), triggeredBy || null]);
      runId = ins.rows[0].id;
    }
    return { ...result, run_id: runId };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    try {
      // Repeated identical failures (hourly ticks x catch-up days) are recorded once, not every tick.
      const msg = String(err.message || err);
      const last = await pool.query(`SELECT error FROM billing_runs WHERE kind = $1 AND period_key = $2 ORDER BY id DESC LIMIT 1`, [kind, periodKey]);
      if (triggeredBy || !(last.rows[0] && last.rows[0].error === msg)) {
        await pool.query(`INSERT INTO billing_runs (kind, period_key, started_at, finished_at, error, triggered_by) VALUES ($1,$2,$3,NOW(),$4,$5)`,
          [kind, periodKey, startedAt, msg, triggeredBy || null]);
      }
    } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

// Insert inside a SAVEPOINT so one bad row cannot roll back (and block) the whole run.
async function safeInsert(client, params) {
  await client.query('SAVEPOINT bill_row');
  try {
    const inv = await insertInvoice(client, params);
    await client.query('RELEASE SAVEPOINT bill_row');
    return { inv };
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT bill_row');
    await client.query('RELEASE SAVEPOINT bill_row');
    return { error: String(err.message || err) };
  }
}

// Go-live cutoff: daily auto-billing never bills visits before the local date the engine first ran,
// so the first boot cannot retro-bill history that was already invoiced by hand.
async function ensureDailyStartDate(tz) {
  await pool.query(`INSERT INTO billing_settings (id, daily_start_date) VALUES (1, $1::date) ON CONFLICT (id) DO NOTHING`, [localParts(new Date(), tz).date]);
  await pool.query(`UPDATE billing_settings SET daily_start_date = $1::date WHERE id = 1 AND daily_start_date IS NULL`, [localParts(new Date(), tz).date]);
  const r = await pool.query(`SELECT to_char(daily_start_date, 'YYYY-MM-DD') AS d FROM billing_settings WHERE id = 1`);
  return r.rows[0].d;
}

// manual=true ignores the day>=28 rule. period ('YYYY-MM') defaults to the local month of `now`.
async function runMonthly({ now = new Date(), triggeredBy = null, manual = false, period = null } = {}) {
  const tz = await getTimezone();
  const local = localParts(now, tz);
  if (!manual && local.day < 28) return { created: 0, skipped: [], not_due: true };
  const periodKey = period || local.period;
  return recordedRun('monthly', periodKey, triggeredBy, async (client, createdBy) => {
    // A customer who already has a (manual) non-voided invoice created in that local month is not
    // billed again, otherwise the first automatic run would double-bill them.
    const custs = await client.query(
      `SELECT c.id, c.customer_number, c.name, c.fee, c.fee_currency, z.name AS zone_name,
         EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status <> 'voided'
           AND i.billing_period IS NULL AND i.batch_customer_id IS NULL
           AND to_char((i.created_at AT TIME ZONE 'UTC' AT TIME ZONE $2), 'YYYY-MM') = $1) AS already_invoiced
       FROM customers c LEFT JOIN zones z ON z.id = c.zone_id
       WHERE c.status = 'active' AND c.billing_type = 'monthly'
         AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.billing_period = $1 AND i.status <> 'voided')
       ORDER BY c.id`, [periodKey, tz]);
    let created = 0;
    const skipped = [];
    for (const c of custs.rows) {
      if (!hasFee(c.fee)) { skipped.push(skipEntry(c, 'no_fee')); continue; }
      if (c.already_invoiced) { skipped.push(skipEntry(c, 'already_invoiced')); continue; }
      const r = await safeInsert(client, { customerId: c.id, total: c.fee, currency: c.fee_currency || 'USD',
        zoneNameSnapshot: c.zone_name, notes: `Monthly fee ${periodKey} (auto-generated)`, createdBy, billingPeriod: periodKey, autoGenerated: true });
      if (r.error) skipped.push(skipEntry(c, 'error: ' + r.error));
      else if (r.inv) created += 1;
    }
    return { created, skipped };
  });
}

async function runDaily({ date, triggeredBy = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('runDaily needs a date (YYYY-MM-DD).');
  const tz = await getTimezone();
  const startDate = await ensureDailyStartDate(tz);
  if (date < startDate) return { created: 0, skipped: [], before_go_live: true };
  return recordedRun('daily', date, triggeredBy, async (client, createdBy) => {
    // status_at is a naive UTC timestamp: convert to company-local time before taking the date.
    // Any existing invoice (even voided) blocks re-billing the visit: a deliberate void must stick.
    const rows = await client.query(
      `SELECT bc.id AS bc_id, c.id, c.customer_number, c.name, c.fee, c.fee_currency, z.name AS zone_name,
         EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status <> 'voided' AND i.batch_customer_id IS NULL
           AND (i.created_at AT TIME ZONE 'UTC' AT TIME ZONE $2)::date = $1::date) AS already_invoiced
       FROM batch_customers bc
       JOIN customers c ON c.id = bc.customer_id
       LEFT JOIN zones z ON z.id = c.zone_id
       WHERE bc.status = 'serviced' AND (bc.status_at AT TIME ZONE 'UTC' AT TIME ZONE $2)::date = $1::date AND c.billing_type = 'daily'
         AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.batch_customer_id = bc.id)
       ORDER BY bc.id`, [date, tz]);
    let created = 0;
    const skipped = [];
    for (const r of rows.rows) {
      if (!hasFee(r.fee)) { skipped.push(skipEntry(r, 'no_fee')); continue; }
      if (r.already_invoiced) { skipped.push(skipEntry(r, 'already_invoiced')); continue; }
      const res = await safeInsert(client, { customerId: r.id, batchCustomerId: r.bc_id, total: r.fee, currency: r.fee_currency || 'USD',
        zoneNameSnapshot: r.zone_name, notes: `Daily service ${date} (auto-generated)`, createdBy, autoGenerated: true });
      if (res.error) skipped.push(skipEntry(r, 'error: ' + res.error));
      else if (res.inv) created += 1;
    }
    return { created, skipped };
  });
}

async function hasSuccessfulMonthly(period) {
  const r = await pool.query(`SELECT 1 FROM billing_runs WHERE kind = 'monthly' AND period_key = $1 AND finished_at IS NOT NULL AND error IS NULL LIMIT 1`, [period]);
  return r.rows.length > 0;
}

async function schedulerTick(now = new Date()) {
  const tz = await getTimezone();
  const local = localParts(now, tz);
  const guard = async (label, fn) => { try { await fn(); } catch (e) { console.error(`auto-billing ${label} failed:`, e.message); } };
  if (local.day >= 28 && !(await hasSuccessfulMonthly(local.period))) {
    await guard('monthly', () => runMonthly({ now }));
  }
  // Catch-up for a missed previous month (e.g. server down on the 28th-31st). Only once the engine has
  // run before, so the very first deploy never retro-bills a month nobody asked for.
  const prev = prevPeriod(local.period);
  const everRan = (await pool.query(`SELECT 1 FROM billing_runs WHERE kind = 'monthly' AND finished_at IS NOT NULL AND error IS NULL LIMIT 1`)).rows.length > 0;
  if (everRan && !(await hasSuccessfulMonthly(prev))) {
    await guard('monthly catch-up', () => runMonthly({ now, manual: true, period: prev }));
  }
  // Daily: the last 7 local days are re-checked every tick (idempotent); today only from 23:00.
  const days = [];
  for (let i = 1; i <= 7; i++) days.push(shiftDate(local.date, -i));
  if (local.hour >= 23) days.unshift(local.date);
  for (const date of days) await guard('daily', () => runDaily({ date }));
}

function startScheduler() {
  if (process.env.AUTO_BILLING === 'off') return null;
  getTimezone().then(ensureDailyStartDate).catch((e) => console.error('auto-billing go-live date failed:', e && e.message));
  const safeTick = () => schedulerTick().catch((e) => console.error('auto-billing tick failed:', e && e.message));
  const first = setTimeout(safeTick, 30 * 1000);
  const timer = setInterval(safeTick, 60 * 60 * 1000);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
  return { first, timer };
}

module.exports = { runMonthly, runDaily, startScheduler, schedulerTick, localParts, getTimezone };
