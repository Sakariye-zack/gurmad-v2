import React from 'react';
import { AlertTriangle } from 'lucide-react';
import Button from './Button.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';

// Design_System.md §13: a failed load must never render as if the data were
// simply empty — this is the single most-repeated bug class found across the
// entire T2.8 audit program (Reports, Cashout, Collection Cycles each hit
// this independently). Every data-fetching page in V2 renders this on error,
// by template contract, not by per-page discretion.
export default function ErrorState({ message, onRetry }) {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px', padding: '48px 16px', textAlign: 'center' }}>
      <AlertTriangle size={28} color="var(--danger)" />
      <div style={{ fontSize: '14px', fontWeight: 700 }}>{message || t('common.somethingWrong')}</div>
      {onRetry && <Button variant="secondary" onClick={onRetry}>{t('common.retry')}</Button>}
    </div>
  );
}
