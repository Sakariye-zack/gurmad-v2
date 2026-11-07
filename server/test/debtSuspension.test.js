const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, db, setupWorld, createInvoice } = require('./helpers');
const ds = require('../lib/debtSuspension');
const { runMonthly, runDaily } = require('../lib/autoBilling');

// F3 — Debt suspension: candidates, approve/dismiss role gates, list
// removal, auto-billing exclusion, auto-reactivation after payment.
let seq = 0;
const uniq = () => `${Date.now().toString().slice(-5)}${++seq}`;

async function mkCustomer(w, extra = {}) {
  const n = uniq();
  const r = await api('POST', '/customers', { token: w.tokens.admin, body: {
    customer_type: 'residential', name: 'DebtSusp ' + n, phone: '0643' + n.slice(-6).padStart(6, '0'),
    zone_id: (extra.zone || w.zoneA).id, door_number: '8' + n, fee: 5, billing_type: 'monthly' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.data;
}
async function invoice(w, c, total, { daysAgo = 0, currency = 'USD' } = {}) {
  const inv = currency === 'USD'
    ? await createInvoice(w.tokens.admin, c, total)
    : (await api('POST', '/invoices', { token: w.tokens.admin, body: { customer_id: c.id, invoice_total: total, currency } })).data;
  assert.ok(inv && inv.id, 'invoice created');
  if (daysAgo) await db.query(`UPDATE invoices SET created_at = NOW() - ($2::int * INTERVAL '1 day') WHERE id = $1`, [inv.id, daysAgo]);
  return inv;
}
const pay = (w, inv, amount, currency = 'USD') => api('POST', '/payments', { token: w.tokens.admin, body: { invoice_id: inv.id, amount, currency, method: 'cash' } });
const candidates = async (token) => {
  const r = await api('GET', '/debt-suspensions/candidates', { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.data;
};
const findC = (list, c) => list.find((x) => x.id === c.id);
const customer = async (id) => (await db.query('SELECT * FROM customers WHERE id = $1', [id])).rows[0];
const setDays = (w, d) => api('PUT', '/settings/company', { token: w.tokens.admin, body: { debt_suspend_days: d } });

async function ensureRate(w) {
  const r = await db.query(`SELECT 1 FROM exchange_rates WHERE effective_from <= NOW() LIMIT 1`);
  if (!r.rows.length) assert.equal((await api('POST', '/exchange-rates', { token: w.tokens.admin, body: { rate: 10000 } })).status, 201);
}

test('candidates: threshold, void and paid invoices ignored, both currencies, outstanding per currency', async () => {
  const w = await setupWorld();
  assert.equal((await setDays(w, 90)).status, 200);
  await ensureRate(w);
  const old = await mkCustomer(w);
  const inv1 = await invoice(w, old, 20, { daysAgo: 100 });
  await pay(w, inv1, 5);
  await invoice(w, old, 7, { daysAgo: 10 }); // recent: counts in outstanding, not in age
  await invoice(w, old, 30000, { daysAgo: 95, currency: 'SLSH' });
  const young = await mkCustomer(w);
  await invoice(w, young, 20, { daysAgo: 30 });
  const voided = await mkCustomer(w);
  const vInv = await invoice(w, voided, 20, { daysAgo: 120 });
  await db.query(`UPDATE invoices SET status = 'voided', voided_at = NOW(), voided_reason = 'test' WHERE id = $1`, [vInv.id]);
  const paid = await mkCustomer(w);
  const pInv = await invoice(w, paid, 20, { daysAgo: 120 });
  assert.equal((await pay(w, pInv, 20)).status, 201);
  const slshOnly = await mkCustomer(w);
  await invoice(w, slshOnly, 50000, { daysAgo: 200, currency: 'SLSH' });

  const list = await candidates(w.tokens.admin);
  const o = findC(list, old);
  assert.ok(o, 'old debtor is a candidate');
  assert.ok(o.days >= 99 && o.days <= 101, String(o.days));
  assert.equal(o.outstanding_usd, 22);
  assert.equal(o.outstanding_slsh, 30000);
  assert.ok(o.oldest_unpaid_date && o.hierarchy.includes(w.zoneA.name));
  assert.ok(!findC(list, young), 'invoice younger than threshold');
  assert.ok(!findC(list, voided), 'void invoice ignored');
  assert.ok(!findC(list, paid), 'paid invoice ignored');
  const s = findC(list, slshOnly);
  assert.ok(s && s.outstanding_slsh === 50000 && s.outstanding_usd === 0);
});

test('setting 0 = no candidates; dismissed customers hidden for 30 days', async () => {
  const w = await setupWorld();
  const c = await mkCustomer(w);
  await invoice(w, c, 10, { daysAgo: 100 });
  assert.equal((await setDays(w, 0)).status, 200);
  assert.equal((await candidates(w.tokens.admin)).length, 0);
  assert.equal((await setDays(w, -1)).status, 400);
  assert.equal((await setDays(w, 90)).status, 200);
  assert.ok(findC(await candidates(w.tokens.admin), c));

  assert.equal((await api('POST', '/debt-suspensions/dismiss', { token: w.tokens.accountant, body: { customer_ids: [c.id] } })).status, 403);
  const d = await api('POST', '/debt-suspensions/dismiss', { token: w.tokens.admin, body: { customer_ids: [c.id] } });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.ok(!findC(await candidates(w.tokens.admin), c), 'dismissed is hidden');
  const left = Number((await db.query('SELECT EXTRACT(EPOCH FROM dismissed_until - NOW()) / 86400 AS d FROM debt_suspension_dismissals WHERE customer_id = $1', [c.id])).rows[0].d);
  assert.ok(left > 29.9 && left <= 30, String(left));
  // Snooze over -> back on the list.
  await db.query(`UPDATE debt_suspension_dismissals SET dismissed_until = NOW() - INTERVAL '1 minute' WHERE customer_id = $1`, [c.id]);
  assert.ok(findC(await candidates(w.tokens.admin), c));
});

test('approve: only admin and gudoomiye; sets status and removes pending auto-list rows today/future', async () => {
  const w = await setupWorld();
  const c = await mkCustomer(w);
  await invoice(w, c, 15, { daysAgo: 100 });
  for (const k of ['accountant', 'head', 'cashier', 'collector']) {
    const r = await api('POST', '/debt-suspensions/approve', { token: w.tokens[k], body: { customer_ids: [c.id] } });
    assert.equal(r.status, 403, k);
    assert.equal((await api('GET', '/debt-suspensions/candidates', { token: w.tokens[k] })).status, 403, k);
  }
  assert.equal((await api('POST', '/debt-suspensions/approve', { token: w.tokens.admin, body: { customer_ids: [] } })).status, 400);

  // Future auto list (pending -> removed), a past unclosed auto list (pending -> removed),
  // a past auto list with a 'missed' row (history, kept), a manual batch (untouched).
  const cyc = (await db.query(`INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date) VALUES ($1,'custom',CURRENT_DATE - 5,CURRENT_DATE + 5) RETURNING id`, [w.zoneA.id])).rows[0].id;
  const mkBatch = async (offset, auto) => (await db.query(
    `INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, start_date, status, auto_generated, total_customers)
     VALUES ($1,$2,$3,$4,CURRENT_DATE + $5::int,'assigned',$6,1) RETURNING id`, ['DS' + uniq(), w.zoneA.id, cyc, 700 + seq, offset, auto])).rows[0].id;
  const todayB = await mkBatch(1, true); // future (avoids timezone edge at midnight)
  const pastB = await mkBatch(-3, true);
  const pastOpenB = await mkBatch(-2, true);
  const manualB = await mkBatch(2, false);
  await db.query(`INSERT INTO batch_customers (batch_id, customer_id, status) VALUES ($1,$2,'pending')`, [todayB, c.id]);
  await db.query(`INSERT INTO batch_customers (batch_id, customer_id, status, status_at) VALUES ($1,$2,'missed', NOW())`, [pastB, c.id]);
  // Only one pending row per customer is allowed at a time: park the future one as 'skipped' while adding the others.
  await db.query(`UPDATE batch_customers SET status = 'skipped' WHERE batch_id = $1 AND customer_id = $2`, [todayB, c.id]);
  await db.query(`INSERT INTO batch_customers (batch_id, customer_id, status) VALUES ($1,$2,'pending')`, [pastOpenB, c.id]);

  let r = await api('POST', '/debt-suspensions/approve', { token: w.tokens.gudoomiye, body: { customer_ids: [c.id] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.data.approved.length, 1);
  assert.equal((await db.query('SELECT 1 FROM batch_customers WHERE batch_id = $1', [pastOpenB])).rows.length, 0, 'past unclosed pending row removed');
  // Same again for a future pending row (reset the customer and re-approve).
  await db.query(`UPDATE customers SET status = 'active', suspended_reason = NULL WHERE id = $1`, [c.id]);
  await db.query(`UPDATE batch_customers SET status = 'pending' WHERE batch_id = $1 AND customer_id = $2`, [todayB, c.id]);
  await db.query(`INSERT INTO batch_customers (batch_id, customer_id, status) VALUES ($1,$2,'serviced')`, [manualB, c.id]);
  r = await api('POST', '/debt-suspensions/approve', { token: w.tokens.gudoomiye, body: { customer_ids: [c.id] } });
  assert.equal(r.data.approved.length, 1, JSON.stringify(r.body));
  assert.equal((await db.query('SELECT 1 FROM batch_customers WHERE batch_id = $1', [manualB])).rows.length, 1, 'manual batch untouched');
  const after = await customer(c.id);
  assert.equal(after.status, 'suspended');
  assert.equal(after.suspended_reason, 'debt');
  assert.ok(after.suspended_at && after.suspended_by);
  assert.equal((await db.query('SELECT 1 FROM batch_customers WHERE batch_id = $1', [todayB])).rows.length, 0);
  assert.equal((await db.query('SELECT total_customers FROM batches WHERE id = $1', [todayB])).rows[0].total_customers, 0);
  assert.equal((await db.query('SELECT 1 FROM batch_customers WHERE batch_id = $1', [pastB])).rows.length, 1);
  const audit = await db.query(`SELECT 1 FROM v2_audit_log WHERE action = 'customer.debt_suspend' AND entity_id = $1`, [c.id]);
  assert.equal(audit.rows.length, 2);
  // Shown on the suspended tab, gone from candidates; second approve is skipped.
  const sus = await api('GET', '/debt-suspensions/suspended', { token: w.tokens.admin });
  assert.ok(sus.data.find((x) => x.id === c.id && x.outstanding_usd === 15));
  assert.ok(!findC(await candidates(w.tokens.admin), c));
  const again = await api('POST', '/debt-suspensions/approve', { token: w.tokens.admin, body: { customer_ids: [c.id] } });
  assert.equal(again.data.skipped[0].reason, 'not_a_candidate');
  const banner = await api('GET', `/debt-suspensions/customer/${c.id}`, { token: w.tokens.cashier });
  assert.equal(banner.status, 200);
  assert.equal(banner.data.outstanding.USD, 15);
});

test('gudoomiye cannot approve a customer outside their district', async () => {
  const w = await setupWorld();
  const b = await mkCustomer(w, { zone: w.zoneB });
  await invoice(w, b, 9, { daysAgo: 100 });
  assert.ok(!findC(await candidates(w.tokens.gudoomiye), b));
  const r = await api('POST', '/debt-suspensions/approve', { token: w.tokens.gudoomiye, body: { customer_ids: [b.id] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.skipped[0].reason, 'forbidden');
  assert.equal((await customer(b.id)).status, 'active');
});

test('auto-billing: monthly skips suspended; daily bills visits before a debt suspension, not after; manual suspension billed as before', async () => {
  const w = await setupWorld();
  const c = await mkCustomer(w);
  await db.query(`UPDATE customers SET status = 'suspended', suspended_reason = 'debt' WHERE id = $1`, [c.id]);
  await runMonthly({ manual: true, period: '2032-01' });
  assert.equal((await db.query(`SELECT 1 FROM invoices WHERE customer_id = $1 AND billing_period = '2032-01'`, [c.id])).rows.length, 0);

  const cyc = (await db.query(`INSERT INTO collection_cycles (zone_id, cycle_type, start_date, end_date) VALUES ($1,'custom','2032-02-01','2032-02-28') RETURNING id`, [w.zoneA.id])).rows[0].id;
  await db.query(`INSERT INTO billing_settings (id, daily_start_date) VALUES (1, '2000-01-01') ON CONFLICT (id) DO NOTHING`);
  const visit = async (cust, day, at) => {
    const b = (await db.query(`INSERT INTO batches (batch_code, zone_id, cycle_id, batch_number, start_date, status) VALUES ($1,$2,$3,1,$4::date,'in_progress') RETURNING id`, ['DSB' + uniq(), w.zoneA.id, cyc, day])).rows[0].id;
    await db.query(`INSERT INTO batch_customers (batch_id, customer_id, status, status_at) VALUES ($1,$2,'serviced',$3::timestamp)`, [b, cust.id, at]);
  };
  const billed = async (cust) => (await db.query(`SELECT 1 FROM invoices WHERE customer_id = $1 AND status <> 'voided'`, [cust.id])).rows.length;
  // Debt-suspended at 2032-02-10 12:00 UTC: the 09:00 visit is billed, a later one is not.
  const before = await mkCustomer(w);
  const after = await mkCustomer(w);
  const manual = await mkCustomer(w);
  for (const x of [before, after]) {
    await db.query(`UPDATE customers SET billing_type = 'daily', fee = 2, status = 'suspended', suspended_reason = 'debt', suspended_at = '2032-02-10 12:00' WHERE id = $1`, [x.id]);
  }
  await db.query(`UPDATE customers SET billing_type = 'daily', fee = 2, status = 'suspended', suspended_reason = 'manual', suspended_at = '2032-02-10 12:00' WHERE id = $1`, [manual.id]);
  await visit(before, '2032-02-10', '2032-02-10 09:00');
  await visit(after, '2032-02-10', '2032-02-10 13:00');
  await visit(manual, '2032-02-10', '2032-02-10 13:00');
  await runDaily({ date: '2032-02-10' });
  assert.equal(await billed(before), 1, 'visit before the suspension is billed');
  assert.equal(await billed(after), 0, 'visit after the debt suspension is not billed');
  assert.equal(await billed(manual), 1, 'manual suspension keeps the original behaviour');
});

test('debt-method payments are not money received: still a candidate, no reactivation', async () => {
  const w = await setupWorld();
  const c = await mkCustomer(w);
  const i = await invoice(w, c, 10, { daysAgo: 100 });
  const p = await api('POST', '/payments', { token: w.tokens.admin, body: { invoice_id: i.id, amount: 10, currency: 'USD', method: 'debt' } });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal(p.data.invoice_status, 'paid');
  const cand = findC(await candidates(w.tokens.admin), c);
  assert.ok(cand && cand.outstanding_usd === 10, 'invoice closed via debt method is still owed');

  const s = await mkCustomer(w);
  const i1 = await invoice(w, s, 8, { daysAgo: 100 });
  assert.equal((await api('POST', '/debt-suspensions/approve', { token: w.tokens.admin, body: { customer_ids: [s.id] } })).status, 200);
  assert.equal((await api('POST', '/payments', { token: w.tokens.admin, body: { invoice_id: i1.id, amount: 8, currency: 'USD', method: 'debt' } })).status, 201);
  assert.equal((await customer(s.id)).status, 'suspended');
  await ds.nightlyCheck();
  assert.equal((await customer(s.id)).status, 'suspended');
});

test('payment that clears the balance reactivates; a partial payment does not; manual suspensions never auto-reactivate', async () => {
  const w = await setupWorld();
  const c = await mkCustomer(w);
  const i1 = await invoice(w, c, 20, { daysAgo: 100 });
  const i2 = await invoice(w, c, 5, { daysAgo: 5 });
  assert.equal((await api('POST', '/debt-suspensions/approve', { token: w.tokens.admin, body: { customer_ids: [c.id] } })).status, 200);
  assert.equal((await customer(c.id)).status, 'suspended');

  assert.equal((await pay(w, i1, 20)).status, 201); // old invoice paid, 5 still owed
  assert.equal((await customer(c.id)).status, 'suspended', 'partial: still owes on another invoice');
  assert.equal((await pay(w, i2, 2)).status, 201);
  assert.equal((await customer(c.id)).status, 'suspended', 'partial payment');
  assert.equal((await pay(w, i2, 3)).status, 201);
  const after = await customer(c.id);
  assert.equal(after.status, 'active');
  assert.equal(after.suspended_reason, null);
  const audit = await db.query(`SELECT actor_username FROM v2_audit_log WHERE action = 'customer.debt_reactivate' AND entity_id = $1`, [c.id]);
  assert.equal(audit.rows[0].actor_username, 'system');

  // Manual suspension (status endpoint) with no debt: never reactivated.
  const m = await mkCustomer(w);
  const st = await api('PUT', `/customers/${m.id}/status`, { token: w.tokens.admin, body: { status: 'suspended' } });
  assert.equal(st.status, 200);
  assert.equal((await customer(m.id)).suspended_reason, 'manual');
  const legacy = await mkCustomer(w);
  await db.query(`UPDATE customers SET status = 'suspended' WHERE id = $1`, [legacy.id]);
  await ds.nightlyCheck();
  assert.equal((await customer(m.id)).status, 'suspended');
  assert.equal((await customer(legacy.id)).status, 'suspended');
  // Manual reactivation clears the fields.
  await api('PUT', `/customers/${m.id}/status`, { token: w.tokens.admin, body: { status: 'active' } });
  assert.equal((await customer(m.id)).suspended_reason, null);
});

test('nightly check reactivates a debt-suspended customer whose invoice was voided', async () => {
  const w = await setupWorld();
  const c = await mkCustomer(w);
  const i = await invoice(w, c, 12, { daysAgo: 100 });
  assert.equal((await api('POST', '/debt-suspensions/approve', { token: w.tokens.admin, body: { customer_ids: [c.id] } })).status, 200);
  // Void through the API: the void route runs the reactivation check itself.
  const v = await api('PUT', `/invoices/${i.id}/void`, { token: w.tokens.admin, body: { reason: 'billed in error' } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal((await customer(c.id)).status, 'active');

  // Voided straight in the DB (no hook): the nightly sweep catches it.
  const d = await mkCustomer(w);
  const j = await invoice(w, d, 12, { daysAgo: 100 });
  assert.equal((await api('POST', '/debt-suspensions/approve', { token: w.tokens.admin, body: { customer_ids: [d.id] } })).status, 200);
  await db.query(`UPDATE invoices SET status = 'voided', voided_at = NOW(), voided_reason = 'test' WHERE id = $1`, [j.id]);
  const r = await api('POST', '/debt-suspensions/check', { token: w.tokens.admin });
  assert.equal(r.status, 200);
  assert.ok(r.data.reactivated.includes(d.id));
  assert.equal((await customer(d.id)).status, 'active');
});
