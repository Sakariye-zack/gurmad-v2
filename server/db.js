const { Pool } = require('pg');

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
}

async function logAudit({ actorId, actorUsername, action, entityType, entityId, before, after }) {
  await pool.query(
    `INSERT INTO v2_audit_log (actor_id, actor_username, action, entity_type, entity_id, before_data, after_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actorId, actorUsername, action, entityType, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}

module.exports = { pool, runMigrations, logAudit };
