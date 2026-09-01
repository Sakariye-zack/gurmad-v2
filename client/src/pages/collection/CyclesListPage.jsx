import React, { useState } from 'react';
import { CalendarRange, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useCycles, useCreateCycle } from '../../hooks/useCollectionOps.js';
import { useZonesList } from '../../hooks/useCustomers.js';

export default function CyclesListPage() {
  const { data, isLoading, error, refetch } = useCycles();
  const [formOpen, setFormOpen] = useState(false);
  const cycles = data?.data || [];

  return (
    <div>
      <PageHeader
        icon={CalendarRange}
        title="Collection Cycles"
        subtitle="Monthly, weekly, or custom collection periods per zone."
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>Create Cycle</Button>
          </RoleGate>
        }
      />
      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && cycles.length === 0}
        emptyTitle="No collection cycles yet"
        emptySubtitle="Create the first cycle to start building batches."
        columns={[{ label: 'Zone' }, { label: 'Type' }, { label: 'Start' }, { label: 'End' }, { label: 'Status' }]}
      >
        {cycles.map((c) => (
          <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}><strong>{c.zone_name}</strong></td>
            <td style={cellStyle}><span style={{ textTransform: 'capitalize' }}>{c.cycle_type}</span></td>
            <td style={cellStyle} className="tabular-nums">{c.start_date}</td>
            <td style={cellStyle} className="tabular-nums">{c.end_date}</td>
            <td style={cellStyle}><StatusBadge status={c.is_active ? 'Active' : 'Closed'} map={{ closed: 'info' }} /></td>
          </tr>
        ))}
      </DataTable>
      <CycleFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function CycleFormModal({ open, onClose }) {
  if (!open) return null;
  return <CycleFormContent onClose={onClose} />;
}

function CycleFormContent({ onClose }) {
  const [zoneId, setZoneId] = useState('');
  const [cycleType, setCycleType] = useState('monthly');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [error, setError] = useState('');
  const { data: zonesData } = useZonesList();
  const createCycle = useCreateCycle();
  const toast = useToast();
  const zones = zonesData?.data || [];

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!zoneId || !startDate || !endDate) { setError('Zone, start date, and end date are all required.'); return; }
    try {
      await createCycle.mutateAsync({ zone_id: parseInt(zoneId, 10), cycle_type: cycleType, start_date: startDate, end_date: endDate });
      toast.success('Collection cycle created.');
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={createCycle.isPending ? () => {} : onClose}
      title="Create Collection Cycle"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createCycle.isPending}>Cancel</Button>
          <Button type="submit" form="cycle-form" disabled={createCycle.isPending}>{createCycle.isPending ? 'Saving…' : 'Create Cycle'}</Button>
        </>
      }
    >
      <form id="cycle-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Zone</span>
          <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} style={inputStyle}>
            <option value="">Select a zone…</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Cycle type</span>
          <select value={cycleType} onChange={(e) => setCycleType(e.target.value)} style={inputStyle}>
            <option value="monthly">Monthly</option>
            <option value="weekly">Weekly</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <label style={fieldStyle}>
            <span style={labelStyle}>Start date</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>End date</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
          </label>
        </div>
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
