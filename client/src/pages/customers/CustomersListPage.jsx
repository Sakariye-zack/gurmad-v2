import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useCustomers } from '../../hooks/useCustomers.js';
import CustomerFormModal from './CustomerFormModal.jsx';

export default function CustomersListPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active'); // active | archived | all — OD-1: hidden by default
  const [typeFilter, setTypeFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useCustomers({
    q: search || undefined,
    status: statusFilter === 'active' ? undefined : statusFilter,
    customer_type: typeFilter || undefined,
  });
  const customers = data?.data || [];

  return (
    <div>
      <PageHeader
        icon={Users}
        title="Customers"
        subtitle="Residential and Commercial customers across both zones."
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>Create Customer</Button>
          </RoleGate>
        }
      />

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search by Customer Number, name, business, or phone…">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All statuses</option>
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={selectStyle}>
          <option value="">All types</option>
          <option value="residential">Residential</option>
          <option value="commercial">Commercial</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && customers.length === 0}
        emptyTitle={search ? 'No customers match your search.' : 'No customers yet'}
        emptySubtitle={search ? 'Try a different name, phone, or Customer Number.' : 'Create the first customer to get started.'}
        columns={[
          { label: 'Customer #' }, { label: 'Name' }, { label: 'Type' }, { label: 'Phone' },
          { label: 'Zone' }, { label: 'Status' },
        ]}
      >
        {customers.map((c) => (
          <tr key={c.id} onClick={() => navigate(`/customers/${c.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong className="tabular-nums">{c.customer_number}</strong></td>
            <td style={cellStyle}>{c.business_name || c.name}</td>
            <td style={cellStyle}><span style={{ textTransform: 'capitalize' }}>{c.customer_type}</span></td>
            <td style={cellStyle} className="tabular-nums">{c.phone}</td>
            <td style={cellStyle}>{c.zone_name}</td>
            <td style={cellStyle}><StatusBadge status={c.status} /></td>
          </tr>
        ))}
      </DataTable>

      <CustomerFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
