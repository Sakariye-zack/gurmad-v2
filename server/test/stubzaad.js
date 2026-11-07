// Preload for the TEST server only (see run.js NODE_OPTIONS): replaces the
// WAAFI gateway call for "magic" test phone numbers so the ZAAD flows can be
// exercised without the real gateway. The real gateway is NEVER called from
// the suite (a developer .env may hold live WAAFI credentials): any other
// phone behaves as "credentials not configured". Never used in production.
//   0699 01 xxxx  -> approved immediately
//   0699 02 xxxx  -> declined
//   0699 03 xxxx  -> approved after 1.5 s (concurrency / race tests)
//   0699 04 xxxx  -> transport error (throws)
//   0699 05 xxxx  -> gateway timeout (outcome unknown)
const zaad = require('../lib/zaadService');
let n = 0;
zaad.requestZaadPayment = async (args) => {
  const d = String(args.phone || '').replace(/\D/g, '');
  const m = /^0699(0[1-5])/.exec(d);
  if (!m) return { ok: false, message: 'ZAAD API credentials are not configured on the server.', notConfigured: true };
  const tx = `STUB${Date.now()}${++n}`;
  if (m[1] === '02') return { ok: false, message: 'Payment declined by customer (stub).', raw: { responseCode: '5310' } };
  if (m[1] === '05') return { ok: false, timedOut: true, message: 'timeout (stub)', reference: args.reference };
  if (m[1] === '04') throw new Error('stub transport error');
  if (m[1] === '03') await new Promise((r) => setTimeout(r, 1500));
  return { ok: true, transactionId: tx, raw: { responseCode: '2001', params: { transactionId: tx } } };
};
