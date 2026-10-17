import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { StatusBadge, LoadingState, ErrorState } from '../../../components/ui/index.js';
import PortalPageHeader from '../../components/PortalPageHeader.jsx';
import PortalCard from '../../components/PortalCard.jsx';
import { portalApiClient } from '../../apiClient.js';
import { useI18n } from '../../../i18n/I18nContext.jsx';

const STATUS_MAP = { pending: 'warning', in_progress: 'info', resolved: 'success', closed: 'info' };

export default function PortalComplaintDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [complaint, setComplaint] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    // A cross-customer id comes back 404 (matches every other Portal detail
    // route's ownership pattern) — rendered identically to "doesn't exist."
    portalApiClient.get(`/complaints/${id}`)
      .then((res) => setComplaint(res.data))
      .catch((err) => setError(err))
      .finally(() => setLoading(false));
  }

  useEffect(load, [id]);

  if (loading) return <LoadingState label={t('portal.complaintDetail.loading')} />;
  if (error) return <ErrorState message={error.status === 404 ? t('portal.complaintDetail.notFound') : error.message} onRetry={load} />;
  if (!complaint) return null;

  return (
    <div>
      <button onClick={() => navigate('/portal/complaints')} style={backLinkStyle}>
        <ArrowLeft size={14} /> {t('portal.complaints.back')}
      </button>
      <PortalPageHeader title={complaint.title} subtitle={new Date(complaint.created_at).toLocaleString()} />

      <PortalCard>
        <div style={{ display: 'flex', gap: '16px', marginBottom: '12px' }}>
          <div>
            <div style={labelStyle}>{t('common.status')}</div>
            <StatusBadge status={complaint.status} map={STATUS_MAP} />
          </div>
          <div>
            <div style={labelStyle}>{t('common.priority')}</div>
            <span style={{ textTransform: 'capitalize', fontWeight: 700, fontSize: '13px' }}>{t('priority.' + complaint.priority, complaint.priority)}</span>
          </div>
        </div>
        <div style={labelStyle}>{t('common.description')}</div>
        <p style={{ margin: '4px 0 0', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{complaint.description}</p>
      </PortalCard>

      {complaint.admin_reply && (
        <PortalCard style={{ marginTop: '16px' }}>
          <div style={labelStyle}>{t('portal.complaintDetail.staffReply')}</div>
          <p style={{ margin: '4px 0 0', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{complaint.admin_reply}</p>
          <p style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--text-muted)' }}>{new Date(complaint.replied_at).toLocaleString()}</p>
        </PortalCard>
      )}

      {complaint.attachments && complaint.attachments.length > 0 && (
        <PortalCard style={{ marginTop: '16px' }}>
          <div style={labelStyle}>{t('portal.complaintDetail.attachments')}</div>
          <div style={{ marginTop: '8px', fontSize: '13px', color: 'var(--text-muted)' }}>
            {complaint.attachments.map((a) => a.original_filename).join(', ')}
          </div>
        </PortalCard>
      )}
    </div>
  );
}

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
const labelStyle = { fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' };
