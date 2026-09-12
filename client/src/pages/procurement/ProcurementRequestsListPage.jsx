import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Plus, X } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, Modal, useToast } from '../../components/ui/index.js';
import { useProcurementRequests, useCreateProcurementRequest } from '../../hooks/useProcurement.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useZonesList } from '../../hooks/useCustomers.js';

const STATUS_MAP = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'info' };
const PRIORITY_MAP = { low: 'info', normal: 'info', high: 'warning' };

export default function ProcurementRequestsListPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useProcurementRequests({ status: statusFilter || undefined, q: search || undefined });
  const requests = data?.data || [];

  return (
    <div>
      <PageHeader
        icon={ClipboardList}
        title="Procurement Requests"
        subtitle="Requests for goods and services, subject to approval before ordering."
        actions={<Button icon={Plus} onClick={() => setFormOpen(true)}>New Request</Button>}
      />

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search request number or reason…">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && requests.length === 0}
        emptyTitle="No procurement requests"
        columns={[{ label: 'Number' }, { label: 'Zone' }, { label: 'Priority' }, { label: 'Reason' }, { label: 'Status' }]}
      >
        {requests.map((r) => (
          <tr key={r.id} onClick={() => navigate(`/procurement/requests/${r.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong>{r.request_number}</strong></td>
            <td style={cellStyle}>{r.zone_name}</td>
            <td style={cellStyle}><StatusBadge status={r.priority} map={PRIORITY_MAP} /></td>
            <td style={cellStyle}>{r.reason}</td>
            <td style={cellStyle}><StatusBadge status={r.status} map={STATUS_MAP} /></td>
          </tr>
        ))}
      </DataTable>

      <RequestFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function RequestFormModal({ open, onClose }) {
  const [priority, setPriority] = useState('normal');
  const [reason, setReason] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [items, setItems] = useState([{ item_name: '', quantity: '1', estimated_unit_price: '0' }]);
  const [error, setError] = useState('');
  const create = useCreateProcurementRequest();
  const toast = useToast();
  // User-reported gap-audit sweep ('sii wad'): the backend requires
  // zone_id for an admin submitter (it's auto-derived server-side for a
  // zone-scoped role like gudoomiye, exactly like every other CLOSED
  // module's own resolveUserZoneId() pattern) — this form never asked
  // for it at all, so an admin could NEVER submit a request; every
  // attempt failed with 'zone_id is required for Admin.' Found live
  // while testing an unrelated feature (Receive into Inventory).
  const { user } = useAuth();
  const isZoneScoped = ['gudoomiye', 'zone_accountant'].includes((user?.role || '').toLowerCase());
  const { data: zonesData } = useZonesList();
  const zones = zonesData?.data || [];

  if (!open) return null;

  function updateItem(i, field, value) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, [field]: value } : it)));
  }
  function addItem() { setItems((prev) => [...prev, { item_name: '', quantity: '1', estimated_unit_price: '0' }]); }
  function removeItem(i) { setItems((prev) => prev.filter((_, idx) => idx !== i)); }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!reason.trim()) { setError('Reason is required.'); return; }
    if (!isZoneScoped && !zoneId) { setError('Select a zone.'); return; }
    if (items.length === 0) { setError('At least one item is required.'); return; }
    for (const it of items) {
      if (!it.item_name.trim()) { setError('Every item needs a name.'); return; }
      if (!(parseInt(it.quantity, 10) > 0)) { setError('Every item quantity must be greater than 0.'); return; }
    }
    try {
      await create.mutateAsync({
        priority, reason: reason.trim(),
        // zone_id: only sent for a non-zone-scoped submitter (admin) —
        // a zone-scoped role's own zone is always server-derived and
        // silently ignores/overrides a client-supplied value anyway
        // (resolveUserZoneId, same pattern every other closed module
        // uses), so sending it there would just be dead weight.
        zone_id: isZoneScoped ? undefined : parseInt(zoneId, 10),
        items: items.map((it) => ({ item_name: it.item_name.trim(), quantity: parseInt(it.quantity, 10), estimated_unit_price: parseFloat(it.estimated_unit_price) || 0 })),
      });
      toast.success('Procurement request submitted.');
      setPriority('normal'); setReason(''); setZoneId(''); setItems([{ item_name: '', quantity: '1', estimated_unit_price: '0' }]);
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={create.isPending ? () => {} : onClose}
      title="New Procurement Request"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button>
        <Button type="submit" form="procurement-request-form" disabled={create.isPending}>{create.isPending ? 'Submitting…' : 'Submit Request'}</Button>
      </>}
    >
      <form id="procurement-request-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={inputStyle}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </label>
        <label style={fieldStyle}><span style={labelStyle}>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} /></label>
        {!isZoneScoped && (
          <label style={fieldStyle}>
            <span style={labelStyle}>Zone</span>
            <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} style={inputStyle}>
              <option value="">Select a zone…</option>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </label>
        )}
        <span style={labelStyle}>Items</span>
        {items.map((it, i) => (
          <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <input placeholder="Item name" value={it.item_name} onChange={(e) => updateItem(i, 'item_name', e.target.value)} style={{ ...inputStyle, flex: 2 }} />
            <input type="number" min="1" placeholder="Qty" value={it.quantity} onChange={(e) => updateItem(i, 'quantity', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            <input type="number" min="0" step="0.01" placeholder="Est. price" value={it.estimated_unit_price} onChange={(e) => updateItem(i, 'estimated_unit_price', e.target.value)} style={{ ...inputStyle, flex: 1 }} />
            {items.length > 1 && <button type="button" onClick={() => removeItem(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}><X size={16} /></button>}
          </div>
        ))}
        <Button type="button" variant="secondary" onClick={addItem}>Add Item</Button>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

const cellStyle = { padding: '12px 14px' };
const selectStyle = { padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '13px' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = { padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit' };
