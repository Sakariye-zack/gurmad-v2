const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, createInvoice } = require('./helpers');

let seq = 0;
async function mkCustomer(w, extra = {}) {
  seq += 1;
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: {
    customer_type: 'residential', name: 'AutoBill ' + seq + ' ' + Date.now(), phone: '06377' + String(seq).padStart(5, '0'),
    zone_id: w.zoneA.id, door_number: String(91000 + seq), ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}
const runBilling = (w, body, token) => api('POST', '/invoices/auto-billing/run', { token: token || w.tokens.admin, body });
const invoicesOf = async (customerId) => (await db.query('SELECT * FROM invoices WHERE customer_id = $1 ORDER BY id', [customerId])).rows;

test('monthly: one invoice per active monthly customer, in its own currency; second run creates 0', async () => {
  const w = await setupWorld();
  const usd = await mkCustomer(w, { billing_type: 'monthly', fee: 12, fee_currency: 'USD' });
  const slsh = await mkCustomer(w, { billing_type: 'monthly', fee: 30000, fee_currency: 'SLSH' });
  const r = await runBilling(w, { kind: 'monthly', period: '2031-03' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.data.created >= 2);
  const a = await invoicesOf(usd.id);
  const b = await invoicesOf(slsh.id);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.equal(a[0].currency, 'USD'); assert.equal(Number(a[0].invoice_total), 12);
  assert.equal(b[0].currency, 'SLSH'); assert.equal(Number(b[0].invoice_total), 30000);
  assert.equal(a[0].auto_generated, true);
  assert.equal(a[0].billing_period, '2031-03');
  assert.equal(a[0].zone_name_snapshot, w.zoneA.name);
  assert.ok(a[0].customer_number_snapshot);
  const again = await runBilling(w, { kind: 'monthly', period: '2031-03' });
  assert.equal(again.status, 200);
  assert.equal(again.data.created, 0);
  assert.equal((await invoicesOf(usd.id)).length, 1);
  // a different month bills again
  await runBilling(w, { kind: 'monthly', period: '2031-04' });
  assert.equal((await invoicesOf(usd.id)).length, 2);
});

test('monthly: customer without a fee is skipped and listed; legacy NULL billing_type is not billed', async () => {
  const w = await setupWorld();
  const nofee = await mkCustomer(w, { billing_type: 'monthly' });
  await db.query('UPDATE customers SET fee = NULL WHERE id = $1', [nofee.id]);
  const legacy = await mkCustomer(w, { billing_type: 'monthly', fee: 9 });
  await db.query('UPDATE customers SET billing_type = NULL WHERE id = $1', [legacy.id]);
  const r = await runBilling(w, { kind: 'monthly', period: '2031-05' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await invoicesOf(nofee.id)).length, 0);
  assert.equal((await invoicesOf(legacy.id)).length, 0);
  const hit = r.data.skipped.find((s) => s.customer_id === nofee.id);
  assert.ok(hit, JSON.stringify(r.data.skipped));
  assert.ok(hit.reason && hit.customer_number && hit.name);
  assert.ok(!r.data.skipped.find((s) => s.customer_id === legacy.id));
  const st = await api('GET', '/invoices/auto-billing/status', { token: w.tokens.admin });
  assert.equal(st.status, 200);
  assert.ok(Array.isArray(st.data.runs) && st.data.runs.length > 0);
});

test('monthly: suspended and archived customers are not billed', async () => {
  const w = await setupWorld();
  const s = await mkCustomer(w, { billing_type: 'monthly', fee: 5 });
  const a = await mkCustomer(w, { billing_type: 'monthly', fee: 5 });
  await db.query(`UPDATE customers SET status = 'suspended' WHERE id = $1`, [s.id]);
  await db.query(`UPDATE customers SET status = 'archived' WHERE id = $1`, [a.id]);
  const r = await runBilling(w, { kind: 'monthly', period: '2031-06' });
  assert.equal(r.status, 200);
  assert.equal((await invoicesOf(s.id)).length, 0);
  assert.equal((await invoicesOf(a.id)).length, 0);
});

test('daily: one invoice per serviced visit that day, idempotent, others untouched', async () => {
  const w = await setupWorld();
  const shop = (n, extra) => mkCustomer(w, { customer_type: 'commercial', business_name: 'Shop' + n, commercial_shift: 'day', billing_type: 'daily', ...extra });
  const d1 = await shop(1, { fee: 2, fee_currency: 'USD' });
  const d2 = await shop(2, { fee: 4000, fee_currency: 'SLSH' });
  const d3 = await shop(3, { fee: 3 });
  const cyc = (await db.query(`INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date) VALUES ($1,'custom','2031-07-01','2031-07-31') RETURNING id`, [w.zoneA.id])).rows[0].id;
  const batch = (await db.query(
    `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, customer_type, commercial_shift, start_date) VALUES ($1,$2,$3,1,'commercial','day','2031-07-10') RETURNING id`,
    ['AB-' + Date.now(), w.zoneA.id, cyc])).rows[0].id;
  const bc = async (cust, status, at) => (await db.query(
    `INSERT INTO batch_customers (batch_id, customer_id, status, status_at) VALUES ($1,$2,$3,$4) RETURNING id`, [batch, cust.id, status, at])).rows[0].id;
  const bc1 = await bc(d1, 'serviced', '2031-07-10 09:00:00');
  await bc(d2, 'serviced', '2031-07-10 10:00:00');
  await bc(d3, 'missed', '2031-07-10 11:00:00');
  const r = await runBilling(w, { kind: 'daily', date: '2031-07-10' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.data.created, 2);
  const i1 = await invoicesOf(d1.id);
  assert.equal(i1.length, 1);
  assert.equal(i1[0].batch_customer_id, bc1);
  assert.equal(i1[0].currency, 'USD'); assert.equal(Number(i1[0].invoice_total), 2);
  assert.equal(i1[0].auto_generated, true);
  assert.equal(i1[0].billing_period, null);
  const i2 = await invoicesOf(d2.id);
  assert.equal(i2[0].currency, 'SLSH'); assert.equal(Number(i2[0].invoice_total), 4000);
  assert.equal((await invoicesOf(d3.id)).length, 0);
  const again = await runBilling(w, { kind: 'daily', date: '2031-07-10' });
  assert.equal(again.data.created, 0);
  assert.equal((await invoicesOf(d1.id)).length, 1);
  const other = await runBilling(w, { kind: 'daily', date: '2031-07-11' });
  assert.equal(other.data.created, 0);
});

test('auto-billing: non-admin run is 403, bad body is 400, status readable by gudoomiye', async () => {
  const w = await setupWorld();
  for (const t of [w.tokens.cashier, w.tokens.gudoomiye, w.tokens.accountant]) {
    const r = await runBilling(w, { kind: 'monthly' }, t);
    assert.equal(r.status, 403);
  }
  assert.equal((await runBilling(w, { kind: 'weekly' })).status, 400);
  assert.equal((await runBilling(w, { kind: 'monthly', period: '2031-13' })).status, 400);
  assert.equal((await runBilling(w, { kind: 'daily', date: 'nope' })).status, 400);
  assert.equal((await api('GET', '/invoices/auto-billing/status', { token: w.tokens.gudoomiye })).status, 200);
  assert.equal((await api('GET', '/invoices/auto-billing/status', { token: w.tokens.cashier })).status, 403);
});

test('daily: visit at 22:30 UTC is a next-day local (UTC+3) visit', async () => {
  const w = await setupWorld();
  const c = await mkCustomer(w, { customer_type: 'commercial', business_name: 'TzShop', commercial_shift: 'day', billing_type: 'daily', fee: 2 });
  const cyc = (await db.query(`INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date) VALUES ($1,'custom','2031-11-01','2031-11-30') RETURNING id`, [w.zoneA.id])).rows[0].id;
  const batch = (await db.query(
    `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, customer_type, commercial_shift, start_date) VALUES ($1,$2,$3,1,'commercial','day','2031-11-09') RETURNING id`,
    ['ABTZ-' + Date.now(), w.zoneA.id, cyc])).rows[0].id;
  await db.query(`INSERT INTO batch_customers (batch_id, customer_id, status, status_at) VALUES ($1,$2,'serviced','2031-11-09 22:30:00')`, [batch, c.id]);
  const nov9 = await runBilling(w, { kind: 'daily', date: '2031-11-09' });
  assert.equal(nov9.status, 200);
  assert.equal((await invoicesOf(c.id)).length, 0);
  const nov10 = await runBilling(w, { kind: 'daily', date: '2031-11-10' });
  assert.equal(nov10.data.created, 1);
  assert.equal((await invoicesOf(c.id)).length, 1);
});

test('monthly: customer with a manual invoice in that local month is skipped as already_invoiced', async () => {
  const w = await setupWorld();
  const c = await mkCustomer(w, { billing_type: 'monthly', fee: 15 });
  const manual = await api('POST', '/invoices', { token: w.tokens.admin, body: { customer_id: c.id, invoice_total: 15 } });
  assert.equal(manual.status, 201);
  const period = '2031-08';
  await db.query(`UPDATE invoices SET created_at = '2031-08-15 10:00:00' WHERE id = $1`, [manual.data.id]);
  const r = await runBilling(w, { kind: 'monthly', period });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await invoicesOf(c.id)).length, 1);
  const hit = r.data.skipped.find((s) => s.customer_id === c.id);
  assert.equal(hit && hit.reason, 'already_invoiced');
  // a voided manual invoice does not block billing
  await api('PUT', '/invoices/' + manual.data.id + '/void', { token: w.tokens.admin, body: { reason: 'test' } });
  const r2 = await runBilling(w, { kind: 'monthly', period });
  assert.ok(r2.data.created >= 1);
  assert.equal((await invoicesOf(c.id)).length, 2);
});

test('daily: go-live cutoff excludes earlier visits; same-day manual invoice blocks', async () => {
  const w = await setupWorld();
  const prev = (await db.query('SELECT daily_start_date FROM billing_settings WHERE id = 1')).rows[0];
  const shop = (n) => mkCustomer(w, { customer_type: 'commercial', business_name: 'Cut' + n, commercial_shift: 'day', billing_type: 'daily', fee: 2 });
  const early = await shop(1); const onDay = await shop(2); const manual = await shop(3);
  const cyc = (await db.query(`INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date) VALUES ($1,'custom','2031-09-01','2031-09-30') RETURNING id`, [w.zoneA.id])).rows[0].id;
  const batch = (await db.query(
    `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, customer_type, commercial_shift, start_date) VALUES ($1,$2,$3,1,'commercial','day','2031-09-09') RETURNING id`,
    ['ABC-' + Date.now(), w.zoneA.id, cyc])).rows[0].id;
  const visit = (c, at) => db.query(`INSERT INTO batch_customers (batch_id, customer_id, status, status_at) VALUES ($1,$2,'serviced',$3)`, [batch, c.id, at]);
  try {
    await db.query(`INSERT INTO billing_settings (id, daily_start_date) VALUES (1, '2031-09-10') ON CONFLICT (id) DO UPDATE SET daily_start_date = '2031-09-10'`);
    await visit(early, '2031-09-09 09:00:00');
    await visit(onDay, '2031-09-10 09:00:00');
    await visit(manual, '2031-09-11 09:00:00');
    const m = await api('POST', '/invoices', { token: w.tokens.admin, body: { customer_id: manual.id, invoice_total: 2 } });
    await db.query(`UPDATE invoices SET created_at = '2031-09-11 08:00:00' WHERE id = $1`, [m.data.id]);
    assert.equal((await runBilling(w, { kind: 'daily', date: '2031-09-09' })).data.created, 0);
    assert.equal((await invoicesOf(early.id)).length, 0);
    assert.equal((await runBilling(w, { kind: 'daily', date: '2031-09-10' })).data.created, 1);
    const r = await runBilling(w, { kind: 'daily', date: '2031-09-11' });
    assert.equal(r.data.created, 0);
    assert.equal((r.data.skipped.find((x) => x.customer_id === manual.id) || {}).reason, 'already_invoiced');
  } finally {
    if (prev) await db.query('UPDATE billing_settings SET daily_start_date = $1 WHERE id = 1', [prev.daily_start_date]);
    else await db.query('DELETE FROM billing_settings WHERE id = 1');
  }
});

// ---- Task 10: service days + dual-currency invoice views ----
async function monthlyWithVisits(w, period, dates, extra = {}) {
  const c = await mkCustomer(w, { billing_type: 'monthly', fee: 12, fee_currency: 'USD', ...extra });
  const cyc = (await db.query(`INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date) VALUES ($1,'custom',$2,$3) RETURNING id`, [w.zoneA.id, period + '-01', period + '-28'])).rows[0].id;
  let n = 0;
  const visit = async (status, at) => {
    n += 1;
    const batch = (await db.query(
      `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, customer_type, start_date) VALUES ($1,$2,$3,$4,'residential',$5) RETURNING id`,
      ['WD-' + Date.now() + '-' + c.id + '-' + n, w.zoneA.id, cyc, n, period + '-01'])).rows[0].id;
    await db.query(`INSERT INTO batch_customers (batch_id, customer_id, status, status_at) VALUES ($1,$2,$3,$4)`, [batch, c.id, status, at]);
  };
  for (const d of dates) await visit('serviced', d);
  await visit('missed', period + '-05 09:00:00'); // a missed visit must not count
  const r = await runBilling(w, { kind: 'monthly', period });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { c, inv: (await invoicesOf(c.id))[0] };
}

test('monthly invoice detail lists worked days by week', async () => {
  const w = await setupWorld();
  // 22:30 UTC on the 7th is the 8th local (UTC+3) => week 2
  const { inv } = await monthlyWithVisits(w, '2032-11', ['2032-11-03 08:00:00', '2032-11-03 09:00:00', '2032-11-07 22:30:00', '2032-11-29 07:00:00']);
  const r = await api('GET', '/invoices/' + inv.id, { token: w.tokens.admin });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.data.billing_period, '2032-11');
  assert.equal(r.data.auto_generated, true);
  const wd = r.data.worked_days;
  assert.equal(wd.length, 4);
  assert.deepEqual(wd.map((x) => x.range), ['1–7', '8–14', '15–21', '22–30']);
  assert.deepEqual(wd[0].dates, ['2032-11-03']);
  assert.deepEqual(wd[1].dates, ['2032-11-08']);
  assert.deepEqual(wd[2].dates, []);
  assert.deepEqual(wd[3].dates, ['2032-11-29']);
});

test('non-monthly invoice has no worked_days', async () => {
  const w = await setupWorld();
  const inv = await createInvoice(w.tokens.admin, w.custA, 5);
  const r = await api('GET', '/invoices/' + inv.id, { token: w.tokens.admin });
  assert.equal(r.status, 200);
  assert.equal(r.data.worked_days, undefined);
});

test('invoice documents contain SERVICE DAYS and the month line; both currencies and rate shown', async () => {
  const w = await setupWorld();
  const { inv } = await monthlyWithVisits(w, '2032-12', ['2032-12-02 08:00:00']);
  const res = await fetch(process.env.TEST_BASE + `/api/v2/invoices/${inv.id}/document.docx`, { headers: { Authorization: 'Bearer ' + w.tokens.admin } });
  assert.equal(res.status, 200);
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /SERVICE DAYS/);
  assert.match(xml, /Waste collection — Dec 2032/);
  assert.match(xml, /2032-12-02|02 Dec/);
  assert.match(xml, /Exchange rate/);
  assert.match(xml, /SLSH/);
});

test('GET /invoices/:id returns usd/slsh/rate in balance for an SLSH invoice', async () => {
  const w = await setupWorld();
  const c = await mkCustomer(w, { billing_type: 'monthly', fee: 30000, fee_currency: 'SLSH' });
  await runBilling(w, { kind: 'monthly', period: '2033-01' });
  const inv = (await invoicesOf(c.id))[0];
  const r = await api('GET', '/invoices/' + inv.id, { token: w.tokens.admin });
  assert.equal(r.status, 200);
  const b = r.data.balance;
  assert.equal(b.currency, 'SLSH');
  assert.equal(b.slsh.netTotal, 30000);
  assert.ok(b.rate && b.rate.rate > 0);
  assert.ok(Math.abs(b.usd.netTotal - 30000 / b.rate.rate) < 1e-6);
  assert.equal(b.usd.paid, 0);
});
