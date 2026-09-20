const express = require('express');
const { pool } = require('../db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Global Search — Phase 10, user-requested ('waxaad iigu soo dartaa
// search bar oo waliba global search ah'). New, additive, read-only
// module — no route below writes anything, and every WHERE clause here
// mirrors an already-approved visibility rule from the CLOSED route file
// for that entity (customers.js / invoices.js / employees.js) rather
// than inventing a new one. A role never sees a category here it
// couldn't already reach through that entity's own list page.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant'];
// Matches invoices.js's own VIEW_ROLES exactly.
const INVOICE_VIEW_ROLES = ['admin', 'cashier', 'gudoomiye', 'zone_accountant'];
// Matches employees.js's own VIEW_ROLES exactly.
const EMPLOYEE_VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant'];

async function resolveUserZoneId(user) {
  if (!ZONE_SCOPED_ROLES.includes((user.role || '').toLowerCase())) return null;
  if (!user.zone) return null;
  const r = await pool.query('SELECT id FROM zones WHERE name = $1', [user.zone]);
  return r.rows[0]?.id ?? null;
}

// GET /api/v2/search?q=... — up to 5 results per category, minimized
// fields only (no financial/HR-sensitive columns beyond what the
// category's own listing page already shows at a glance).
router.get('/', authenticateToken, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ data: { customers: [], invoices: [], employees: [] } });

  try {
    const role = (req.user.role || '').toLowerCase();
    const myZoneId = await resolveUserZoneId(req.user);
    const like = `%${q}%`;
    const results = { customers: [], invoices: [], employees: [] };

    // Customers — every staff role can already browse the full list
    // (customers.js has no VIEW_ROLES gate), zone-scoped the same way.
    {
      const params = [like];
      let where = `(c.name ILIKE $1 OR c.business_name ILIKE $1 OR c.phone ILIKE $1 OR c.customer_number ILIKE $1)`;
      if (myZoneId !== null) { params.push(myZoneId); where += ` AND c.zone_id = $${params.length}`; }
      const r = await pool.query(
        `SELECT c.id, c.customer_number, c.name, c.business_name, c.phone, z.name AS zone_name
         FROM customers c LEFT JOIN zones z ON z.id = c.zone_id
         WHERE ${where} ORDER BY c.name LIMIT 5`,
        params
      );
      results.customers = r.rows;
    }

    // Invoices — same role gate as invoices.js's own GET /.
    if (INVOICE_VIEW_ROLES.includes(role)) {
      const params = [like];
      let where = `(i.invoice_number ILIKE $1 OR c.name ILIKE $1 OR c.customer_number ILIKE $1)`;
      if (myZoneId !== null) { params.push(myZoneId); where += ` AND c.zone_id = $${params.length}`; }
      const r = await pool.query(
        `SELECT i.id, i.invoice_number, i.status, i.invoice_total, c.name AS customer_name, c.customer_number
         FROM invoices i JOIN customers c ON c.id = i.customer_id
         WHERE ${where} ORDER BY i.created_at DESC LIMIT 5`,
        params
      );
      results.invoices = r.rows;
    }

    // Employees — same role gate as employees.js's own GET /.
    if (EMPLOYEE_VIEW_ROLES.includes(role)) {
      const params = [like];
      let where = `(e.name ILIKE $1 OR e.phone ILIKE $1 OR e.job_role ILIKE $1)`;
      if (myZoneId !== null) { params.push(myZoneId); where += ` AND (e.zone_id = $${params.length} OR e.zone_id IS NULL)`; }
      const r = await pool.query(
        `SELECT e.id, e.name, e.employee_type, e.job_role, z.name AS zone_name
         FROM employees e LEFT JOIN zones z ON z.id = e.zone_id
         WHERE ${where} ORDER BY e.name LIMIT 5`,
        params
      );
      results.employees = r.rows;
    }

    res.json({ data: results });
  } catch (err) {
    res.status(500).json({ error: { message: 'Search failed.', code: 'INTERNAL' } });
  }
});

module.exports = router;
