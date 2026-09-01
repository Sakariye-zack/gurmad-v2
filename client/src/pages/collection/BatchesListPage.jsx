import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, StatCard, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import CapacityPanel from '../../components/collection/CapacityPanel.jsx';
import { useBatches, useCreateBatch, useCycles } from '../../hooks/useCollectionOps.js';
import { useZonesList, useCustomers } from '../../hooks/useCustomers.js';

const STATUS_LABELS = { draft: 'Draft', assigned: 'Assigned', in_progress: 'In Progress', partially_completed: 'Partially Completed', completed: 'Completed', cancelled: 'Cancelled' };

export default function BatchesListPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useBatches({ status: statusFilter || undefined });
  const batches = data?.data || [];
  const inProgressCount = batches.filter((b) => b.status === 'in_progress').length;
  const draftCount = batches.filter((b) => b.status === 'draft').length;

  return (
    <div>
      <PageHeader
        icon={ClipboardList}
        title="Batches"
        subtitle="Collection batches — customer groups scheduled for a cycle."
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>Create Batch</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Total Batches" value={error ? '—' : (data?.data?.length ?? '—')} icon={ClipboardList} />
        <StatCard label="In Progress" value={error ? '—' : inProgressCount} icon={ClipboardList} accent="var(--info)" />
        <StatCard label="Draft" value={error ? '—' : draftCount} icon={ClipboardList} accent="var(--warning)" />
      </div>

      <FilterBar searchValue="" onSearchChange={() => {}} searchPlaceholder="">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && batches.length === 0}
        emptyTitle="No batches yet"
        emptySubtitle="Create the first batch to start assigning collection work."
        columns={[{ label: 'Batch' }, { label: 'Zone' }, { label: 'Type' }, { label: 'Customers' }, { label: 'Capacity' }, { label: 'Status' }]}
      >
        {batches.map((b) => (
          <tr key={b.id} onClick={() => navigate(`/collection-cycles/batches/${b.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong>{b.batch_code}</strong></td>
            <td style={cellStyle}>{b.zone_name}</td>
            <td style={cellStyle}>
              <span style={{ textTransform: 'capitalize' }}>{b.customer_type}</span>
              {b.commercial_shift && <span style={{ color: 'var(--text-muted)' }}> ({b.commercial_shift})</span>}
            </td>
            <td style={cellStyle} className="tabular-nums">{b.total_customers}</td>
            <td style={cellStyle}><CapacityPanel capacity={b.capacity} compact /></td>
            <td style={cellStyle}><StatusBadge status={STATUS_LABELS[b.status]} map={{ draft: 'info', assigned: 'warning', 'in progress': 'warning', 'partially completed': 'warning', completed: 'success', cancelled: 'danger' }} /></td>
          </tr>
        ))}
      </DataTable>

      <BatchFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function BatchFormModal({ open, onClose }) {
  if (!open) return null;
  return <BatchFormContent onClose={onClose} />;
}

function BatchFormContent({ onClose }) {
  const [zoneId, setZoneId] = useState('');
  const [cycleId, setCycleId] = useState('');
  const [customerType, setCustomerType] = useState('residential');
  const [shift, setShift] = useState('day');
  const [startDate, setStartDate] = useState('');
  const [selectedCustomers, setSelectedCustomers] = useState([]);
  const [error, setError] = useState('');
  const { data: zonesData } = useZonesList();
  const { data: cyclesData } = useCycles({ is_active: true });
  // Only allow selecting customers once a zone is chosen — a batch's
  // customers must belong to its own zone (found and fixed during Module 5
  // browser QA, alongside the matching backend check). useCustomers has no
  // `enabled` gate of its own, so the empty-zone case is handled by simply
  // not rendering any options below, not by skipping the fetch.
  const { data: customersData } = useCustomers({ zone_id: zoneId || undefined, customer_type: customerType });
  const createBatch = useCreateBatch();
  const toast = useToast();
  const zones = zonesData?.data || [];
  const cycles = (cyclesData?.data || []).filter((c) => !zoneId || String(c.zone_id) === zoneId);
  const eligibleCustomers = zoneId ? (customersData?.data || []) : [];

  function toggleCustomer(id) {
    setSelectedCustomers((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!zoneId || !cycleId || !startDate) { setError('Zone, cycle, and start date are all required.'); return; }
    try {
      const result = await createBatch.mutateAsync({
        zone_id: parseInt(zoneId, 10), cycle_id: parseInt(cycleId, 10), customer_type: customerType,
        commercial_shift: customerType === 'commercial' ? shift : undefined, start_date: startDate,
        customer_ids: selectedCustomers,
      });
      toast.success(`${result.data.batch_code} created.`);
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={createBatch.isPending ? () => {} : onClose}
      title="Create Batch"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createBatch.isPending}>Cancel</Button>
          <Button type="submit" form="batch-form" disabled={createBatch.isPending}>{createBatch.isPending ? 'Saving…' : 'Create Batch'}</Button>
        </>
      }
    >
      <form id="batch-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Zone</span>
          <select value={zoneId} onChange={(e) => { setZoneId(e.target.value); setCycleId(''); setSelectedCustomers([]); }} style={inputStyle}>
            <option value="">Select a zone…</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Collection cycle</span>
          <select value={cycleId} onChange={(e) => setCycleId(e.target.value)} style={inputStyle} disabled={!zoneId}>
            <option value="">{zoneId ? 'Select a cycle…' : 'Select a zone first'}</option>
            {cycles.map((c) => <option key={c.id} value={c.id}>{c.cycle_type} — {c.start_date} to {c.end_date}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Customer type</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            {['residential', 'commercial'].map((t) => (
              <button type="button" key={t} onClick={() => setCustomerType(t)} style={{ flex: 1, padding: '9px', borderRadius: 'var(--radius-sm)', fontWeight: 700, fontSize: '13px', cursor: 'pointer', textTransform: 'capitalize', border: `1px solid ${customerType === t ? 'var(--brand)' : 'var(--border)'}`, background: customerType === t ? 'var(--success-bg)' : 'var(--surface)', color: customerType === t ? 'var(--brand)' : 'var(--text-muted)' }}>{t}</button>
            ))}
          </div>
        </label>
        {customerType === 'commercial' && (
          <label style={fieldStyle}>
            <span style={labelStyle}>Commercial shift</span>
            <select value={shift} onChange={(e) => setShift(e.target.value)} style={inputStyle}>
              <option value="day">Day</option>
              <option value="night">Night</option>
            </select>
          </label>
        )}
        <label style={fieldStyle}>
          <span style={labelStyle}>Start date</span>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Customers ({selectedCustomers.length} selected)</span>
          <div style={{ maxHeight: '160px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px' }}>
            {!zoneId && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Select a zone to see eligible customers.</span>}
            {zoneId && eligibleCustomers.length === 0 && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No {customerType} customers in this zone.</span>}
            {eligibleCustomers.map((c) => (
              <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '13px' }}>
                <input type="checkbox" checked={selectedCustomers.includes(c.id)} onChange={() => toggleCustomer(c.id)} />
                {c.customer_number} — {c.business_name || c.name}
              </label>
            ))}
          </div>
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

const cellStyle = { padding: '12px 14px' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
