import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DetailGrid, StatusBadge, LoadingState, ErrorState } from '../../../components/ui/index.js';
import PortalPageHeader from '../../components/PortalPageHeader.jsx';
import PortalCard from '../../components/PortalCard.jsx';
import { portalApiClient } from '../../apiClient.js';
import { useI18n } from '../../../i18n/I18nContext.jsx';

// Rebuild — Implementation Spec §10/§22 (OD-5/Collection Detail).
// Deliberately does NOT display GPS/location (approved OD-A) — the API
// itself never returns status_lat/status_lng, so there is nothing to
// accidentally render here even by mistake.
export default function PortalCollectionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    // A cross-customer id comes back 404 (OD-7 pattern, reconfirmed) —
    // rendered identically to "doesn't exist."
    portalApiClient.get(`/collection-history/${id}`)
      .then((res) => setDetail(res.data))
      .catch((err) => setError(err))
      .finally(() => setLoading(false));
  }

  useEffect(load, [id]);

  if (loading) return <LoadingState label={t('portal.collections.loadingDetail')} />;
  if (error) return <ErrorState message={error.status === 404 ? t('portal.collections.notFound') : error.message} onRetry={load} />;
  if (!detail) return null;

  return (
    <div>
      <button onClick={() => navigate('/portal/collections')} style={backLinkStyle}>
        <ArrowLeft size={14} /> {t('portal.collections.back')}
      </button>
      <PortalPageHeader title={t('portal.collections.detailTitle', undefined, { batch: detail.batch_code })} subtitle={detail.status_at ? new Date(detail.status_at).toLocaleString() : t('portal.collections.notServiced')} />
      <PortalCard>
        <DetailGrid items={[
          { label: t('common.status'), value: <StatusBadge status={detail.status} /> },
          { label: t('common.zone'), value: detail.zone_name || '—' },
          { label: t('common.batch'), value: detail.batch_code },
          { label: t('portal.collections.collector'), value: detail.collector_name || '—' },
          { label: t('common.reason'), value: detail.status_reason || '—' },
          { label: t('common.note'), value: detail.status_note || '—' },
        ]} />
      </PortalCard>
    </div>
  );
}

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
