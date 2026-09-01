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

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
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
}

async function logAudit({ actorId, actorUsername, action, entityType, entityId, before, after }) {
  await pool.query(
    `INSERT INTO v2_audit_log (actor_id, actor_username, action, entity_type, entity_id, before_data, after_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actorId, actorUsername, action, entityType, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}

module.exports = { pool, runMigrations, logAudit };
