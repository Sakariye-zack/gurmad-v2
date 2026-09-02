import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquareWarning } from 'lucide-react';
import { PageHeader, DataTable, StatusBadge, FilterBar, StatCard } from '../../components/ui/index.js';
import { useComplaints } from '../../hooks/useComplaints.js';

const STATUS_MAP = { pending: 'warning', in_progress: 'info', resolved: 'success', closed: 'info' };
const PRIORITY_MAP = { low: 'info', medium: 'warning', high: 'danger' };

export default function ComplaintsListPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('');
  const { data, isLoading, error, refetch } = useComplaints({ status: statusFilter || undefined });
  const complaints = data?.data || [];
  const pendingCount = complaints.filter((c) => c.status === 'pending').length;

  return (
    <div>
      <PageHeader icon={MessageSquareWarning} title="Complaints" subtitle="Customer complaints — submission, assignment, and resolution." />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Total" value={error ? '—' : complaints.length} icon={MessageSquareWarning} />
        <StatCard label="Pending" value={error ? '—' : pendingCount} icon={MessageSquareWarning} accent="var(--warning)" />
      </div>

      <FilterBar searchValue="" onSearchChange={() => {}} searchPlaceholder="">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && complaints.length === 0}
        emptyTitle="No complaints"
        columns={[{ label: 'Customer' }, { label: 'Title' }, { label: 'Priority' }, { label: 'Status' }, { label: 'Assigned To' }, { label: 'Source' }, { label: 'Date' }]}
      >
        {complaints.map((c) => (
          <tr key={c.id} onClick={() => navigate(`/complaints/${c.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}>{c.customer_name} <span style={{ color: 'var(--text-muted)' }}>({c.customer_number})</span></td>
            <td style={cellStyle}>{c.title}</td>
            <td style={cellStyle}><StatusBadge status={c.priority} map={PRIORITY_MAP} /></td>
            <td style={cellStyle}><StatusBadge status={c.status} map={STATUS_MAP} /></td>
            <td style={cellStyle}>{c.assigned_to_name || <span style={{ color: 'var(--text-muted)' }}>Unassigned</span>}</td>
            <td style={{ ...cellStyle, textTransform: 'capitalize' }}>{c.source}</td>
            <td style={cellStyle}>{new Date(c.created_at).toLocaleDateString()}</td>
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
