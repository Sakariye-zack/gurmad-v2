import React, { useState } from 'react';
import { Wrench, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, FilterBar, StatCard, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useMaintenanceRecords, useCreateMaintenanceRecord } from '../../hooks/useFleet.js';
import { useTrucks } from '../../hooks/useTrucks.js';

export default function FleetMaintenanceListPage() {
  const [search, setSearch] = useState('');
  const [upcomingOnly, setUpcomingOnly] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const { data, isLoading, error, refetch } = useMaintenanceRecords({ q: search || undefined, upcoming_service: upcomingOnly || undefined });
  const records = data?.data || [];
  const totalCost = records.reduce((sum, r) => sum + parseFloat(r.cost), 0);

  return (
    <div>
      <PageHeader
        icon={Wrench}
        title="Fleet Maintenance"
        subtitle="Vehicle maintenance and repair history. Records are permanent — a correction is a new record."
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>Log Maintenance</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Total Records" value={error ? '—' : records.length} icon={Wrench} />
        <StatCard label="Total Cost" value={error ? '—' : totalCost.toFixed(2)} icon={Wrench} />
      </div>

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search description or provider…">
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 700 }}>
          <input type="checkbox" checked={upcomingOnly} onChange={(e) => setUpcomingOnly(e.target.checked)} />
          Upcoming service only
        </label>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && records.length === 0}
        emptyTitle="No maintenance records"
        columns={[{ label: 'Truck' }, { label: 'Description' }, { label: 'Cost' }, { label: 'Next Service' }, { label: 'Provider' }, { label: 'Logged' }]}
      >
        {records.map((r) => (
          <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}><strong>{r.plate_number}</strong></td>
            <td style={cellStyle}>{r.description}</td>
            <td style={cellStyle} className="tabular-nums">{parseFloat(r.cost).toFixed(2)}</td>
            <td style={cellStyle} className="tabular-nums">{r.next_service_date ? new Date(r.next_service_date).toLocaleDateString() : '—'}</td>
            <td style={cellStyle}>{r.provider || '—'}</td>
            <td style={cellStyle}>{new Date(r.created_at).toLocaleDateString()}</td>
          </tr>
        ))}
      </DataTable>

      <MaintenanceFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function MaintenanceFormModal({ open, onClose }) {
  const [truckId, setTruckId] = useState('');
  const [description, setDescription] = useState('');
  const [cost, setCost] = useState('');
  const [nextServiceDate, setNextServiceDate] = useState('');
  const [provider, setProvider] = useState('');
  const [error, setError] = useState('');
  const { data: trucksData } = useTrucks({ status: 'all' });
  const create = useCreateMaintenanceRecord();
  const toast = useToast();
  const trucks = trucksData?.data || [];

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const costVal = parseFloat(cost);
    if (!truckId) { setError('Truck is required.'); return; }
    if (!description.trim()) { setError('Description is required.'); return; }
    if (isNaN(costVal) || costVal <= 0) { setError('Cost must be a positive number.'); return; }
    try {
      await create.mutateAsync({
        truck_id: parseInt(truckId, 10), description: description.trim(), cost: costVal,
        next_service_date: nextServiceDate || undefined, provider: provider.trim() || undefined,
      });
      toast.success('Maintenance record logged.');
      setTruckId(''); setDescription(''); setCost(''); setNextServiceDate(''); setProvider('');
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={create.isPending ? () => {} : onClose}
      title="Log Maintenance"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button>
        <Button type="submit" form="maintenance-form" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Log Maintenance'}</Button>
      </>}
    >
      <form id="maintenance-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Truck</span>
          <select value={truckId} onChange={(e) => setTruckId(e.target.value)} style={inputStyle}>
            <option value="">Select a truck…</option>
            {trucks.map((t) => <option key={t.id} value={t.id}>{t.plate_number}{t.model ? ` — ${t.model}` : ''}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Cost</span>
          <input type="number" min="0.01" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Next service date (optional)</span>
          <input type="date" value={nextServiceDate} onChange={(e) => setNextServiceDate(e.target.value)} style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Provider (optional)</span>
          <input value={provider} onChange={(e) => setProvider(e.target.value)} style={inputStyle} />
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
