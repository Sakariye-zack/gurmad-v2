import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { DataTable, StatusBadge, EmptyState, Button } from '../../../components/ui/index.js';
import PortalPageHeader from '../../components/PortalPageHeader.jsx';
import { portalApiClient } from '../../apiClient.js';
import { useI18n } from '../../../i18n/I18nContext.jsx';

const STATUS_MAP = { pending: 'warning', in_progress: 'info', resolved: 'success', closed: 'info' };

export default function PortalComplaints() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    portalApiClient.get('/complaints')
      .then((res) => setRows(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <div>
      <PortalPageHeader
        title={t('portal.complaints.title')}
        subtitle={t('portal.complaints.subtitle')}
        actions={<Button icon={Plus} onClick={() => navigate('/portal/complaints/new')}>{t('portal.complaints.new')}</Button>}
      />
      <DataTable
        loading={loading}
        error={error}
        onRetry={load}
        columns={[{ label: t('common.title') }, { label: t('common.priority') }, { label: t('common.status') }, { label: t('common.date') }]}
        isEmpty={rows && rows.length === 0}
      >
        {rows && rows.length === 0 ? (
          <tr><td colSpan={4}><EmptyState title={t('portal.complaints.empty')} subtitle={t('portal.complaints.emptyHint')} /></td></tr>
        ) : rows?.map((c) => (
          <tr key={c.id} onClick={() => navigate(`/portal/complaints/${c.id}`)} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={tdStyle}>{c.title}</td>
            <td style={{ ...tdStyle, textTransform: 'capitalize' }}>{t('priority.' + c.priority, c.priority)}</td>
            <td style={tdStyle}><StatusBadge status={c.status} map={STATUS_MAP} /></td>
            <td style={tdStyle}>{new Date(c.created_at).toLocaleDateString()}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

const tdStyle = { padding: '10px 14px' };
