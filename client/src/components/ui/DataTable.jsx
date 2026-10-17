import React from 'react';
import LoadingState from './LoadingState.jsx';
import ErrorState from './ErrorState.jsx';
import EmptyState from './EmptyState.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';

// The only table component in V2 — Design_System.md §8: "no page hand-rolls
// its own <table>". overflow-x lives on this component's own wrapper, never
// the page body, so wide tables never cause page-level horizontal scroll.
export default function DataTable({ columns, children, loading, error, onRetry, isEmpty, emptyTitle, emptySubtitle }) {
  const { t } = useI18n();
  if (loading) return <LoadingState label={t('common.loading')} />;
  if (error) return <ErrorState message={error} onRetry={onRetry} />;

  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
            {columns.map((c, i) => (
              <th key={i} style={{
                padding: '10px 14px', textAlign: c.align || 'left', fontSize: '11px',
                fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)',
                whiteSpace: 'nowrap',
              }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {isEmpty && <EmptyState title={emptyTitle || t('common.noRecords')} subtitle={emptySubtitle} />}
    </div>
  );
}
