import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { PageHeader, DataTable, StatusBadge, FilterBar } from '../../components/ui/index.js';
import { useFleetExpiry } from '../../hooks/useFleet.js';

const STATUS_MAP = { expired: 'danger', expiring_soon: 'warning' };
const DOC_LABELS = { insurance: 'Insurance', registration: 'Registration', road_tax: 'Road Tax' };

export default function FleetExpiryPage() {
  const [statusFilter, setStatusFilter] = useState('');
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
        columns={[{ label: 'Truck' }, { label: 'Zone' }, { label: 'Document' }, { label: 'Expiry Date' }, { label: 'Status' }]}
      >
        {rows.map((r, i) => (
          <tr key={`${r.truck_id}-${r.document_type}-${i}`} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}><strong>{r.plate_number}</strong></td>
            <td style={cellStyle}>{r.zone_name || '—'}</td>
            <td style={cellStyle}>{DOC_LABELS[r.document_type] || r.document_type}</td>
            <td style={cellStyle} className="tabular-nums">{new Date(r.expiry_date).toLocaleDateString()}</td>
            <td style={cellStyle}><StatusBadge status={r.status} map={STATUS_MAP} /></td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
