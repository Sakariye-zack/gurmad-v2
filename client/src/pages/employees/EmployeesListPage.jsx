import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users2, Plus, Truck, Briefcase } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, StatCard } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useEmployees } from '../../hooks/useEmployees.js';
import EmployeeFormModal from './EmployeeFormModal.jsx';

export default function EmployeesListPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [typeFilter, setTypeFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useEmployees({
    q: search || undefined,
    status: statusFilter === 'active' ? undefined : statusFilter,
    employee_type: typeFilter || undefined,
  });
  const { data: allActive } = useEmployees({});
  const employees = data?.data || [];
  const collectorCount = (allActive?.data || []).filter((e) => e.employee_type === 'collector').length;
  const officeCount = (allActive?.data || []).filter((e) => e.employee_type === 'office').length;

  return (
    <div>
      <PageHeader
        icon={Users2}
        title="Employees"
        subtitle="Staff master data — collectors, drivers, and office roles."
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>Create Employee</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Total Staff" value={allActive?.meta?.total ?? '—'} icon={Users2} />
        <StatCard label="Collectors" value={collectorCount} icon={Truck} accent="var(--info)" />
        <StatCard label="Office Staff" value={officeCount} icon={Briefcase} accent="var(--warning)" />
      </div>

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search by name, phone, or job title…">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All statuses</option>
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={selectStyle}>
          <option value="">All types</option>
          <option value="collector">Collector</option>
          <option value="driver">Driver</option>
          <option value="office">Office</option>
          <option value="other">Other</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && employees.length === 0}
        emptyTitle={search ? 'No employees match your search.' : 'No employees yet'}
        emptySubtitle={search ? 'Try a different name or phone number.' : 'Create the first employee to get started.'}
        columns={[
          { label: 'Name' }, { label: 'Type' }, { label: 'Phone' }, { label: 'Zone' }, { label: 'Status' },
        ]}
      >
        {employees.map((e) => (
          <tr key={e.id} onClick={() => navigate(`/employees/${e.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong>{e.name}</strong>{e.job_role ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> — {e.job_role}</span> : ''}</td>
            <td style={cellStyle}>
              <span style={{ textTransform: 'capitalize' }}>{e.employee_type}</span>
              {e.collector_type && <span style={{ color: 'var(--text-muted)' }}> ({e.collector_type}{e.commercial_shift ? `, ${e.commercial_shift}` : ''})</span>}
            </td>
            <td style={cellStyle} className="tabular-nums">{e.phone}</td>
            <td style={cellStyle}>{e.zone_name || (e.zone_id == null ? '—' : e.zone_id)}</td>
            <td style={cellStyle}><StatusBadge status={e.status} /></td>
          </tr>
        ))}
      </DataTable>

      <EmployeeFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
