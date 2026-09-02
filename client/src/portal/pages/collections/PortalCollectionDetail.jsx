import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DetailGrid, StatusBadge, LoadingState, ErrorState } from '../../../components/ui/index.js';
import PortalPageHeader from '../../components/PortalPageHeader.jsx';
import PortalCard from '../../components/PortalCard.jsx';
import { portalApiClient } from '../../apiClient.js';

// Rebuild — Implementation Spec §10/§22 (OD-5/Collection Detail).
// Deliberately does NOT display GPS/location (approved OD-A) — the API
// itself never returns status_lat/status_lng, so there is nothing to
// accidentally render here even by mistake.
export default function PortalCollectionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
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

  if (loading) return <LoadingState label="Loading collection detail…" />;
  if (error) return <ErrorState message={error.status === 404 ? 'Collection event not found.' : error.message} onRetry={load} />;
  if (!detail) return null;

  return (
    <div>
      <button onClick={() => navigate('/portal/collections')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Collections
      </button>
      <PortalPageHeader title={`Collection — ${detail.batch_code}`} subtitle={detail.status_at ? new Date(detail.status_at).toLocaleString() : 'Not yet serviced'} />
      <PortalCard>
        <DetailGrid items={[
          { label: 'Status', value: <StatusBadge status={detail.status} /> },
          { label: 'Zone', value: detail.zone_name || '—' },
          { label: 'Batch', value: detail.batch_code },
          { label: 'Collector', value: detail.collector_name || '—' },
          { label: 'Reason', value: detail.status_reason || '—' },
          { label: 'Note', value: detail.status_note || '—' },
        ]} />
      </PortalCard>
    </div>
  );
}

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
