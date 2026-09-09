import React, { useState } from 'react';
import { ClipboardCheck, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useAdjustmentRequests, useCreateAdjustmentRequest, useSetAdjustmentStatus, useInventoryItems, useInventoryStores } from '../../hooks/useInventory.js';
import { useAuth } from '../../auth/AuthContext.jsx';

export default function InventoryAdjustmentsPage() {
  const [statusFilter, setStatusFilter] = useState('pending');
  const [formOpen, setFormOpen] = useState(false);
  const [rejectTarget, setRejectTarget] = useState(null);
  const { data, isLoading, error, refetch } = useAdjustmentRequests({ status: statusFilter || undefined });
  const setStatus = useSetAdjustmentStatus();
  const toast = useToast();
  const { user: currentUser } = useAuth();
  const requests = data?.data || [];

  async function approve(req) {
    try { await setStatus.mutateAsync({ id: req.id, status: 'approved' }); toast.success('Adjustment approved.'); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }

  return (
    <div>
      <PageHeader
        icon={ClipboardCheck}
        title="Stock Adjustments"
        subtitle="Pending adjustments require approval before affecting the ledger."
        actions={<RoleGate roles={['admin', 'gudoomiye']}><Button icon={Plus} onClick={() => setFormOpen(true)}>New Adjustment Request</Button></RoleGate>}
      />

      <FilterBar searchValue="" onSearchChange={() => {}} searchPlaceholder="">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading} error={error?.message} onRetry={refetch}
        isEmpty={!isLoading && !error && requests.length === 0}
        emptyTitle="No adjustment requests"
        columns={[{ label: 'Item' }, { label: 'Store' }, { label: 'Quantity' }, { label: 'Reason' }, { label: 'Requested By' }, { label: 'Status' }, { label: 'Actions' }]}
      >
        {requests.map((r) => {
          const isSelf = currentUser?.id && r.requested_by === currentUser.id;
          return (
            <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={cellStyle}>{r.item_name}</td>
              <td style={cellStyle}>{r.store_name}</td>
              <td style={cellStyle} className="tabular-nums" style2={{ color: r.requested_quantity < 0 ? 'var(--danger)' : 'var(--success)' }}>
                {r.requested_quantity > 0 ? `+${r.requested_quantity}` : r.requested_quantity}
              </td>
              <td style={cellStyle}>{r.reason}</td>
              <td style={cellStyle}>{r.requested_by_name || r.requested_by}</td>
              <td style={cellStyle}><StatusBadge status={r.status} map={{ pending: 'warning', approved: 'success', rejected: 'danger' }} /></td>
              <td style={cellStyle}>
                {r.status === 'pending' && (
                  <RoleGate roles={['admin', 'gudoomiye']}>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <Button
                        variant="secondary"
                        disabled={isSelf || setStatus.isPending}
                        title={isSelf ? 'You cannot approve your own request.' : undefined}
                        onClick={() => approve(r)}
                      >Approve</Button>
                      <Button
                        variant="danger"
                        disabled={isSelf || setStatus.isPending}
                        title={isSelf ? 'You cannot reject your own request.' : undefined}
                        onClick={() => setRejectTarget(r)}
                      >Reject</Button>
                    </div>
                  </RoleGate>
                )}
              </td>
            </tr>
          );
        })}
      </DataTable>

      <NewAdjustmentModal open={formOpen} onClose={() => setFormOpen(false)} />
      <RejectModal request={rejectTarget} onClose={() => setRejectTarget(null)} />
    </div>
  );
}

function NewAdjustmentModal({ open, onClose }) {
  const [itemId, setItemId] = useState(''); const [storeId, setStoreId] = useState(''); const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState(''); const [error, setError] = useState('');
  const { data: itemsData } = useInventoryItems({ status: 'active' });
  const { data: storesData } = useInventoryStores({ status: 'active' });
  const create = useCreateAdjustmentRequest();
  const toast = useToast();
  const items = itemsData?.data || [];
  const stores = storesData?.data || [];
  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault(); setError('');
    if (!itemId || !storeId) { setError('Item and store are required.'); return; }
    const q = parseInt(quantity, 10);
    if (!q || q === 0) { setError('Quantity must be a non-zero number (positive to add, negative to remove).'); return; }
    if (!reason.trim()) { setError('Reason is required.'); return; }
    try {
      await create.mutateAsync({ item_id: parseInt(itemId, 10), store_id: parseInt(storeId, 10), requested_quantity: q, reason: reason.trim() });
      toast.success('Adjustment request submitted.'); setItemId(''); setStoreId(''); setQuantity(''); setReason(''); onClose();
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }

  return (
    <Modal open onClose={create.isPending ? () => {} : onClose} title="New Adjustment Request"
      footer={<><Button variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button><Button type="submit" form="adjustment-form" disabled={create.isPending}>{create.isPending ? 'Submitting…' : 'Submit'}</Button></>}>
      <form id="adjustment-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}><span style={labelStyle}>Item</span><select value={itemId} onChange={(e) => setItemId(e.target.value)} style={inputStyle}><option value="">Select an item…</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
        <label style={fieldStyle}><span style={labelStyle}>Store</span><select value={storeId} onChange={(e) => setStoreId(e.target.value)} style={inputStyle}><option value="">Select a store…</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label style={fieldStyle}><span style={labelStyle}>Quantity (positive to add, negative to remove)</span><input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} /></label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function RejectModal({ request, onClose }) {
  const [reason, setReason] = useState(''); const [error, setError] = useState('');
  const setStatus = useSetAdjustmentStatus();
  const toast = useToast();
  if (!request) return null;

  async function handleSubmit(e) {
    e.preventDefault(); setError('');
    if (!reason.trim()) { setError('A rejection reason is required.'); return; }
    try {
      await setStatus.mutateAsync({ id: request.id, status: 'rejected', rejected_reason: reason.trim() });
      toast.success('Adjustment rejected.'); setReason(''); onClose();
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }

  return (
    <Modal open onClose={setStatus.isPending ? () => {} : onClose} title="Reject Adjustment Request"
      footer={<><Button variant="secondary" onClick={onClose} disabled={setStatus.isPending}>Cancel</Button><Button variant="danger" type="submit" form="reject-form" disabled={setStatus.isPending}>{setStatus.isPending ? 'Rejecting…' : 'Reject'}</Button></>}>
      <form id="reject-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}><span style={labelStyle}>Rejection reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} /></label>
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
