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
}

async function logAudit({ actorId, actorUsername, action, entityType, entityId, before, after }) {
  await pool.query(
    `INSERT INTO v2_audit_log (actor_id, actor_username, action, entity_type, entity_id, before_data, after_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actorId, actorUsername, action, entityType, entityId, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]
  );
}

module.exports = { pool, runMigrations, logAudit };
