import React from 'react';
import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';

// Help sentence for the manual/advanced collection pages (Collection Cycles,
// Batches, Calendar): daily work now happens on Today's list.
export default function LegacyOpsBanner() {
  const { t } = useI18n();
  return (
    <div
      role="note"
      style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 12px', padding: '10px 14px', marginBottom: '16px',
        border: '1px solid var(--border)', borderLeft: '3px solid var(--info)', borderRadius: 'var(--radius-sm)',
        background: 'var(--surface)', fontSize: '13px', color: 'var(--text-muted)',
      }}
    >
      <Info size={15} style={{ color: 'var(--info)', flexShrink: 0 }} />
      <span style={{ flex: '1 1 240px' }}>{t('opsp.legacyBanner')}</span>
      <Link to="/operations/today" style={{ color: 'var(--brand)', fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}>
        {t('opsp.goToday')} →
      </Link>
    </div>
  );
}
