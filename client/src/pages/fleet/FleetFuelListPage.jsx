import React, { useState } from 'react';
import { Fuel, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, StatCard, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useFuelRecords, useCreateFuelRecord } from '../../hooks/useFleet.js';
import { useTrucks } from '../../hooks/useTrucks.js';

export default function FleetFuelListPage() {
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const { data, isLoading, error, refetch } = useFuelRecords({ q: search || undefined });
  const records = data?.data || [];
  const totalCost = records.reduce((sum, r) => sum + parseFloat(r.cost), 0);
  const totalLiters = records.reduce((sum, r) => sum + parseFloat(r.liters), 0);

  return (
    <div>
      <PageHeader
        icon={Fuel}
        title="Fleet Fuel"
        subtitle="Fuel fill-up records. Records are permanent — a correction is a new record."
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>Log Fuel</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Total Records" value={error ? '—' : records.length} icon={Fuel} />
        <StatCard label="Total Cost" value={error ? '—' : totalCost.toFixed(2)} icon={Fuel} />
        <StatCard label="Total Liters" value={error ? '—' : totalLiters.toFixed(2)} icon={Fuel} />
      </div>

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search notes…" />

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && records.length === 0}
        emptyTitle="No fuel records"
        columns={[{ label: 'Truck' }, { label: 'Date' }, { label: 'Liters' }, { label: 'Cost' }, { label: 'Odometer' }, { label: 'Review' }]}
      >
        {records.map((r) => (
          <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}><strong>{r.plate_number}</strong></td>
            <td style={cellStyle}>{new Date(r.record_date).toLocaleDateString()}</td>
            <td style={cellStyle} className="tabular-nums">{parseFloat(r.liters).toFixed(2)}</td>
            <td style={cellStyle} className="tabular-nums">{parseFloat(r.cost).toFixed(2)}</td>
            <td style={cellStyle} className="tabular-nums">{r.odometer_reading ?? '—'}</td>
            <td style={cellStyle}>{r.needs_review && <StatusBadge status="Review" map={{ review: 'warning' }} />}</td>
          </tr>
        ))}
      </DataTable>

      <FuelFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function FuelFormModal({ open, onClose }) {
  const [truckId, setTruckId] = useState('');
  const [liters, setLiters] = useState('');
  const [cost, setCost] = useState('');
  const [odometer, setOdometer] = useState('');
  const [recordDate, setRecordDate] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const { data: trucksData } = useTrucks({ status: 'all' });
  const create = useCreateFuelRecord();
  const toast = useToast();
  const trucks = trucksData?.data || [];

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const litersVal = parseFloat(liters);
    const costVal = parseFloat(cost);
    if (!truckId) { setError('Truck is required.'); return; }
    if (isNaN(litersVal) || litersVal <= 0) { setError('Liters must be a positive number.'); return; }
    if (isNaN(costVal) || costVal <= 0) { setError('Cost must be a positive number.'); return; }
    try {
      const result = await create.mutateAsync({
        truck_id: parseInt(truckId, 10), liters: litersVal, cost: costVal,
        odometer_reading: odometer ? parseInt(odometer, 10) : undefined,
        record_date: recordDate || undefined, notes: notes.trim() || undefined,
      });
      toast.success(result.data.needs_review ? 'Fuel record logged — odometer reading is lower than the last one, flagged for review.' : 'Fuel record logged.');
      setTruckId(''); setLiters(''); setCost(''); setOdometer(''); setRecordDate(''); setNotes('');
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={create.isPending ? () => {} : onClose}
      title="Log Fuel"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button>
        <Button type="submit" form="fuel-form" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Log Fuel'}</Button>
      </>}
    >
      <form id="fuel-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Truck</span>
          <select value={truckId} onChange={(e) => setTruckId(e.target.value)} style={inputStyle}>
            <option value="">Select a truck…</option>
            {trucks.map((t) => <option key={t.id} value={t.id}>{t.plate_number}{t.model ? ` — ${t.model}` : ''}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Liters</span>
          <input type="number" min="0.01" step="0.01" value={liters} onChange={(e) => setLiters(e.target.value)} style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Cost</span>
          <input type="number" min="0.01" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Odometer reading (optional)</span>
          <input type="number" min="0" step="1" value={odometer} onChange={(e) => setOdometer(e.target.value)} style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Date</span>
          <input type="date" value={recordDate} onChange={(e) => setRecordDate(e.target.value)} style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Notes (optional)</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle} />
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
