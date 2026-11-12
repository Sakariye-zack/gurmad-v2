// Presentation helpers shared by the Billing workspace, Transactions page and
// Invoice page. No balance/status maths lives here — every money figure is
// taken from the API (balance blocks computed server-side); these only format.
import { fmtMoney } from '../../lib/money.js';

export const STATUS_MAP = { unpaid: 'danger', partial: 'warning', paid: 'success', voided: 'info' };
export const PAYMENT_STATUS_MAP = { recorded: 'success', reversed: 'danger' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const invCurrency = (inv) => (inv?.currency === 'SLSH' ? 'SLSH' : 'USD');
export const otherCurrency = (cur) => (cur === 'SLSH' ? 'USD' : 'SLSH');

// The other-currency block of a server balance (null when no rate is set).
export function secondaryBlock(balance, cur) {
  if (!balance || !balance.rate) return null;
  return otherCurrency(cur) === 'USD' ? balance.usd : balance.slsh;
}

export function rateText(balance) {
  if (!balance?.rate) return null;
  return Number(balance.rate.rate).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Converts an amount between USD and SLSH at the balance's current rate —
// used ONLY for the "≈" hints and the Full-amount prefill; the server sizes
// and validates every payment itself.
export function convert(amount, from, to, balance) {
  const v = Number(amount || 0);
  if (from === to) return v;
  const r = balance?.rate ? Number(balance.rate.rate) : null;
  if (!r) return null;
  return from === 'USD' ? v * r : v / r;
}

export function methodLabel(t, method) {
  return t(`fr.method.${method}`, method ? method.toUpperCase() : '—');
}

export function paymentChannelLabel(t, p) {
  return p.channel === 'portal_zaad' ? t('fr.channel.portal') : t('fr.channel.staff');
}

export function recordedByLabel(t, p) {
  if (p.channel === 'portal_zaad') return t('fr.portalZaad');
  return p.cashier_name || (p.cashier_id ? `#${p.cashier_id}` : '—');
}

export function ageDays(createdAt) {
  if (!createdAt) return 0;
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}
export function ageLabel(t, days) {
  if (days <= 0) return t('fr.bill.ageToday');
  if (days === 1) return t('fr.bill.ageOne');
  return t('fr.bill.ageDays', undefined, { n: days });
}

export const fmtDate = (d) => {
  if (!d) return '—';
  const x = new Date(d);
  if (isNaN(x.getTime())) return '—';
  return `${String(x.getDate()).padStart(2, '0')} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`;
};
export const fmtDateTime = (d) => {
  if (!d) return '—';
  const x = new Date(d);
  if (isNaN(x.getTime())) return '—';
  return `${fmtDate(x)}, ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
};
export const periodLabel = (p) => { const m = /^(\d{4})-(\d{2})$/.exec(p || ''); return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ''; };
export const dayLabel = (iso) => `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

export { fmtMoney };

// Maps a /payments/zaad-request failure to what the cashier must do.
// critical = the money MAY have moved: never resend, escalate to an admin.
// Fail closed: ONLY the explicit codes below are known to be rejected before
// any gateway call (or a clean gateway decline). Anything else — a 5xx, a
// missing code, an HTML error page, a network drop after the request left —
// is treated as critical.
const SAFE_ZAAD_ERRORS = {
  VALIDATION: { retry: true, key: 'fr.zaad.err.validation', detail: true },
  OVERPAYMENT: { retry: true, key: 'fr.zaad.err.overpay', detail: true },
  NO_EXCHANGE_RATE: { key: 'fr.zaad.err.noRate' },
  CONFLICT: { key: 'fr.zaad.err.voided' },
  FORBIDDEN: { key: 'fr.zaad.err.forbidden' },
  NOT_FOUND: { key: 'fr.zaad.err.notFound' },
  NOT_CONFIGURED: { key: 'fr.zaad.err.notConfigured' },
  ZAAD_DECLINED: { retry: true, key: 'fr.zaad.err.declined', detail: true },
  ZAAD_IN_PROGRESS: { key: 'fr.zaad.err.inProgress' },
  PAYMENT_UNCONFIRMED: { key: 'fr.zaad.err.unconfirmed' },
};
export function zaadErrorInfo(t, err) {
  const code = err?.code;
  const status = err?.status;
  const safe = status && status < 500 && SAFE_ZAAD_ERRORS[code];
  if (safe) return { critical: false, retry: !!safe.retry, message: t(safe.key), detail: safe.detail ? err.message : undefined };
  if (!status) return { critical: true, message: t('fr.zaad.err.network'), detail: err?.message };
  if (code === 'RECONCILIATION_REQUIRED') return { critical: true, message: t('fr.zaad.err.reconciliation'), detail: err.message };
  if (code === 'ZAAD_UNKNOWN' || status === 504) return { critical: true, message: t('fr.zaad.err.unknown'), detail: err.message };
  if (code === 'GATEWAY_ERROR' || status === 502) return { critical: true, message: t('fr.zaad.err.gateway'), detail: err.message };
  return { critical: true, message: t('fr.zaad.err.unexpected'), detail: err?.message };
}

// Client-side mirror of the server precheck for the Full-amount / push
// guard: the payment converted to the invoice currency must not exceed what
// is owed (+ the server's half-cent tolerance). The server still decides.
export function exceedsOwed(amount, payCur, balance, invCur) {
  const owed = Number(balance?.outstanding || 0);
  const inInvCur = convert(amount, payCur, invCur, balance);
  if (inInvCur === null) return true; // no rate: cannot size it
  const r = balance?.rate ? Number(balance.rate.rate) : 0;
  const tol = invCur === 'SLSH' ? (payCur === 'USD' ? r * 0.005 : 0.005) : 0.005;
  return inInvCur > owed + tol;
}
