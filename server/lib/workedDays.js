// Service days of a monthly invoice: the days the customer was actually serviced in the
// billing month, grouped in four fixed weeks (1-7, 8-14, 15-21, 22-end).
// batch_customers.status_at is a naive UTC timestamp: converted to company-local time first.
const { pool } = require('../db');

function daysInMonth(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

async function getWorkedDays(customerId, period, tz, client = pool) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(period || ''))) return null;
  if (!tz) tz = await require('./autoBilling').getTimezone();
  const r = await client.query(
    `SELECT DISTINCT to_char((status_at AT TIME ZONE 'UTC' AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS d
       FROM batch_customers
      WHERE customer_id = $1 AND status = 'serviced' AND status_at IS NOT NULL
        AND to_char((status_at AT TIME ZONE 'UTC' AT TIME ZONE $3), 'YYYY-MM') = $2
      ORDER BY d`, [customerId, period, tz]);
  const last = daysInMonth(period);
  const weeks = [[1, 7], [8, 14], [15, 21], [22, last]];
  return weeks.map(([from, to], i) => ({
    week: i + 1,
    range: `${from}–${to}`,
    dates: r.rows.map((x) => x.d).filter((d) => { const day = Number(d.slice(8, 10)); return day >= from && day <= to; }),
  }));
}

module.exports = { getWorkedDays };
