// Cashout V2 presentation helpers. No reconciliation maths lives here —
// every expected/actual/difference figure comes from the API; the only
// arithmetic on this side is the live note-count subtotal in the New
// Cashout form (re-validated and re-totalled by the server).
import { fmtMoney } from '../../lib/money.js';

export { fmtMoney };
export const CURRENCIES = ['USD', 'SLSH'];
export const METHODS = ['cash', 'zaad', 'edahab'];

export const STATUS_MAP = { pending: 'warning', approved: 'success', rejected: 'danger', voided: 'info' };
export const DEPOSIT_TONE = {
  not_required: 'info', not_deposited: 'danger', partial: 'warning', deposited: 'info', verified: 'success', variance: 'danger',
};
export const VARIANCE_TONE = { balanced: 'success', shortage: 'danger', surplus: 'info' };

// Legacy rows have no variance_status: derive it from the legacy columns.
export function varianceOf(co) {
  if (co.variance_status) return co.variance_status;
  if (Number(co.shortage) > 0) return 'shortage';
  if (Number(co.surplus) > 0) return 'surplus';
  return 'balanced';
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
// Stable avatar hue per person (so the same cashier always gets the same colour).
export function avatarHue(key) {
  let h = 0;
  for (const ch of String(key ?? '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// "$12.00 + 30,000 SLSH" from { USD, SLSH } (non-zero parts only).
export function fmtPair(by, empty = '—') {
  const parts = [];
  if (Math.abs(Number(by?.USD || 0)) > 0.004) parts.push(fmtMoney(by.USD, 'USD'));
  if (Math.abs(Number(by?.SLSH || 0)) > 0.4) parts.push(fmtMoney(by.SLSH, 'SLSH'));
  return parts.length ? parts.join(' + ') : empty;
}

export function fmtDiff(d, cur) {
  if (d === null || d === undefined) return '—';
  if (Math.abs(d) < (cur === 'SLSH' ? 0.5 : 0.005)) return '±0';
  return `${d > 0 ? '+' : '−'}${fmtMoney(Math.abs(d), cur)}`;
}

const pad = (n) => String(n).padStart(2, '0');
// Date -> value for <input type="datetime-local" step="1"> (local time, seconds).
export function toLocalInput(d) {
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(x.getTime())) return '';
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`;
}
export function localInputToIso(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

export function ageDays(d) {
  if (!d) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000));
}

// Live subtotal of a note count (display only; the server re-totals).
export function notesTotal(denoms, counts) {
  return (denoms || []).reduce((s, d) => s + d * (Number(counts?.[d]) || 0), 0);
}
