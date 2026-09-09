const { Pool, types } = require('pg');

// pg's default DATE (OID 1082) parser returns a JS Date object at
// local-timezone midnight, which then serializes to a UTC ISO string that
// is off by a day whenever the server's local timezone is ahead of UTC
// (this host runs EAT, UTC+3) — a real date field (e.g. "2026-12-31")
// silently became "2026-12-30T21:00:00.000Z" in every API response. Found
// during Phase 3 Module 4 QA (trucks' insurance/registration/road_tax
// expiry dates), but this is a driver-level fix — it also silently
// affected Employees' join_date and any future DATE column, not just
// Trucks. Returning the raw "YYYY-MM-DD" string instead of a Date object
// is correct for every current use (no time-of-day is ever stored) and
// matches what the frontend's plain <input type="date"> already expects.
types.setTypeParser(1082, (val) => val);

// Production Readiness (T) — O-6, Implementation Spec §4. V2 previously had
// NO SSL/TLS support at all, unlike the reference backend (whose own
// db.js has a conditional SSL block keyed on the host string containing
// "supabase" — real evidence production/staging is managed-PostgreSQL-
// hosted). Deliberately NOT copying the reference backend's own default:
// its `rejectUnauthorized: false` is a silent, always-on verification
// weakening; DB_SSL_REJECT_UNAUTHORIZED here defaults to true (verified
// certificates) — an explicit, visible, per-environment opt-out is
// required to weaken it, never a blanket default. DB_SSL is opt-in
// (default false) so local dev/QA (`gurmad_v2_db`/`gurmad_v2_qa_ref`,
// local Postgres, no TLS) are completely unaffected — zero behavior
// change there, confirmed by this flag defaulting off.
//
// Hardening fix: DB_SSL was previously parsed as a strict `=== 'true'`
// check — any operator typo (DB_SSL=TRUE, DB_SSL=1, DB_SSL=yes) silently
// evaluated to false, disabling SSL with zero warning. That is exactly
// the "no silent downgrade" principle this whole feature exists to
// enforce, now applied to the env var itself, not just the connection
// behavior: an unrecognized non-empty DB_SSL value now refuses to start
// (fail loudly) rather than silently proceeding unencrypted. Only the
// canonical values "true"/"false" (case-insensitive) or an unset/empty
// var are accepted silently.
const rawDbSsl = (process.env.DB_SSL || '').trim().toLowerCase();
if (rawDbSsl && rawDbSsl !== 'true' && rawDbSsl !== 'false') {
  console.error(`FATAL: DB_SSL is set to an unrecognized value ("${process.env.DB_SSL}"). Use "true" or "false" explicitly — refusing to guess and silently disable SSL.`);
  process.exit(1);
}
const useSsl = rawDbSsl === 'true';
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: useSsl
    ? {
        rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
        ca: process.env.DB_SSL_CA || undefined,
      }
    : false,
});

// Fail loudly on a real connection error (bad certificate, unreachable
// host, handshake failure) rather than letting it surface only as a
// mysterious query-time failure later — matches the existing
// JWT_SECRET-missing pattern (middleware/auth.js): refuse to run in a
// broken state rather than silently degrading. This does NOT retry or
// fall back to an unencrypted connection under any circumstance — `pg`
// itself does not silently downgrade a configured SSL connection, and
// this handler does not introduce one.
pool.on('error', (err) => {
  console.error('FATAL: unexpected database pool error.', err.message);
});

// V2 database rule: do not blindly copy the current schema. This is the
// V2 implementation target, designed fresh per Database_Architecture_AsBuilt.md
// V2 Required Additions. Idempotent, same style as the reference backend's
// own runMigrations() convention.
async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zones (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      zone_code VARCHAR(50) UNIQUE NOT NULL,
      sub_zone VARCHAR(100),
      area VARCHAR(100),
      coordinates JSONB,
      collection_days JSONB,
      status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS v2_audit_log (
      id SERIAL PRIMARY KEY,
      actor_id INTEGER,
      actor_username VARCHAR(50),
      action VARCHAR(50) NOT NULL,
      entity_type VARCHAR(50) NOT NULL,
      entity_id INTEGER,
      before_data JSONB,
      after_data JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Approved V2 zone set (DR-2/DR-3): exactly these two operational zones.
  // ON CONFLICT on zone_code makes this safe to run on every boot.
  await pool.query(`
    INSERT INTO zones (name, zone_code, status)
    VALUES ('Farah Omar', 'FARAH-OMAR', 'active'),
           ('Sheekh Bashiir', 'SHEEKH-BASHIIR', 'active')
    ON CONFLICT (zone_code) DO NOTHING;
  `);

  // Phase 3 Module 2 — Customer Master Data.
  // customer_number is a human-facing business identifier — auto-generated,
  // editable, unique — NEVER the relational key. Every FK elsewhere must
  // reference customers.id (see Discovery §3-6/§9/§24).
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS customer_number_seq START 1;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      customer_number VARCHAR(20) UNIQUE NOT NULL,
      customer_type VARCHAR(20) NOT NULL DEFAULT 'residential' CHECK (customer_type IN ('residential', 'commercial')),
      name VARCHAR(100) NOT NULL,
      business_name VARCHAR(150),
      phone VARCHAR(20) NOT NULL,
      alternate_phone VARCHAR(20),
      whatsapp VARCHAR(20),
      email VARCHAR(150),
      address_line VARCHAR(200),
      zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE RESTRICT,
      sub_zone VARCHAR(100),
      lat NUMERIC,
      lng NUMERIC,
      status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
      commercial_shift VARCHAR(10) CHECK (commercial_shift IN ('day', 'night')),
      collection_frequency VARCHAR(50),
      collection_mode VARCHAR(50),
      fee NUMERIC,
      notes TEXT,
      registered_by INTEGER,
      registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_zone_id ON customers(zone_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_customer_type ON customers(customer_type);`);
  // Case-insensitive lookup for the duplicate-warning check (§13/OD-2).
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);`);

  // Phase 3 Module 3 — Employees (Staff Master Data).
  //
  // employees.user_id: OD-2 approved this as "a proper FK to users.id" — but
  // `users` lives in the reference T2.8-F backend's OWN database (a separate
  // service/DB by Foundation-phase design; see Phase_1 Foundation plan), not
  // in this V2 database. Postgres cannot enforce a real FK across databases.
  // Discovered and reported, not silently worked around: this column is a
  // plain nullable INTEGER with a UNIQUE constraint (real one-to-one
  // enforcement, DB-level, within this database) and app-level format
  // validation only — existence-checking against the actual users table is
  // deferred (would require either a new cross-service HTTP call out to the
  // reference backend, or database consolidation — both are Users/Auth
  // redesign decisions explicitly out of scope for this checkpoint).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      job_role VARCHAR(100),
      employee_type VARCHAR(20) NOT NULL DEFAULT 'other' CHECK (employee_type IN ('collector', 'driver', 'office', 'other')),
      collector_type VARCHAR(20) CHECK (collector_type IN ('residential', 'commercial')),
      commercial_shift VARCHAR(10) CHECK (commercial_shift IN ('day', 'night')),
      phone VARCHAR(20) NOT NULL,
      zone_id INTEGER REFERENCES zones(id) ON DELETE RESTRICT,
      status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_leave', 'suspended', 'archived')),
      salary NUMERIC,
      join_date DATE,
      photo VARCHAR(255),
      id_document VARCHAR(255),
      guarantor_name VARCHAR(100),
      guarantor_phone VARCHAR(20),
      notes TEXT,
      user_id INTEGER UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_employees_zone_id ON employees(zone_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_employees_status ON employees(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_employees_employee_type ON employees(employee_type);`);

  // Phase 3 Module 4 — Trucks (Fleet Master Data).
  // driver_id/collector_id are real FKs to the now-authoritative employees
  // table (Module 3, closed) — ON DELETE RESTRICT is safe since employees
  // has no delete path either (archive-only, same pattern). Cross-field
  // validation that driver_id actually points at an employee_type='driver'
  // row (and collector_id at 'collector') is enforced at the application
  // layer in routes/trucks.js — not expressible as a plain CHECK constraint
  // since it requires a join, same reasoning already applied to Employees'
  // own collector_type/commercial_shift cross-validation.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trucks (
      id SERIAL PRIMARY KEY,
      plate_number VARCHAR(50) UNIQUE NOT NULL,
      model VARCHAR(100),
      capacity INTEGER,
      zone_id INTEGER REFERENCES zones(id) ON DELETE RESTRICT,
      driver_id INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
      collector_id INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
      status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'inactive', 'retired')),
      insurance_expiry DATE,
      registration_expiry DATE,
      road_tax_expiry DATE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_trucks_zone_id ON trucks(zone_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_trucks_status ON trucks(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_trucks_driver_id ON trucks(driver_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_trucks_collector_id ON trucks(collector_id);`);

  // Module 5 final review: the smallest isolated authorization mechanism
  // for cross-zone Reschedule, per explicit instruction NOT to migrate the
  // global RBAC architecture (checkRole vs requirePermission) in this
  // checkpoint. One additive, narrowly-scoped boolean column on the
  // already-frozen employees table (ALTER TABLE, not touching Module 3's
  // own CREATE TABLE block) — default false for everyone, meaning nobody
  // can cross-zone-reschedule unless explicitly granted. Admin is
  // unaffected (already zone-unrestricted by construction). This is a
  // permission specific to one operation, not a new general permission
  // catalog/engine.
  await pool.query(`ALTER TABLE employees ADD COLUMN IF NOT EXISTS can_reschedule_cross_zone BOOLEAN NOT NULL DEFAULT false;`);

  // Phase 3 Module 5 — Collection Operations (Cycles / Batches / Batch
  // Customers / Tasks / Task Resources). Target model is the current
  // system's newer batches/task_resources shape (OD-approved) — the older
  // tasks/task_customers table in the CURRENT system is legacy and lives in
  // a completely separate database/service; V2 never writes to it (see
  // routes/collectionOps.js header comment for the full legacy-dual-write
  // audit finding).
  //
  // Lifecycle vocabulary is reused verbatim from the current system's own
  // proven values, not invented: batches.status (Draft/Assigned/In
  // Progress/Partially Completed/Completed/Cancelled, lowercased+
  // underscored for V2 convention), batch_customers.status (Pending/
  // Serviced/Missed/Skipped/Rescheduled), tasks.status (Pending/In
  // Progress/Completed — the only 3 values the current system's own
  // PUT /api/tasks/:id/status route actually uses).
  //
  // collection_cycles keeps the current system's plain is_active boolean
  // rather than introducing a new status enum — a cycle has exactly two
  // real states (open/closed) today and "closing a cycle" is already a
  // named action; formalizing that into a two-value CHECK would be
  // renaming, not new vocabulary, but the boolean is kept as-is to stay
  // maximally faithful to the proven current behavior per instruction.
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS batch_number_seq;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS collection_cycles (
      id SERIAL PRIMARY KEY,
      zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE RESTRICT,
      cycle_type VARCHAR(20) NOT NULL CHECK (cycle_type IN ('monthly', 'weekly', 'custom')),
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cycles_zone_id ON collection_cycles(zone_id);`);

  // DR-7: a batch is either all-Residential or all-Commercial (with a
  // shift) — customer_type/commercial_shift live on the batch, the same
  // "operation-level classification" pattern DR-7's own approved design
  // describes ("a batch is built as either all-Residential or all-
  // Commercial"). This is what assignment-time and task-start validation
  // check a collector's employee record against.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS batches (
      id SERIAL PRIMARY KEY,
      batch_code VARCHAR(50) UNIQUE NOT NULL,
      zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE RESTRICT,
      cycle_id INTEGER NOT NULL REFERENCES collection_cycles(id) ON DELETE RESTRICT,
      batch_number INTEGER NOT NULL,
      customer_type VARCHAR(20) NOT NULL DEFAULT 'residential' CHECK (customer_type IN ('residential', 'commercial')),
      commercial_shift VARCHAR(10) CHECK (commercial_shift IN ('day', 'night')),
      start_date DATE NOT NULL,
      end_date DATE,
      total_customers INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(30) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'assigned', 'in_progress', 'partially_completed', 'completed', 'cancelled')),
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      assigned_at TIMESTAMP,
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      cancelled_at TIMESTAMP,
      cancelled_reason TEXT,
      notes TEXT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_batches_zone_id ON batches(zone_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_batches_cycle_id ON batches(cycle_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);`);
  // Operational Calendar — Implementation Spec §14. The one approved index:
  // supports the calendar's own zone-scoped date-range overlap query
  // (zone_id equality + start_date/end_date range scan in one traversal).
  // Additive, idempotent, zero existing index touched.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_batches_zone_date_range ON batches(zone_id, start_date, end_date);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS batch_customers (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'serviced', 'missed', 'skipped', 'rescheduled')),
      rescheduled_to_batch_id INTEGER REFERENCES batches(id),
      status_reason VARCHAR(255),
      status_note TEXT,
      status_photo VARCHAR(255),
      status_lat NUMERIC(10,8),
      status_lng NUMERIC(11,8),
      status_at TIMESTAMP,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (customer_id, batch_id),
      CONSTRAINT rescheduled_needs_target CHECK (status != 'rescheduled' OR rescheduled_to_batch_id IS NOT NULL)
    );
  `);
  // Preserved verbatim from the current system: the partial unique index
  // that is the real enforcement of "a customer can't be Pending in two
  // open batches at once" (the plain UNIQUE above only stops the same
  // customer being added twice to the SAME batch).
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_batch_per_customer
      ON batch_customers (customer_id)
      WHERE status = 'pending';
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_batch_customers_batch_id ON batch_customers(batch_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_batch_customers_customer_id ON batch_customers(customer_id);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
      scheduled_at TIMESTAMP,
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_batch_id ON tasks(batch_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);`);

  // task_resources.resource_id is a POLYMORPHIC reference (OD-1, approved):
  // resource_type='collector'|'driver' -> employees.id,
  // resource_type='truck' -> trucks.id,
  // resource_type='cashier' -> users.id (reference-only, same cross-
  // database limitation as employees.user_id — users lives in the
  // reference backend's own database).
  // Postgres cannot express a conditional FK, so this column carries NO
  // database-level FK constraint — existence/type/eligibility are enforced
  // entirely at the application layer in routes/collectionOps.js. This is
  // a deliberate, documented limitation (OD-1), not an oversight.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_resources (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      resource_type VARCHAR(20) NOT NULL CHECK (resource_type IN ('collector', 'driver', 'truck', 'cashier')),
      resource_id INTEGER NOT NULL,
      role_note VARCHAR(100),
      assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (task_id, resource_type, resource_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_task_resources_task_id ON task_resources(task_id);`);

  // Append-only ledger — never UPDATEd or DELETEd, preserved verbatim from
  // the current system's own design.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_resource_history (
      id SERIAL PRIMARY KEY,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      resource_type VARCHAR(20) NOT NULL,
      resource_id INTEGER NOT NULL,
      action VARCHAR(20) NOT NULL CHECK (action IN ('assigned', 'removed')),
      reason TEXT,
      performed_by INTEGER,
      performed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_task_resource_history_task_id ON task_resource_history(task_id);`);

  // Computed, not stored — avoids a stored percentage silently drifting
  // from the real counts. Preserved verbatim from the current system.
  await pool.query(`
    CREATE OR REPLACE VIEW batch_progress AS
    SELECT
      b.id AS batch_id,
      COUNT(bc.id) AS total,
      COUNT(bc.id) FILTER (WHERE bc.status = 'serviced')    AS serviced,
      COUNT(bc.id) FILTER (WHERE bc.status = 'missed')      AS missed,
      COUNT(bc.id) FILTER (WHERE bc.status = 'skipped')     AS skipped,
      COUNT(bc.id) FILTER (WHERE bc.status = 'rescheduled') AS rescheduled,
      COUNT(bc.id) FILTER (WHERE bc.status = 'pending')     AS pending,
      ROUND(100.0 * COUNT(bc.id) FILTER (WHERE bc.status = 'serviced') / NULLIF(COUNT(bc.id), 0), 1) AS percent_complete
    FROM batches b
    LEFT JOIN batch_customers bc ON bc.batch_id = b.id
    GROUP BY b.id;
  `);

  // ============================================================
  // Phase 3 Module 6 — Financial Billing Foundation (Invoices /
  // Billing-Payments / Debts / Exchange Rates). Approved via
  // Phase3_Module06_FinancialBilling_Implementation_Spec.md.
  // All additive — zero changes to any Zones/Customers/Employees/
  // Trucks/Collection Operations table (Modules 1-5, CLOSED).
  // ============================================================

  // 1. exchange_rates — append-only rate history (OD-3). Never
  // UPDATEd or DELETEd by any route; history is guaranteed by
  // construction, matching task_resource_history's own precedent.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exchange_rates (
      id SERIAL PRIMARY KEY,
      rate NUMERIC NOT NULL CHECK (rate > 0),
      effective_from TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      set_by INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_exchange_rates_effective_from ON exchange_rates(effective_from DESC);`);
  // Seed exactly one baseline rate if none exists yet — otherwise the
  // first SLSH payment anyone attempts has nothing to reference.
  // Matches the reference system's own bootstrap default (11000).
  await pool.query(`
    INSERT INTO exchange_rates (rate, effective_from, set_by)
    SELECT 11000, CURRENT_TIMESTAMP, 0
    WHERE NOT EXISTS (SELECT 1 FROM exchange_rates);
  `);

  // 2. invoices — the financial document/obligation (OD-2, OD-6).
  // `status` is a CACHED, recomputed-on-every-payment-write column —
  // the ONLY code path allowed to write it is
  // lib/financialCalculations.js's recalculateInvoiceStatus(). No
  // route may assign it directly (enforced by code review discipline,
  // not a DB trigger — consistent with how V2 enforces every other
  // cross-cutting rule so far).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      invoice_number VARCHAR(20) UNIQUE NOT NULL,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      batch_customer_id INTEGER REFERENCES batch_customers(id) ON DELETE SET NULL,
      invoice_total NUMERIC NOT NULL CHECK (invoice_total >= 0),
      discount_amount NUMERIC NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
      currency VARCHAR(10) NOT NULL DEFAULT 'USD',
      status VARCHAR(20) NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','partial','paid','voided')),
      voided_at TIMESTAMP,
      voided_by INTEGER,
      voided_reason TEXT,
      collector_name_snapshot VARCHAR(100),
      truck_name_snapshot VARCHAR(100),
      zone_name_snapshot VARCHAR(100),
      notes TEXT,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices(customer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invoices_batch_customer_id ON invoices(batch_customer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);`);
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;`);

  // 3. payments — the money-movement ledger (OD-4). Append-oriented:
  // no DELETE route will ever be exposed. amount_usd is computed and
  // STORED at write time so a later exchange-rate change can never
  // alter a historical payment's USD value (non-negotiable rule #3/#4).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
      amount NUMERIC NOT NULL CHECK (amount > 0),
      currency VARCHAR(10) NOT NULL,
      method VARCHAR(20) NOT NULL CHECK (method IN ('cash','zaad','edahab','slsh','debt')),
      amount_usd NUMERIC NOT NULL,
      exchange_rate_id INTEGER REFERENCES exchange_rates(id),
      cashier_id INTEGER NOT NULL,
      reference_code VARCHAR(50),
      status VARCHAR(20) NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','reversed')),
      reversed_at TIMESTAMP,
      reversed_by INTEGER,
      reversed_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT slsh_requires_rate CHECK (
        (currency = 'USD' AND exchange_rate_id IS NULL) OR
        (currency = 'SLSH' AND exchange_rate_id IS NOT NULL)
      ),
      CONSTRAINT reversal_requires_reason CHECK (
        status != 'reversed' OR (reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND reversed_reason IS NOT NULL)
      )
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments(invoice_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_cashier_id ON payments(cashier_id);`);

  // 4. debts — built fresh in V2 (never existed here before this
  // module), including the OD-1 invoice_id FK from day one — not a
  // later migration of existing data, since none exists yet.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS debts (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      invoice_id INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
      amount NUMERIC NOT NULL CHECK (amount > 0),
      currency VARCHAR(10) NOT NULL DEFAULT 'USD',
      description TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid')),
      settled_at TIMESTAMP,
      settled_by INTEGER,
      settlement_override_reason TEXT,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_debts_customer_id ON debts(customer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_debts_invoice_id ON debts(invoice_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_debts_status ON debts(status);`);

  // ============================================================
  // Phase 3 Module 7 — Cashout & Cash Reconciliation. Approved via
  // Phase3_Module07_Cashout_Discovery.md's OD-1/OD-3/OD-4/OD-5 and the
  // subsequent UX-refinement direction. Additive only.
  //
  // The ONE approved touch to CLOSED Module 6: debts.cashout_id below.
  // Deliberately NOT adding a payments.cashout_id column (that would be
  // a SECOND Module 6 touch beyond the single one explicitly approved
  // — "If anything beyond that is required: STOP and report"). Instead,
  // a cashout reconciles against payments read-only, scoped by
  // cashier_id + a [period_start, period_end) time window stored on
  // the cashout itself; double-counting is prevented at write time by
  // rejecting a new cashout whose window overlaps an existing
  // non-voided cashout for the same cashier (routes/cashouts.js), not
  // by a DB constraint on payments. This is the smallest-isolated-
  // mechanism resolution to the reconciliation requirement without
  // expanding Module 6's own already-closed schema.
  // ============================================================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cashouts (
      id SERIAL PRIMARY KEY,
      cashout_number VARCHAR(20) UNIQUE NOT NULL,
      zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE RESTRICT,
      cashier_id INTEGER NOT NULL,
      head_of_cashiers_id INTEGER NOT NULL,
      period_start TIMESTAMP NOT NULL,
      period_end TIMESTAMP NOT NULL,
      expected_amount NUMERIC NOT NULL,
      actual_amount NUMERIC NOT NULL CHECK (actual_amount >= 0),
      cash_amount NUMERIC NOT NULL DEFAULT 0,
      zaad_amount NUMERIC NOT NULL DEFAULT 0,
      edahab_amount NUMERIC NOT NULL DEFAULT 0,
      slsh_amount NUMERIC NOT NULL DEFAULT 0,
      shortage NUMERIC NOT NULL DEFAULT 0 CHECK (shortage >= 0),
      surplus NUMERIC NOT NULL DEFAULT 0 CHECK (surplus >= 0),
      shortage_reason TEXT,
      remarks TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','voided')),
      approved_by INTEGER,
      approved_at TIMESTAMP,
      rejection_reason TEXT,
      voided_at TIMESTAMP,
      voided_by INTEGER,
      voided_reason TEXT,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      -- Not both a shortfall and an overage on the same reconciliation.
      CONSTRAINT not_both_shortage_and_surplus CHECK (shortage = 0 OR surplus = 0)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cashouts_zone_id ON cashouts(zone_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cashouts_cashier_id ON cashouts(cashier_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cashouts_status ON cashouts(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cashouts_period ON cashouts(cashier_id, period_start, period_end);`);
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS cashout_number_seq;`);

  // Signed document + supporting evidence — a small, reusable attachment
  // table scoped to this module only (explicitly NOT a general Document
  // Management System, per instruction). document_type is a fixed,
  // reused-not-invented category list matching exactly what was asked
  // for. Never overwritten in place — a new signed copy is a new row,
  // preserving both the system-generated document and every uploaded
  // signed copy, per the explicit "never overwrite" instruction.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cashout_attachments (
      id SERIAL PRIMARY KEY,
      cashout_id INTEGER NOT NULL REFERENCES cashouts(id) ON DELETE RESTRICT,
      document_type VARCHAR(30) NOT NULL CHECK (document_type IN (
        'signed_cashout_form', 'deposit_slip', 'cash_handover_evidence',
        'receipt', 'shortage_explanation', 'approval_document', 'other'
      )),
      original_filename VARCHAR(255) NOT NULL,
      storage_path VARCHAR(500) NOT NULL,
      mime_type VARCHAR(100),
      file_size INTEGER,
      uploaded_by INTEGER NOT NULL,
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      voided_at TIMESTAMP,
      voided_by INTEGER,
      voided_reason TEXT
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cashout_attachments_cashout_id ON cashout_attachments(cashout_id);`);

  // The ONE approved additive touch to CLOSED Module 6's own table —
  // nullable, so a debt created independently of a cashout (an invoice-
  // originated debt, or a standalone one) is entirely unaffected. This
  // remains reserved for a legitimate customer-owed Debt that happens to
  // be associated with a cashout — NEVER for a cashier's own shortage
  // (see cashout_shortages below, which is the correct, separate model
  // for that — architecture decision, Module 7 final hardening pass).
  await pool.query(`ALTER TABLE debts ADD COLUMN IF NOT EXISTS cashout_id INTEGER REFERENCES cashouts(id) ON DELETE SET NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_debts_cashout_id ON debts(cashout_id);`);

  // Cashout Shortage — a cashier accountability/reconciliation-liability
  // record, explicitly NOT a Module 6 Debt (a Debt is owed by a customer;
  // a shortage is owed by the cashier — no shared table, no fake
  // customer_id, no touch to debts.customer_id or its NOT NULL
  // constraint). Additive Module 7 table only; CLOSED Module 6 untouched
  // beyond the single already-approved debts.cashout_id column above.
  // status reuses debts' own already-frozen 'unpaid'/'paid' vocabulary
  // (the closest existing precedent for "an amount not yet settled vs.
  // settled") rather than inventing new lifecycle words — per the
  // explicit instruction not to invent terminology where an existing
  // one already covers the concept. No automatic recovery mechanism
  // (salary/payroll deduction, auto-debt, auto-accounting-entry) is
  // implemented anywhere here — resolution is a manual, audited action
  // only, exactly as instructed.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cashout_shortages (
      id SERIAL PRIMARY KEY,
      cashout_id INTEGER NOT NULL REFERENCES cashouts(id) ON DELETE RESTRICT,
      cashier_id INTEGER NOT NULL,
      expected_amount NUMERIC NOT NULL,
      actual_amount NUMERIC NOT NULL,
      shortage_amount NUMERIC NOT NULL CHECK (shortage_amount > 0),
      currency VARCHAR(10) NOT NULL DEFAULT 'USD',
      reason TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid')),
      resolved_amount NUMERIC,
      resolved_at TIMESTAMP,
      resolved_by INTEGER,
      resolution_notes TEXT,
      notes TEXT,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT resolution_requires_fields CHECK (
        status != 'paid' OR (resolved_amount IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
      )
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cashout_shortages_cashout_id ON cashout_shortages(cashout_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cashout_shortages_cashier_id ON cashout_shortages(cashier_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cashout_shortages_status ON cashout_shortages(status);`);
  // A cashout can have at most one shortage record (one reconciliation,
  // one shortage) — enforced structurally, not just by application logic.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS one_shortage_per_cashout ON cashout_shortages(cashout_id);`);

  // ============================================================
  // Phase 3 Module 8 — Reports. Approved via
  // Phase3_Module08_Reports_Implementation_Spec.md §18. Reports is a
  // read/aggregation layer only — no new transactional table. The ONLY
  // approved touch to CLOSED Module 6's schema: these 2 additive,
  // performance-only indexes, justified directly by the period-range
  // filter (WHERE created_at >= $1 AND created_at < $2) every report
  // query in the spec actually uses — not speculative. Index-only:
  // no column, constraint, or business-logic change to payments/
  // invoices. Nothing else in Module 6/5/7 is touched.
  // ============================================================
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices(created_at);`);

  // ============================================================
  // Phase 4 — Customer Portal. Approved via
  // Phase4_CustomerPortal_Implementation_Spec.md §4, OD-2. Module 2
  // (customers) is CLOSED/FROZEN — these 3 tables are fully additive,
  // zero ALTER on `customers`. customer_portal_accounts.customer_id is
  // the ONLY link back to the closed customer master record
  // (ON DELETE RESTRICT: deleting a portal account must never be able to
  // cascade into deleting the underlying customer — and a customer record
  // can't be deleted out from under a live portal account either).
  // ============================================================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_portal_accounts (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL UNIQUE REFERENCES customers(id) ON DELETE RESTRICT,
      password_hash VARCHAR(255) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      failed_login_count INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMP,
      last_login_at TIMESTAMP,
      activated_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_portal_accounts_status ON customer_portal_accounts(status);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_portal_password_resets (
      id SERIAL PRIMARY KEY,
      portal_account_id INTEGER NOT NULL REFERENCES customer_portal_accounts(id) ON DELETE CASCADE,
      token_hash VARCHAR(255) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      requested_ip VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_portal_password_resets_account ON customer_portal_password_resets(portal_account_id);`);
  // Token lookup happens by hash, never by id — an index makes the lookup
  // itself O(log n) instead of a full scan without weakening single-use
  // (used_at) or expiry enforcement, both checked in application code.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_portal_password_resets_token_hash ON customer_portal_password_resets(token_hash);`);

  // A dedicated portal audit log, separate from v2_audit_log (whose
  // actor_id/actor_username columns assume a staff user from the reference
  // backend's own users table) — a customer is a structurally different
  // actor, per Implementation Spec §22.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_portal_audit_log (
      id SERIAL PRIMARY KEY,
      portal_account_id INTEGER REFERENCES customer_portal_accounts(id) ON DELETE SET NULL,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      action VARCHAR(50) NOT NULL,
      ip_address VARCHAR(64),
      details JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_portal_audit_log_account ON customer_portal_audit_log(portal_account_id);`);

  // ============================================================
  // Customer Portal — FULL REBUILD. Approved via
  // Phase4_CustomerPortal_Rebuild_Implementation_Spec.md §7/§33.
  // Both additions below are additive-only, entirely inside the Portal's
  // own already-separate schema — zero touch to `customers` or any
  // Module 1-9 table.
  // ============================================================

  // Token revocation (OD-3, Spec §6): a monotonically-increasing counter,
  // embedded in every issued JWT and compared on every authenticated
  // request (middleware/customerPortalAuth.js). Bumping it instantly
  // invalidates every token issued before the bump, with no session
  // table and no cleanup/retention surface.
  await pool.query(`ALTER TABLE customer_portal_accounts ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1;`);

  // Notification persistence (Decision Record OD-2, built now per explicit
  // instruction — not a UI shell). Generic across future producers
  // (invoices/payments/collections/complaints/account-security) — no
  // producer is wired in yet (Complaints, the only named one, doesn't
  // exist in V2 as of this pass). customer_id uses RESTRICT, matching
  // V2's own established convention (e.g. invoices.customer_id) —
  // a deliberate departure from the reference system's own
  // customer_notifications table, which uses CASCADE.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_portal_notifications (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT,
      action_type VARCHAR(50),
      action_id INTEGER,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      read_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_portal_notifications_customer_id ON customer_portal_notifications(customer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customer_portal_notifications_unread ON customer_portal_notifications(customer_id, is_read) WHERE is_read = FALSE;`);

  // ============================================================
  // Phase 5 — Complaints. Approved via
  // Phase5_Complaints_Implementation_Spec.md §3, all 9+2 Decisions
  // approved. Fully additive — own new tables only, zero touch to any
  // Module 1-9 table or the Customer Portal's existing schema.
  // ============================================================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS complaints (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'resolved', 'closed')),
      priority VARCHAR(10) NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('low', 'medium', 'high')),
      assigned_to INTEGER REFERENCES employees(id) ON DELETE SET NULL,
      admin_reply TEXT,
      replied_at TIMESTAMP,
      source VARCHAR(10) NOT NULL DEFAULT 'customer' CHECK (source IN ('customer', 'staff')),
      created_by INTEGER,
      resolved_at TIMESTAMP,
      closed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_complaints_customer_id ON complaints(customer_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_complaints_assigned_to ON complaints(assigned_to);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS complaint_attachments (
      id SERIAL PRIMARY KEY,
      complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE RESTRICT,
      original_filename VARCHAR(255) NOT NULL,
      storage_path VARCHAR(500) NOT NULL,
      mime_type VARCHAR(100),
      file_size INTEGER,
      uploaded_by_customer BOOLEAN NOT NULL DEFAULT FALSE,
      uploaded_by INTEGER,
      uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_complaint_attachments_complaint_id ON complaint_attachments(complaint_id);`);

  // ============================================================
  // User & Access Administration — Implementation Spec §4/§18,
  // Preconditions §1/§2/§3. V2 begins owning staff identity (OD-1 Hybrid),
  // while `employees.user_id` (Module 3, closed) keeps its existing
  // meaning unchanged — this table's `id` column is deliberately NOT
  // SERIAL: it is seeded to match legacy `users.id` values verbatim
  // (including gaps) by scripts/migrate_users.js, so every existing
  // employees.user_id value keeps resolving correctly with zero change
  // to Module 3 or to any of the 12 resolveUserZoneId() consumer files.
  // A separate sequence (below) is advanced past the migrated range so
  // NEW V2-native users never collide with a migrated legacy id.
  // ============================================================
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS v2_users_id_seq;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS v2_users (
      id INTEGER PRIMARY KEY DEFAULT nextval('v2_users_id_seq'),
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(100),
      role VARCHAR(30) NOT NULL,
      zone VARCHAR(100),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      -- OD-2/Preconditions §2: migration/cohort ROUTING metadata only —
      -- never consulted for authorization decisions (role/zone/scope are
      -- always resolved live from this row + the linked employee, per
      -- lib/accessResolution.js). 'legacy' = this account still logs in
      -- via the reference backend; 'v2' = this account has been cut over.
      auth_source VARCHAR(10) NOT NULL DEFAULT 'legacy' CHECK (auth_source IN ('legacy', 'v2')),
      -- OD-3: reused from the Customer Portal's own proven token_version
      -- precedent, with ONE deliberate difference: default 0, not 1. The
      -- Portal never has a "versionless" token (it always mints its own),
      -- but a legacy-issued staff JWT predates this column entirely and
      -- carries no tokenVersion claim at all — middleware/auth.js reads a
      -- missing claim as 0 (decoded.tokenVersion ?? 0), so the stored
      -- baseline must also start at 0 for every pre-existing legacy token
      -- to keep verifying correctly right up until an explicit
      -- revocation event bumps it. Found and fixed live this pass (a
      -- default of 1 broke every already-issued legacy token instantly).
      token_version INTEGER NOT NULL DEFAULT 0,
      -- Preconditions §9 (Login Security): direct reuse of the Customer
      -- Portal's own lockout shape — closes the Discovery-found gap
      -- (legacy login has no per-account lockout, IP rate-limiting only).
      failed_login_count INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMP,
      last_login_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_v2_users_role ON v2_users(role);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_v2_users_auth_source ON v2_users(auth_source);`);
  // Idempotent fix for the token_version default (found live this same
  // implementation pass, before any real migration ran against it) —
  // CREATE TABLE IF NOT EXISTS above won't retroactively change a
  // default on an already-existing table, so this ALTER is required on
  // every boot to guarantee new rows inserted without an explicit value
  // (e.g. a future manual INSERT) get the correct 0 baseline.
  await pool.query(`ALTER TABLE v2_users ALTER COLUMN token_version SET DEFAULT 0;`);

  // Password reset — same shape as customer_portal_password_resets
  // (token-hash lookup, single-use via used_at, TTL via expires_at), per
  // Implementation Spec §16 (POST /api/v2/auth/password/reset/*).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS v2_password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES v2_users(id) ON DELETE CASCADE,
      token_hash VARCHAR(255) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used_at TIMESTAMP,
      requested_ip VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_v2_password_resets_token_hash ON v2_password_resets(token_hash);`);

  // ============================================================
  // Group & Group-Based Collection — Change Request. Approved via
  // GURMAD_V2_Group_and_Group_Based_Collection_Change_Request_Implementation_Specification.md
  // §14 (Database Design) + Decision Lock update (§26-1/§26-2/§26-5).
  // Hierarchy: Zone -> Group -> Route -> Customer (master data).
  // Fully additive: 2 new tables (groups, routes) + 4 nullable columns on
  // the closed customers/batches tables. Zero change to any existing
  // column, constraint, or row. No Group.collector_id (Locked Decision #3
  // — no permanent Group->Collector relationship; collector assignment
  // stays entirely on the existing task_resources chain, unmodified).
  // ============================================================

  // groups.code is unique WITHIN its zone (not globally) — the
  // specification's own recommended, non-locked scoping (§26, item 4
  // remains a non-blocking, unresolved implementation-level item; this is
  // the only reasonable default and does not foreclose a future change).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      id SERIAL PRIMARY KEY,
      zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE RESTRICT,
      code VARCHAR(30) NOT NULL,
      name VARCHAR(100),
      status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (zone_id, code)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_groups_zone_id ON groups(zone_id);`);

  // routes.code is unique WITHIN its group. Structural entity only — no
  // geometry/coordinate/geofence columns (advanced GIS/route optimization
  // is explicitly OUT OF SCOPE, Locked Decision #10).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS routes (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
      code VARCHAR(30) NOT NULL,
      name VARCHAR(100),
      status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (group_id, code)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_routes_group_id ON routes(group_id);`);

  // customers.group_id/route_id — LOCKED §26-1: initially and indefinitely
  // NULLABLE. No default/fake Group or Route is ever assigned here or
  // anywhere else — every existing customer keeps group_id/route_id = NULL
  // after this migration runs, with zero effect on any existing row's
  // readability or behavior.
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS route_id INTEGER REFERENCES routes(id) ON DELETE SET NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_group_id ON customers(group_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_route_id ON customers(route_id);`);

  // batches.group_id/route_id — the historical-integrity snapshot (Spec
  // §5, non-negotiable). Captured ONCE at batch-creation time by
  // routes/batches.js; NO route ever updates these columns after insert —
  // this mirrors batches.zone_id's own existing, proven write-once
  // behavior exactly. A later customer Group/Route move (§7/§26-2) can
  // never rewrite a batches row, by construction: nothing reads or writes
  // batches.group_id via a live join to customers.group_id.
  await pool.query(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL;`);
  await pool.query(`ALTER TABLE batches ADD COLUMN IF NOT EXISTS route_id INTEGER REFERENCES routes(id) ON DELETE SET NULL;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_batches_group_id ON batches(group_id);`);

  // ============================================================
  // Audit & Security Center. Approved via
  // GURMAD_V2_Audit_and_Security_Center_Implementation_Specification.md
  // §18 (index decision, explicitly approved by the owner). This is the
  // ONLY schema change in this entire CR — no new table, no new column,
  // no new writer. v2_audit_log itself (Module: User & Access
  // Administration migration block, above) is untouched. Justified
  // because ORDER BY created_at DESC is the default sort for every query
  // the new /api/v2/audit endpoints run — not a speculative index.
  // Rollback: DROP INDEX IF EXISTS idx_v2_audit_log_created_at (safe,
  // carries no data of its own).
  // ============================================================
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_v2_audit_log_created_at ON v2_audit_log(created_at DESC);`);

  // ============================================================
  // System Settings — Phase 1 (Company Settings). Approved via
  // GURMAD_V2_System_Settings_Implementation_Specification.md.
  // Typed, domain-specific table (NOT a generic key/value store) —
  // mirrors the exchange_rates precedent. Single-row convention (id=1,
  // enforced at the application layer in routes/settings.js, never here).
  // No seed INSERT — no fake company information is ever created; the row
  // is created only by an Admin's own first successful PUT (Spec §14).
  // No FK to any other table, by design — this table structurally cannot
  // alter any invoice/payment/debt/cashout/collection/audit record.
  // ============================================================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS company_settings (
      id SERIAL PRIMARY KEY,
      company_name VARCHAR(150),
      logo_storage_path VARCHAR(500),
      logo_original_filename VARCHAR(255),
      logo_mime_type VARCHAR(100),
      address TEXT,
      phone VARCHAR(20),
      email VARCHAR(150),
      timezone VARCHAR(50),
      updated_by INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ============================================================
  // Staff Notifications — Implementation Spec §9. Additive, own new
  // table only, zero touch to any existing table. Deliberately NOT a
  // copy of customer_portal_notifications (Decisions §12): recipient is
  // v2_users, not customers — a structurally different identity. No FK
  // to v2_audit_log (Decisions §17) — event_type reuses the same string
  // vocabulary as the source audit action, but this table carries no
  // link into the audit table itself. ON DELETE CASCADE on recipient_id
  // (a deliberate, small deviation from the Portal precedent's own
  // ON DELETE RESTRICT): notifications are explicitly operational, not
  // audit, records (Decisions §7) — if a v2_users row is ever hard-
  // deleted, its own notifications have no remaining purpose.
  // ============================================================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS v2_staff_notifications (
      id SERIAL PRIMARY KEY,
      recipient_id INTEGER NOT NULL REFERENCES v2_users(id) ON DELETE CASCADE,
      event_type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT,
      entity_type VARCHAR(50),
      entity_id INTEGER,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      read_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Exactly the 2 approved indexes (Implementation Spec §9/§19) — mirrors
  // the Customer Portal's own already-proven partial-index pattern for
  // the unread-count query.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_v2_staff_notifications_recipient_unread
      ON v2_staff_notifications(recipient_id, is_read) WHERE is_read = FALSE;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_v2_staff_notifications_recipient_created
      ON v2_staff_notifications(recipient_id, created_at DESC);
  `);

  // ============================================================
  // Master Functional Completion Program — Phase 1: HR & Payroll.
  // Per GURMAD_V2_Phase1_HR_Payroll_Implementation_Specification.md.
  // Fully additive — 7 new tables, zero changes to employees or any
  // other CLOSED/FROZEN table/constraint.
  // ============================================================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leave_types (
      id SERIAL PRIMARY KEY,
      code VARCHAR(30) UNIQUE NOT NULL,
      label VARCHAR(100) NOT NULL,
      is_paid BOOLEAN NOT NULL DEFAULT TRUE,
      status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`
    INSERT INTO leave_types (code, label, is_paid) VALUES
      ('annual', 'Annual', TRUE),
      ('sick', 'Sick', TRUE),
      ('unpaid', 'Unpaid', FALSE),
      ('emergency', 'Emergency', TRUE)
    ON CONFLICT (code) DO NOTHING;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      attendance_date DATE NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent', 'late', 'on_leave', 'half_day')),
      clock_in TIMESTAMP,
      clock_out TIMESTAMP,
      notes TEXT,
      corrected_from_id INTEGER REFERENCES attendance_records(id) ON DELETE SET NULL,
      correction_reason TEXT,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Exactly one *original* (non-correction) record per employee per day —
  // Spec §1.2. Correction rows (corrected_from_id NOT NULL) are exempt.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_one_active_per_day
      ON attendance_records(employee_id, attendance_date) WHERE corrected_from_id IS NULL;
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_employee_date ON attendance_records(employee_id, attendance_date);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_records(attendance_date);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS leave_requests (
      id SERIAL PRIMARY KEY,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE RESTRICT,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL CHECK (end_date >= start_date),
      reason TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
      approved_by INTEGER,
      approved_at TIMESTAMP,
      cancelled_by INTEGER,
      cancelled_at TIMESTAMP,
      cancellation_reason TEXT,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_leave_requests_employee_status ON leave_requests(employee_id, status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_leave_requests_dates ON leave_requests(start_date, end_date);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll_periods (
      id SERIAL PRIMARY KEY,
      label VARCHAR(50) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL CHECK (end_date >= start_date),
      status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'finalized', 'paid')),
      finalized_by INTEGER,
      finalized_at TIMESTAMP,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payroll_periods_status ON payroll_periods(status);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payroll_periods_dates ON payroll_periods(start_date, end_date);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll_records (
      id SERIAL PRIMARY KEY,
      payroll_period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
      employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
      salary_snapshot NUMERIC(12,2) NOT NULL,
      zone_snapshot_id INTEGER,
      earnings_total NUMERIC(12,2) NOT NULL DEFAULT 0,
      deductions_total NUMERIC(12,2) NOT NULL DEFAULT 0,
      net_salary NUMERIC(12,2) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'processing', 'finalized', 'paid', 'reversed')),
      reversed_from_id INTEGER REFERENCES payroll_records(id) ON DELETE SET NULL,
      finalized_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Duplicate-payroll prevention (Spec §8), as a PARTIAL unique index
  // rather than a plain table constraint: a reversal (Spec §13) leaves
  // the original row in place with status='reversed' and inserts a new
  // 'open' replacement for the same period/employee — a plain
  // UNIQUE(payroll_period_id, employee_id) would make that insert
  // impossible. Excluding 'reversed' rows preserves "at most one active
  // payroll record per employee per period" while still permitting
  // exactly the reversal replacement the Specification requires.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_records_one_active_per_period
      ON payroll_records(payroll_period_id, employee_id) WHERE status != 'reversed';
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payroll_records_period ON payroll_records(payroll_period_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payroll_records_employee ON payroll_records(employee_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payroll_records_status ON payroll_records(status);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll_items (
      id SERIAL PRIMARY KEY,
      payroll_record_id INTEGER NOT NULL REFERENCES payroll_records(id) ON DELETE RESTRICT,
      item_type VARCHAR(20) NOT NULL CHECK (item_type IN ('earning', 'deduction')),
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      description VARCHAR(255) NOT NULL,
      source_type VARCHAR(30) CHECK (source_type IS NULL OR source_type IN ('cashout_shortage', 'manual')),
      source_id INTEGER,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payroll_items_record ON payroll_items(payroll_record_id);`);
  // A given cashout_shortages row may back at most one payroll deduction
  // line, company-wide — Spec §1.6, no automatic linkage, duplicate
  // protection only. No literal FK to cashout_shortages (Spec §1.6.1):
  // Cashout (CLOSED Module 7) is validated at the application layer, not
  // depended on at the schema level.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_items_shortage_source
      ON payroll_items(source_type, source_id) WHERE source_type = 'cashout_shortage';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll_settlements (
      id SERIAL PRIMARY KEY,
      payroll_record_id INTEGER NOT NULL UNIQUE REFERENCES payroll_records(id) ON DELETE RESTRICT,
      method VARCHAR(20) NOT NULL CHECK (method IN ('cash', 'mobile_money')),
      provider VARCHAR(30),
      reference VARCHAR(100),
      amount NUMERIC(12,2) NOT NULL,
      settled_by INTEGER NOT NULL,
      settled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ============================================================
  // Master Functional Completion Program — Phase 2: Fleet Management.
  // Per GURMAD_V2_Phase2_Fleet_Implementation_Specification.md.
  // Fully additive — 2 new tables, zero changes to trucks or any other
  // CLOSED/FROZEN table/constraint. Create-only (no UPDATE/DELETE route
  // anywhere touches these) — a correction is a new row.
  // ============================================================
  await pool.query(`
    CREATE TABLE IF NOT EXISTS truck_maintenance_records (
      id SERIAL PRIMARY KEY,
      truck_id INTEGER NOT NULL REFERENCES trucks(id) ON DELETE RESTRICT,
      description TEXT NOT NULL,
      cost NUMERIC(12,2) NOT NULL CHECK (cost > 0),
      next_service_date DATE,
      provider VARCHAR(255),
      zone_snapshot_id INTEGER,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_truck_maintenance_truck ON truck_maintenance_records(truck_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_truck_maintenance_zone_snapshot ON truck_maintenance_records(zone_snapshot_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_truck_maintenance_next_service ON truck_maintenance_records(next_service_date);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS truck_fuel_records (
      id SERIAL PRIMARY KEY,
      truck_id INTEGER NOT NULL REFERENCES trucks(id) ON DELETE RESTRICT,
      liters NUMERIC(10,2) NOT NULL CHECK (liters > 0),
      cost NUMERIC(12,2) NOT NULL CHECK (cost > 0),
      odometer_reading INTEGER CHECK (odometer_reading IS NULL OR odometer_reading >= 0),
      record_date DATE NOT NULL DEFAULT CURRENT_DATE,
      notes TEXT,
      zone_snapshot_id INTEGER,
      created_by INTEGER NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // (truck_id, created_at) — the exact ordering the odometer-anomaly
  // comparison (Spec §5) uses to find the most recent prior reading.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_truck_fuel_truck_created ON truck_fuel_records(truck_id, created_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_truck_fuel_zone_snapshot ON truck_fuel_records(zone_snapshot_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_truck_fuel_record_date ON truck_fuel_records(record_date);`);
}

async function logPortalAudit({ portalAccountId = null, customerId = null, action, ipAddress = null, details = null }) {
  await pool.query(
    `INSERT INTO customer_portal_audit_log (portal_account_id, customer_id, action, ip_address, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [portalAccountId, customerId, action, ipAddress, details ? JSON.stringify(details) : null]
  );
}

async function logAudit({ actorId, actorUsername, action, entityType, entityId, before, after }) {
  await pool.query(
    `INSERT INTO v2_audit_log (actor_id, actor_username, action, entity_type, entity_id, before_data, after_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actorId, actorUsername, action, entityType, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}

module.exports = { pool, runMigrations, logAudit, logPortalAudit };
