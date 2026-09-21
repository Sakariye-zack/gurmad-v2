require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool } = require('../db');

const USERNAME = process.argv[2];
const PASSWORD = process.argv[3];

(async () => {
  if (!USERNAME || !PASSWORD) {
    console.error('Usage: node create_prod_admin.js <username> <password>');
    process.exit(1);
  }
  const hash = await bcrypt.hash(PASSWORD, 12);
  const roleRes = await pool.query("SELECT id FROM roles WHERE key='admin'");
  const roleId = roleRes.rows[0].id;
  await pool.query(
    `INSERT INTO v2_users (username, password_hash, full_name, role, role_id, is_active, auth_source)
     VALUES ($1, $2, $3, 'admin', $4, TRUE, 'v2')`,
    [USERNAME, hash, 'System Administrator', roleId]
  );
  console.log('ADMIN_CREATED');
  process.exit(0);
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
