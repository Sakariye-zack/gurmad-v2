import React from 'react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { STATUS_MAP, DEPOSIT_TONE, VARIANCE_TONE, initials, avatarHue } from './cashoutUtils.js';

// Small shared pieces of the Cashout area. Colour is never the only signal:
// every chip carries its text label too.
export function Chip({ tone = 'info', flat, children, title }) {
  return <span className={`co-chip ${tone}${flat ? ' flat' : ''}`} title={title}>{children}</span>;
}

export function StatusChip({ status }) {
  const { tc } = useI18n();
  return <Chip tone={STATUS_MAP[status] || 'info'}>{tc(`status.${status}`, status)}</Chip>;
}

export function DepositChip({ status }) {
  const { t } = useI18n();
  if (!status) return null;
  return <Chip tone={DEPOSIT_TONE[status] || 'info'}>{t(`co2.dep.${status}`)}</Chip>;
}

export function VarianceChip({ status }) {
  const { t } = useI18n();
  return <Chip tone={VARIANCE_TONE[status] || 'info'}>{t(`co2.var.${status}`)}</Chip>;
}

export function NeedsAdminChip() {
  const { t } = useI18n();
  return <Chip tone="danger" flat title={t('co2.needsAdminHint')}>{t('co2.needsAdmin')}</Chip>;
}

export function Avatar({ name, id, small }) {
  return (
    <span className={`co-avatar${small ? ' sm' : ''}`} style={{ background: `hsl(${avatarHue(id ?? name)} 45% 42%)` }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function Person({ name, id, sub, small }) {
  return (
    <span className="co-person">
      <Avatar name={name} id={id} small={small} />
      <span style={{ minWidth: 0 }}>
        <span className="name" style={{ display: 'block' }}>{name || '—'}</span>
        {sub && <span className="sub" style={{ display: 'block' }}>{sub}</span>}
      </span>
    </span>
  );
}
