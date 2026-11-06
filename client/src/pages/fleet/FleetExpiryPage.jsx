import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { PageHeader, DataTable, StatusBadge, FilterBar, Button } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useFleetExpiry } from '../../hooks/useFleet.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { RenewModal, fmtDate, cellStyle, selectStyle } from './fleetShared.jsx';

const STATUS_MAP = { expired: 'danger', expiring_soon: 'warning' };

export default function FleetExpiryPage() {
  const { t } = useI18n();
  const [statusFilter, setStatusFilter] = useState('');
  const [renewTarget, setRenewTarget] = useState(null);
  const { data, isLoading, error, refetch } = useFleetExpiry({ status: statusFilter || undefined });
  const rows = data?.data || [];

  return (
    <div>
      <PageHeader icon={AlertTriangle} title="Fleet Document Expiry" subtitle="Insurance, registration, and road tax documents expiring within 30 days or already expired." />

      <FilterBar searchValue="" onSearchChange={() => {}} searchPlaceholder="">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All</option>
          <option value="expired">Expired</option>
          <option value="expiring_soon">Expiring Soon</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && rows.length === 0}
        emptyTitle="No documents expiring or expired"
        columns={[{ label: t('fleet.common.truck') }, { label: t('fleet.common.zone') }, { label: t('fleet.common.document') }, { label: t('fleet.common.expiry') }, { label: t('fleet.m.status') }, { label: t('fleet.common.actions') }]}
      >
        {rows.map((r, i) => (
          <tr key={`${r.truck_id}-${r.document_type}-${i}`} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}><strong>{r.plate_number}</strong></td>
            <td style={cellStyle}>{r.zone_name || '—'}</td>
            <td style={cellStyle}>{t(`fleet.doc.${r.document_type}`, r.document_type)}</td>
            <td style={cellStyle} className="tabular-nums">{fmtDate(r.expiry_date)}</td>
            <td style={cellStyle}><StatusBadge status={r.status} map={STATUS_MAP} /></td>
            <td style={cellStyle}>
              <RoleGate roles={['admin', 'gudoomiye']}>
                <Button variant="secondary" onClick={() => setRenewTarget({ truckId: r.truck_id, document: r.document_type, plate: r.plate_number, current: r.expiry_date })}>{t('fleet.renew')}</Button>
              </RoleGate>
            </td>
          </tr>
        ))}
      </DataTable>
      <RenewModal target={renewTarget} onClose={() => setRenewTarget(null)} />
    </div>
  );
}
