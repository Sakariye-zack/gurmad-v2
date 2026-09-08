import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wallet, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, StatCard, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { usePayrollPeriods, useCreatePayrollPeriod } from '../../hooks/usePayroll.js';

const STATUS_MAP = { open: 'info', processing: 'warning', finalized: 'success', paid: 'success' };

export default function PayrollPeriodsListPage() {
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = usePayrollPeriods();
  const periods = data?.data || [];
  const openCount = periods.filter((p) => p.status === 'open').length;
  const processingCount = periods.filter((p) => p.status === 'processing').length;

  return (
    <div>
      <PageHeader
        icon={Wallet}
        title="Payroll Periods"
        subtitle="Company-wide payroll periods and their processing lifecycle."
        actions={
          <RoleGate roles={['admin']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>New Period</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Total Periods" value={error ? '—' : periods.length} icon={Wallet} />
        <StatCard label="Open" value={error ? '—' : openCount} icon={Wallet} accent="var(--info)" />
        <StatCard label="Processing" value={error ? '—' : processingCount} icon={Wallet} accent="var(--warning)" />
      </div>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && periods.length === 0}
        emptyTitle="No payroll periods yet"
        emptySubtitle="Create the first payroll period to begin."
        columns={[{ label: 'Label' }, { label: 'Dates' }, { label: 'Status' }]}
      >
        {periods.map((p) => (
          <tr key={p.id} onClick={() => navigate(`/payroll/periods/${p.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong>{p.label}</strong></td>
            <td style={cellStyle} className="tabular-nums">{new Date(p.start_date).toLocaleDateString()} – {new Date(p.end_date).toLocaleDateString()}</td>
            <td style={cellStyle}><StatusBadge status={p.status} map={STATUS_MAP} /></td>
          </tr>
        ))}
      </DataTable>

      <PeriodFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function PeriodFormModal({ open, onClose }) {
  const [label, setLabel] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [error, setError] = useState('');
  const create = useCreatePayrollPeriod();
  const toast = useToast();

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!label || !startDate || !endDate) { setError('All fields are required.'); return; }
    try {
      const result = await create.mutateAsync({ label, start_date: startDate, end_date: endDate });
      toast.success(`${result.data.label} created.`);
      setLabel(''); setStartDate(''); setEndDate('');
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={create.isPending ? () => {} : onClose}
      title="New Payroll Period"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button>
        <Button type="submit" form="payroll-period-form" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create Period'}</Button>
      </>}
    >
      <form id="payroll-period-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} style={inputStyle} placeholder="e.g. 2026-09" />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Start date</span>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>End date</span>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

const cellStyle = { padding: '12px 14px' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
