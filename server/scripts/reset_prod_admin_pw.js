require('dotenv').config();
const bcrypt = require('bcrypt');
const { pool } = require('../db');

const USERNAME = process.argv[2];
const PASSWORD = process.argv[3];

(async () => {
  if (!USERNAME || !PASSWORD) {
    console.error('Usage: node reset_prod_admin_pw.js <username> <password>');
    process.exit(1);
  }
  const hash = await bcrypt.hash(PASSWORD, 12);
  const r = await pool.query(
    `UPDATE v2_users SET password_hash = $1, token_version = token_version + 1, updated_at = NOW() WHERE username = $2 RETURNING id`,
    [hash, USERNAME]
  );
  if (r.rows.length === 0) { console.error('NO_SUCH_USER'); process.exit(1); }
  console.log('PASSWORD_RESET');
  process.exit(0);
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });
