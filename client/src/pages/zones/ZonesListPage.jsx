import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPinned, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useZones } from '../../hooks/useZones.js';
import ZoneFormModal from './ZoneFormModal.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';

// Zones List — Phase 3, Module 1. Fresh build per Module_UI_Specifications.md,
// not the old LandingManagementView. With exactly two approved zones, the
// list's job is to make both immediately understandable at a glance, not to
// manage a large catalog.
export default function ZonesListPage() {
  const { t } = useI18n();
  const { data, isLoading, error, refetch } = useZones();
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const zones = data?.data || [];

  return (
    <div>
      <PageHeader
        icon={MapPinned}
        title={t('nav.zones')}
        subtitle={t('zone.gurmad_s_two_operational_zones')}
        actions={
          <RoleGate roles={['admin']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>{t('zone.create_zone')}</Button>
          </RoleGate>
        }
      />

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && zones.length === 0}
        emptyTitle={t('zone.no_zones_yet')}
        emptySubtitle={t('zone.create_the_first_operational_zone')}
        columns={[
          { label: t('common.zone') },
          { label: t('zone.code') },
          { label: t('zone.sub_zone') },
          { label: t('zone.area') },
          { label: t('zone.collection_days') },
          { label: t('common.status') },
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
