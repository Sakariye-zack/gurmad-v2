// ZAAD (Telesom mobile money, via the WAAFI/Hormuud payment gateway) —
// Phase 10, user-requested port of a real integration the user already
// ran in production in their previous (pre-V2) system (server/index.js
// there, POST /api/payments/zaad) — reused here essentially verbatim,
// not reinvented, since it was already field-tested against the real
// WAAFI API. Isolated in its own module (no route file talks to WAAFI
// directly) so the HTTP-call/response-shape details live in exactly one
// place.
//
// This is a MERCHANT-INITIATED COLLECT request ("API_PURCHASE"): WAAFI
// pushes a payment confirmation prompt to the customer's own phone for
// the amount given, and this call's HTTP response only returns once the
// customer has approved (or the request has failed/timed out) — it is
// synchronous from this server's point of view, not a webhook/callback
// flow. A returned success therefore means the customer already
// confirmed and WAAFI has moved the funds into the configured merchant
// account (ZAAD_MERCHANT_UID) — safe to record as a real payment
// immediately.
const WAAFI_ENDPOINT = 'https://api.waafipay.net/asm';

// WAAFI's own documented success signal for this service — "2001" /
// RCS_SUCCESS. Never touch these two constants across environments; the
// previous system's own comment already established '2001' as the sole
// success code observed against the live gateway.
const SUCCESS_RESPONSE_CODE = '2001';

// Somaliland local numbers are commonly entered as 06XXXXXXXX or
// 63XXXXXXX; WAAFI's accountNo requires the full 252-prefixed
// international form. Ported verbatim from the previous system's own
// formatting rule — do not "improve" without re-verifying against a
// real WAAFI sandbox/production call, since an incorrectly formatted
// accountNo fails silently as "invalid account" on their side, not as a
// validation error here.
function formatZaadPhone(rawPhone) {
  let digits = String(rawPhone || '').replace(/\D/g, '');
  if (digits.startsWith('063')) digits = '252' + digits.substring(1);
  else if (digits.startsWith('63')) digits = '252' + digits;
  else if (!digits.startsWith('252')) digits = '252' + digits;
  return digits;
}

// Sends the payment request and waits for the customer's approval.
// Returns { ok: true, raw, transactionId } on WAAFI-confirmed success,
// or { ok: false, message, raw } otherwise — never throws for a normal
// decline/failure response, only for a genuine network/transport error
// (caller distinguishes via a thrown Error for that case).
async function requestZaadPayment({ phone, amount, currency, reference }) {
  const merchantUid = process.env.ZAAD_MERCHANT_UID;
  const apiUserId = process.env.ZAAD_API_USER_ID;
  const apiKey = process.env.ZAAD_API_KEY;
  if (!merchantUid || !apiUserId || !apiKey) {
    return { ok: false, message: 'ZAAD API credentials are not configured on the server.', notConfigured: true };
  }

  const formattedPhone = formatZaadPhone(phone);
  const reqCurrency = currency === 'SLSH' ? 'SLSH' : 'USD';
  const refId = reference ? String(reference) : `REF-${Date.now()}`;

  const payload = {
    schemaVersion: '1.0',
    requestId: `REQ-${Date.now()}${Math.floor(Math.random() * 1000)}`,
    timestamp: new Date().toISOString(),
    channelName: 'WEB',
    serviceName: 'API_PURCHASE',
    serviceParams: {
      merchantUid,
      apiUserId,
      apiKey,
      paymentMethod: 'MWALLET_ACCOUNT',
      payerInfo: { accountNo: formattedPhone },
      transactionInfo: {
        referenceId: refId,
        invoiceId: refId,
        amount: parseFloat(amount).toString(),
        currency: reqCurrency,
        // "Gurmad Waste Management" — the same merchant description
        // string the previous system's own working integration sent;
        // this is what the customer sees on their phone's approval
        // prompt, so it stays fixed rather than freely customizable.
        description: 'Gurmad Waste Management',
      },
    },
  };

  const response = await fetch(WAAFI_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json();

  if (data.responseCode === SUCCESS_RESPONSE_CODE) {
    return { ok: true, raw: data, transactionId: data.params?.transactionId || data.params?.referenceId || refId };
  }
  return { ok: false, message: data.responseMsg || 'ZAAD payment was not approved.', raw: data };
}

module.exports = { requestZaadPayment, formatZaadPhone };
