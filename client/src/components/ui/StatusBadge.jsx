import React from 'react';
import { useI18n } from '../../i18n/I18nContext.jsx';

// One canonical status→semantic-color mapping, not re-derived per page.
// Design_System.md §2/§8: color is never the only signal — text + a small
// dot are always both present.
const DEFAULT_MAP = {
  paid: 'success', serviced: 'success', approved: 'success', active: 'success', completed: 'success',
  partial: 'warning', pending: 'warning', missed: 'warning', 'pending approval': 'warning',
  unpaid: 'danger', voided: 'danger', rejected: 'danger', cancelled: 'danger', blocked: 'danger',
  skipped: 'info', rescheduled: 'info',
};

export default function StatusBadge({ status, map }) {
  const { t } = useI18n();
  const key = (status || '').toLowerCase();
  const variant = (map && map[key]) || DEFAULT_MAP[key] || 'info';
  const fg = `var(--${variant})`;
  const bg = `var(--${variant}-bg)`;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '3px 10px',
      borderRadius: '999px', fontSize: '12px', fontWeight: 700, background: bg, color: fg,
    }}>
      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: fg }} />
      {t('status.' + key, status)}
    </span>
  );
}
