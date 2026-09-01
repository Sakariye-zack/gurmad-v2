import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MapPinned, Pencil } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useZone } from '../../hooks/useZones.js';
import ZoneFormModal from './ZoneFormModal.jsx';

// Zone Detail — a clean foundation only. Deliberately does NOT pretend
// Customers/Employees/Trucks/Collection Cycles are already implemented here
// (Phase 3 Module 1 scope rule) — those sections get added when their own
// modules land and start linking back to this page.
export default function ZoneDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useZone(id);
  const [editOpen, setEditOpen] = useState(false);
  const zone = data?.data;

  if (isLoading) return <LoadingState label="Loading zone…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!zone) return null;

  return (
    <div>
      <button onClick={() => navigate('/zones')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Zones
      </button>

      <PageHeader
        icon={MapPinned}
        title={zone.name}
        subtitle={zone.zone_code}
        actions={
          <RoleGate roles={['admin']}>
            <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>Edit Zone</Button>
          </RoleGate>
        }
      />

      <DetailGrid items={[
        { label: 'Status', value: <StatusBadge status={zone.status} /> },
        { label: 'Sub-zone', value: zone.sub_zone || '—' },
        { label: 'Area', value: zone.area || '—' },
        { label: 'Collection days', value: (zone.collection_days || []).join(', ') || '—' },
      ]} />

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>
          Customers, employees, collectors, and trucks assigned to this zone will appear here
          once their respective modules are implemented, per the approved one-module-at-a-time sequence.
        </p>
      </Card>

      <ZoneFormModal open={editOpen} onClose={() => setEditOpen(false)} zone={zone} />
    </div>
  );
}

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
