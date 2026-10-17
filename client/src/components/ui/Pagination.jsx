import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import Button from './Button.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';

export default function Pagination({ page, pageSize, total, onPageChange }) {
  const { t } = useI18n();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', fontSize: '13px', color: 'var(--text-muted)' }}>
      <span>{t('common.page')} {page} / {totalPages}</span>
      <div style={{ display: 'flex', gap: '6px' }}>
        <Button variant="secondary" icon={ChevronLeft} disabled={page <= 1} onClick={() => onPageChange(page - 1)} style={{ padding: '6px 10px' }}>{t('common.prev')}</Button>
        <Button variant="secondary" icon={ChevronRight} disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} style={{ padding: '6px 10px', flexDirection: 'row-reverse' }}>{t('common.next')}</Button>
      </div>
    </div>
  );
}
