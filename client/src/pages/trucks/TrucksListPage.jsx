import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Truck, Plus, AlertTriangle, Wrench } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, StatCard } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useTrucks } from '../../hooks/useTrucks.js';
import TruckFormModal from './TruckFormModal.jsx';
import { complianceState, COMPLIANCE_LABELS, COMPLIANCE_BADGE_MAP } from './complianceState.js';

export default function TrucksListPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [complianceFilter, setComplianceFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useTrucks({
    q: search || undefined,
    status: statusFilter === 'active' ? undefined : statusFilter,
  });
  const allTrucks = data?.data || [];
  const trucks = complianceFilter ? allTrucks.filter((t) => complianceState(t) === complianceFilter) : allTrucks;

  const expiredCount = error ? null : allTrucks.filter((t) => complianceState(t) === 'expired').length;
  const maintenanceCount = error ? null : allTrucks.filter((t) => t.status === 'maintenance').length;

  return (
    <div>
      <PageHeader
        icon={Truck}
        title="Trucks"
        subtitle="Fleet master data — vehicles, driver/collector assignment, compliance."
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>Create Truck</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Total Trucks" value={error ? '—' : (data?.meta?.total ?? '—')} icon={Truck} />
        <StatCard label="In Maintenance" value={maintenanceCount ?? '—'} icon={Wrench} accent="var(--warning)" />
        <StatCard label="Compliance Expired" value={expiredCount ?? '—'} icon={AlertTriangle} accent="var(--danger)" />
      </div>

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search by plate number…">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="active">Active status</option>
          <option value="maintenance">Maintenance</option>
          <option value="inactive">Inactive</option>
          <option value="retired">Retired</option>
          <option value="all">All statuses</option>
        </select>
        <select value={complianceFilter} onChange={(e) => setComplianceFilter(e.target.value)} style={selectStyle}>
          <option value="">All compliance</option>
          <option value="expired">Expired</option>
          <option value="expiring_soon">Expiring soon</option>
          <option value="ok">Compliant</option>
          <option value="unknown">No dates set</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && trucks.length === 0}
        emptyTitle={search ? 'No trucks match your search.' : 'No trucks yet'}
        emptySubtitle={search ? 'Try a different plate number.' : 'Create the first truck to get started.'}
        columns={[
          { label: 'Plate' }, { label: 'Zone' }, { label: 'Driver' }, { label: 'Collector' }, { label: 'Status' }, { label: 'Compliance' },
        ]}
      >
        {trucks.map((t) => {
          const cs = complianceState(t);
          return (
            <tr key={t.id} onClick={() => navigate(`/trucks/${t.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
              <td style={cellStyle}><strong className="tabular-nums">{t.plate_number}</strong>{t.model ? <span style={{ color: 'var(--text-muted)' }}> — {t.model}</span> : ''}</td>
              <td style={cellStyle}>{t.zone_name || '— (company-wide)'}</td>
              <td style={cellStyle}>{t.driver_name || '—'}</td>
              <td style={cellStyle}>{t.collector_name || '—'}</td>
              <td style={cellStyle}><StatusBadge status={t.status} /></td>
              <td style={cellStyle}><StatusBadge status={COMPLIANCE_LABELS[cs]} map={{ [COMPLIANCE_LABELS[cs].toLowerCase()]: COMPLIANCE_BADGE_MAP[cs] }} /></td>
            </tr>
          );
        })}
      </DataTable>

      <TruckFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
