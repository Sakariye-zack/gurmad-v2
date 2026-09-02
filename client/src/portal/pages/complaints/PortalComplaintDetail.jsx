import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { StatusBadge, LoadingState, ErrorState } from '../../../components/ui/index.js';
import PortalPageHeader from '../../components/PortalPageHeader.jsx';
import PortalCard from '../../components/PortalCard.jsx';
import { portalApiClient } from '../../apiClient.js';

const STATUS_MAP = { pending: 'warning', in_progress: 'info', resolved: 'success', closed: 'info' };

export default function PortalComplaintDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
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

  if (loading) return <LoadingState label="Loading complaint…" />;
  if (error) return <ErrorState message={error.status === 404 ? 'Complaint not found.' : error.message} onRetry={load} />;
  if (!complaint) return null;

  return (
    <div>
      <button onClick={() => navigate('/portal/complaints')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Complaints
      </button>
      <PortalPageHeader title={complaint.title} subtitle={new Date(complaint.created_at).toLocaleString()} />

      <PortalCard>
        <div style={{ display: 'flex', gap: '16px', marginBottom: '12px' }}>
          <div>
            <div style={labelStyle}>Status</div>
            <StatusBadge status={complaint.status} map={STATUS_MAP} />
          </div>
          <div>
            <div style={labelStyle}>Priority</div>
            <span style={{ textTransform: 'capitalize', fontWeight: 700, fontSize: '13px' }}>{complaint.priority}</span>
          </div>
        </div>
        <div style={labelStyle}>Description</div>
        <p style={{ margin: '4px 0 0', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{complaint.description}</p>
      </PortalCard>

      {complaint.admin_reply && (
        <PortalCard style={{ marginTop: '16px' }}>
          <div style={labelStyle}>Staff Reply</div>
          <p style={{ margin: '4px 0 0', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{complaint.admin_reply}</p>
          <p style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--text-muted)' }}>{new Date(complaint.replied_at).toLocaleString()}</p>
        </PortalCard>
      )}

      {complaint.attachments && complaint.attachments.length > 0 && (
        <PortalCard style={{ marginTop: '16px' }}>
          <div style={labelStyle}>Attachments</div>
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
