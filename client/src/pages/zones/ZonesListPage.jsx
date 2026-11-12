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
        subtitle={t('opsp.districtsSubtitle')}
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
          { label: t('opsp.col.groups') },
          { label: t('opsp.col.zones') },
          { label: t('opsp.col.subZones') },
          { label: t('opsp.col.customers') },
          { label: t('opsp.col.collectors') },
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
            {/* Legacy sub_zone / area / collection_days stay in the form + DB
                but are no longer shown here: daily lists use the Sub Zones. */}
            <td style={cellStyle} className="tabular-nums">{count(z.group_count)}</td>
            <td style={cellStyle} className="tabular-nums">{count(z.group_zone_count)}</td>
            <td style={cellStyle} className="tabular-nums">{count(z.subzone_count)}</td>
            <td style={cellStyle} className="tabular-nums">{count(z.customer_count)}</td>
            <td style={cellStyle} className="tabular-nums">{count(z.collector_count)}</td>
            <td style={cellStyle}><StatusBadge status={z.status} /></td>
          </tr>
        ))}
      </DataTable>

      <ZoneFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
// Counts are null for districts outside the caller's own (server-side scoping).
const count = (n) => (n === null || n === undefined ? '—' : n);
