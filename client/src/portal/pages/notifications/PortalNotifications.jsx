import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DataTable, EmptyState, Button } from '../../../components/ui/index.js';
import PortalPageHeader from '../../components/PortalPageHeader.jsx';
import { portalApiClient } from '../../apiClient.js';
import { useI18n } from '../../../i18n/I18nContext.jsx';

// Rebuild — Implementation Spec §8/§26: read side of the notification
// infrastructure. No live producer writes into this yet (Complaints, the
// only named one, doesn't exist in V2) — this page correctly, honestly
// shows "No notifications yet" until one does, rather than faking content.
export default function PortalNotifications() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    portalApiClient.get('/notifications')
      .then((res) => setRows(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleRowClick(n) {
    if (!n.is_read) {
      // Not audited (Decision Record §7 — explicit "avoid audit noise" example).
      portalApiClient.put(`/notifications/${n.id}/read`).catch(() => {});
    }
    if (n.action_type === 'invoice' && n.action_id) navigate(`/portal/invoices/${n.action_id}`);
    else if (n.action_type === 'collection' && n.action_id) navigate(`/portal/collections/${n.action_id}`);
    else load();
  }

  async function handleMarkAllRead() {
    try {
      await portalApiClient.put('/notifications/read-all');
      load();
    } catch { /* non-critical */ }
  }

  return (
    <div>
      <PortalPageHeader
        title={t('portal.notifications')}
        subtitle={t('portal.notif.subtitle')}
        actions={rows && rows.some((r) => !r.is_read) ? <Button variant="secondary" onClick={handleMarkAllRead}>{t('portal.notif.markAll')}</Button> : undefined}
      />
      <DataTable
        loading={loading}
        error={error}
        onRetry={load}
        columns={[{ label: '' }, { label: t('portal.notif.col') }, { label: t('common.date') }]}
        isEmpty={rows && rows.length === 0}
      >
        {rows && rows.length === 0 ? (
          <tr><td colSpan={3}><EmptyState title={t('portal.notif.empty')} subtitle={t('portal.notif.emptyHint')} /></td></tr>
        ) : rows?.map((n) => (
          <tr key={n.id} onClick={() => handleRowClick(n)} style={{ borderTop: '1px solid var(--border)', cursor: 'pointer', background: n.is_read ? 'transparent' : 'var(--bg)' }}>
            <td style={{ ...tdStyle, width: '20px' }}>{!n.is_read && <span style={dotStyle} />}</td>
            <td style={tdStyle}>
              <div style={{ fontWeight: n.is_read ? 400 : 700 }}>{n.title}</div>
              {n.body && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{n.body}</div>}
            </td>
            <td style={tdStyle}>{new Date(n.created_at).toLocaleString()}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

const tdStyle = { padding: '10px 14px' };
const dotStyle = { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: 'var(--brand)' };
