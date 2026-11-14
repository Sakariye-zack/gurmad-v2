import React from 'react';
import { Phone, MessageCircle } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { fmtMoney } from '../../lib/money.js';
import { formatPhone, telHref, whatsappHref } from '../../lib/phone.js';
import { hierarchyParts } from '../../lib/hierarchy.js';

// Presentation helpers for the Debts page. No money maths here: every
// amount, age, state and promise state comes from GET /v2/debts.

export const AGE_TONE = { '0_30': 'age0', '31_60': 'age1', '61_90': 'age2', '90_plus': 'age3' };
export const STATE_TONE = { unpaid: 'danger', partial: 'warning', paid: 'success', written_off: '' };
export const PROMISE_TONE = { due_today: 'warning', broken: 'danger', upcoming: 'info' };
export const COLLECT_ROLES = ['admin', 'cashier'];
export const CREATE_ROLES = ['admin', 'cashier', 'gudoomiye'];
export const isOpen = (d) => d && (d.state === 'unpaid' || d.state === 'partial');

export function pathText(row) {
  const p = hierarchyParts(row);
  return [p.group, p.district, p.zone, p.subZone].filter(Boolean).join(' › ');
}

// "{USD} + {SLSH}" with each currency labelled; never summed across currencies.
export function MoneyPair({ usd, slsh, className = 'dv-amt', zero = '—' }) {
  const u = Number(usd) > 0.004;
  const s = Number(slsh) > 0.4;
  if (!u && !s) return <span className="cl-muted">{zero}</span>;
  return (
    <span className={className} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'inherit' }}>
      {u && <span>{fmtMoney(usd, 'USD')}</span>}
      {s && <span>{fmtMoney(slsh, 'SLSH')}</span>}
    </span>
  );
}

export function AgeChip({ days, bucket }) {
  const { t } = useI18n();
  return (
    <span className={`cl-chip ${AGE_TONE[bucket] || ''}`} title={t(`dv.age.${bucket}`)}>
      {days <= 0 ? t('dv.ageToday') : t('dv.ageDays', undefined, { n: days })}
    </span>
  );
}

export function StateChip({ state }) {
  const { t } = useI18n();
  return <span className={`cl-chip dot ${STATE_TONE[state] ?? ''}`}>{t(`dv.st.${state}`, state)}</span>;
}

export function SourceChip({ row }) {
  const { t } = useI18n();
  return row.source === 'auto_invoice'
    ? <span className="cl-chip info" title={t('dv.mirrors')}>{t('dv.auto')}</span>
    : <span className="cl-chip">{t('dv.manual')}</span>;
}

export function PromiseCell({ row }) {
  const { t } = useI18n();
  if (!row.promise_date) return <span className="cl-muted">—</span>;
  return (
    <div>
      <div className="dv-amt" style={{ fontWeight: 600 }}>{row.promise_date}</div>
      {row.promise_amount ? <div className="cl-sub">{fmtMoney(row.promise_amount, row.promise_currency || row.currency)}</div> : null}
      {row.promise_state !== 'none' && <span className={`cl-chip ${PROMISE_TONE[row.promise_state] || ''}`}>{t(`dv.pr.${row.promise_state}`)}</span>}
    </div>
  );
}

// Read-only view of the customer's standing against the 90-day debt
// suspension rule (lib/debtSuspension.js — computed from INVOICES).
export function SuspensionChip({ s }) {
  const { t } = useI18n();
  if (!s) return null;
  if (s.state === 'suspended') return <span className="cl-chip danger">{t('dv.susp.suspended')}</span>;
  if (s.state === 'review_due') return <span className="cl-chip warning">{t('dv.susp.review')}</span>;
  if (s.state === 'dismissed') return <span className="cl-chip">{t('dv.susp.dismissed')}</span>;
  if (s.state === 'counting' && s.days_left <= 30) return <span className="cl-chip info">{t('dv.susp.counting', undefined, { n: s.days_left })}</span>;
  return null;
}

export function PhoneLinks({ row }) {
  const { t } = useI18n();
  if (!row.phone) return <span className="cl-muted">—</span>;
  const tel = telHref(row.phone);
  const wa = whatsappHref(row.whatsapp || row.phone);
  return (
    <div className="cl-phone">
      <span>{formatPhone(row.phone)}</span>
      {tel && <a className="cl-icon-link" href={tel} onClick={(e) => e.stopPropagation()} aria-label={`${t('dv.act.call')} ${formatPhone(row.phone)}`} title={t('dv.act.call')}><Phone size={13} /></a>}
      {wa && <a className="cl-icon-link wa" href={wa} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} aria-label={t('dv.act.whatsapp')} title={t('dv.act.whatsapp')}><MessageCircle size={13} /></a>}
    </div>
  );
}

// Reminder message (Somali + English) for the follow-up helper.
export function reminderText(t, name, amountText) {
  return `${t('dv.fu.msg.so', undefined, { name, amount: amountText })}\n\n${t('dv.fu.msg.en', undefined, { name, amount: amountText })}`;
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall back below */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}
