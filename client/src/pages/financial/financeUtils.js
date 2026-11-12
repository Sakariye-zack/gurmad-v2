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
export function zaadErrorInfo(t, err) {
  const code = err?.code;
  const status = err?.status;
  if (!status) return { critical: true, message: t('fr.zaad.err.network'), detail: err?.message };
  switch (code) {
    case 'ZAAD_DECLINED': return { critical: false, retry: true, message: t('fr.zaad.err.declined'), detail: err.message };
    case 'NOT_CONFIGURED': return { critical: false, message: t('fr.zaad.err.notConfigured') };
    case 'ZAAD_UNKNOWN': return { critical: true, message: t('fr.zaad.err.unknown'), detail: err.message };
    case 'RECONCILIATION_REQUIRED': return { critical: true, message: t('fr.zaad.err.reconciliation'), detail: err.message };
    case 'GATEWAY_ERROR': return { critical: true, message: t('fr.zaad.err.gateway'), detail: err.message };
    case 'OVERPAYMENT': return { critical: false, retry: true, message: t('fr.zaad.err.overpay'), detail: err.message };
    case 'NO_EXCHANGE_RATE': return { critical: false, message: t('fr.zaad.err.noRate') };
    case 'CONFLICT': return { critical: false, message: t('fr.zaad.err.voided') };
    case 'FORBIDDEN': return { critical: false, message: t('fr.zaad.err.forbidden') };
    case 'VALIDATION': return { critical: false, retry: true, message: t('fr.zaad.err.validation'), detail: err.message };
    default:
      if (status === 504) return { critical: true, message: t('fr.zaad.err.unknown'), detail: err.message };
      if (status === 502) return { critical: true, message: t('fr.zaad.err.gateway'), detail: err.message };
      return { critical: false, retry: true, message: err.message || t('common.somethingWrong') };
  }
}
