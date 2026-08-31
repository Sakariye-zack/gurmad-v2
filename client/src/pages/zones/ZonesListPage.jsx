import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPinned, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useZones } from '../../hooks/useZones.js';
import ZoneFormModal from './ZoneFormModal.jsx';

// Zones List — Phase 3, Module 1. Fresh build per Module_UI_Specifications.md,
// not the old LandingManagementView. With exactly two approved zones, the
// list's job is to make both immediately understandable at a glance, not to
// manage a large catalog.
export default function ZonesListPage() {
  const { data, isLoading, error, refetch } = useZones();
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const zones = data?.data || [];

  return (
    <div>
      <PageHeader
        icon={MapPinned}
        title="Zones"
        subtitle="Gurmad's two operational zones — Farah Omar and Sheekh Bashiir."
        actions={
          <RoleGate roles={['admin']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>Create Zone</Button>
          </RoleGate>
        }
      />

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && zones.length === 0}
        emptyTitle="No zones yet"
        emptySubtitle="Create the first operational zone to get started."
        columns={[
          { label: 'Zone' },
          { label: 'Code' },
          { label: 'Sub-zone' },
          { label: 'Area' },
          { label: 'Collection days' },
          { label: 'Status' },
        ]}
      >
        {zones.map((z) => (
          <tr
            key={z.id}
            onClick={() => navigate(`/zones/${z.id}`)}
            style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
          >
            <td style={cellStyle}><strong>{z.name}</strong></td>
            <td style={cellStyle}>{z.zone_code}</td>
            <td style={cellStyle}>{z.sub_zone || '—'}</td>
            <td style={cellStyle}>{z.area || '—'}</td>
            <td style={cellStyle}>{(z.collection_days || []).join(', ') || '—'}</td>
            <td style={cellStyle}><StatusBadge status={z.status} /></td>
          </tr>
        ))}
      </DataTable>

      <ZoneFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
