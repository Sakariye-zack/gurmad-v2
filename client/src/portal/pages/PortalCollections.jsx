import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DataTable, StatusBadge, EmptyState } from '../../components/ui/index.js';
import { portalApiClient } from '../apiClient.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

export default function PortalCollections() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    portalApiClient.get('/collection-history')
      .then((res) => setRows(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <div>
      <h2 style={{ margin: '0 0 16px' }}>{t('portal.collections.title')}</h2>
      <DataTable
        loading={loading}
        error={error}
        onRetry={load}
        columns={[{ label: t('common.date') }, { label: t('common.status') }, { label: t('common.reason') }, { label: t('common.batch') }]}
        isEmpty={rows && rows.length === 0}
      >
        {rows && rows.length === 0 ? (
          <tr><td colSpan={4}><EmptyState title={t('portal.collections.empty')} /></td></tr>
        ) : rows?.map((r) => (
          <tr key={r.id} onClick={() => navigate(`/portal/collections/${r.id}`)} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={tdStyle}>{r.status_at ? new Date(r.status_at).toLocaleString() : '—'}</td>
            <td style={tdStyle}><StatusBadge status={r.status} /></td>
            <td style={tdStyle}>{r.status_reason || '—'}</td>
            <td style={tdStyle}>{r.batch_code}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

const tdStyle = { padding: '10px 14px' };
