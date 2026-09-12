import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardList, ShoppingCart, Pencil, X } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, ConfirmDialog, Modal, useToast } from '../../components/ui/index.js';
import { useProcurementRequest, useSetRequestStatus, useCancelRequest, useUpdateProcurementRequest } from '../../hooks/useProcurement.js';
import { useSuppliers, useCreatePurchaseOrder } from '../../hooks/useProcurement.js';

const STATUS_MAP = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'info' };

export default function ProcurementRequestDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useProcurementRequest(id);
  const setStatus = useSetRequestStatus();
  const cancelMutation = useCancelRequest();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [poFormOpen, setPoFormOpen] = useState(false);
  // User-requested gap-audit sweep ('sii wad'): useUpdateProcurementRequest()
  // already existed in useProcurement.js, fully wired to the backend (PUT
  // /v2/procurement/requests/:id — editable while pending only, by the
  // original requester or an authorized zone approver, matching this
  // page's own Approve/Reject/Cancel gate), but nothing here ever called
  // it — a typo in the reason or a wrong quantity/price had no fix short
  // of cancelling and resubmitting the whole request.
  const [editOpen, setEditOpen] = useState(false);
  const request = data?.data;

  if (isLoading) return <LoadingState label="Loading procurement request…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!request) return null;

  async function handleDecision(status) {
    try {
      await setStatus.mutateAsync({ id: request.id, status });
      toast.success(`Request ${status}.`);
      refetch();
    } catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }
  async function handleCancel(reason) {
    try {
      await cancelMutation.mutateAsync({ id: request.id, reason });
      toast.success('Request cancelled.');
      setCancelOpen(false);
      refetch();
    } catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }

  return (
    <div>
      <button onClick={() => navigate('/procurement/requests')} style={backLinkStyle}><ArrowLeft size={14} /> Back to Requests</button>
      <PageHeader
        icon={ClipboardList}
        title={request.request_number}
        subtitle={`Zone: ${request.zone_name || request.zone_id}`}
        actions={
          <div style={{ display: 'flex', gap: '8px' }}>
            {request.status === 'pending' && (
              <>
                <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>Edit</Button>
                <Button onClick={() => handleDecision('approved')} disabled={setStatus.isPending}>Approve</Button>
                <Button variant="danger" onClick={() => handleDecision('rejected')} disabled={setStatus.isPending}>Reject</Button>
                <Button variant="secondary" onClick={() => setCancelOpen(true)}>Cancel</Button>
              </>
            )}
            {request.status === 'approved' && (
              <Button icon={ShoppingCart} onClick={() => setPoFormOpen(true)}>Create Purchase Order</Button>
            )}
          </div>
        }
      />
      <div style={{ marginBottom: '16px' }}><StatusBadge status={request.status} map={STATUS_MAP} /></div>
      <DetailGrid items={[
        { label: 'Priority', value: <span style={{ textTransform: 'capitalize' }}>{request.priority}</span> },
        { label: 'Reason', value: request.reason },
        { label: 'Requested', value: new Date(request.created_at).toLocaleDateString() },
      ]} />

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <Label>Items</Label>
        {request.items.map((item) => (
          <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
            <span>{item.item_name} × {item.quantity}</span>
            <span className="tabular-nums">{parseFloat(item.estimated_unit_price).toFixed(2)}</span>
          </div>
        ))}
      </Card>

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => handleCancel(document.getElementById('cancel-request-reason')?.value)}
        title="Cancel this procurement request?"
        message={<span style={{ display: 'block' }}>This cannot be undone.<input id="cancel-request-reason" placeholder="Reason for cancellation" style={{ ...inputStyle, marginTop: '10px' }} /></span>}
        confirmLabel="Cancel Request"
        danger
        isLoading={cancelMutation.isPending}
      />

      <CreatePoModal open={poFormOpen} onClose={() => setPoFormOpen(false)} request={request} />
      <EditRequestModal open={editOpen} onClose={() => setEditOpen(false)} request={request} onDone={refetch} />
    </div>
  );
}

function EditRequestModal({ open, onClose, request, onDone }) {
  const [priority, setPriority] = useState(request.priority);
  const [reason, setReason] = useState(request.reason);
  const [items, setItems] = useState(() => request.items.map((it) => ({
    item_name: it.item_name, quantity: String(it.quantity), estimated_unit_price: String(it.estimated_unit_price),
  })));
  const [error, setError] = useState('');
  const update = useUpdateProcurementRequest();
  const toast = useToast();

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
    if (items.length === 0) { setError('At least one item is required.'); return; }
    for (const it of items) {
      if (!it.item_name.trim()) { setError('Every item needs a name.'); return; }
      if (!(parseInt(it.quantity, 10) > 0)) { setError('Every item quantity must be greater than 0.'); return; }
    }
    try {
      await update.mutateAsync({
        id: request.id, priority, reason: reason.trim(),
        items: items.map((it) => ({ item_name: it.item_name.trim(), quantity: parseInt(it.quantity, 10), estimated_unit_price: parseFloat(it.estimated_unit_price) || 0 })),
      });
      toast.success('Request updated.');
      onDone?.();
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={update.isPending ? () => {} : onClose}
      title="Edit Procurement Request"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={update.isPending}>Cancel</Button>
        <Button type="submit" form="edit-procurement-request-form" disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save Changes'}</Button>
      </>}
    >
      <form id="edit-procurement-request-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={inputStyle}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </label>
        <label style={fieldStyle}><span style={labelStyle}>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} /></label>
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

function CreatePoModal({ open, onClose, request }) {
  const [supplierId, setSupplierId] = useState('');
  const [error, setError] = useState('');
  const { data: suppliersData } = useSuppliers({ status: 'active' });
  const create = useCreatePurchaseOrder();
  const toast = useToast();
  const navigate = useNavigate();
  const suppliers = suppliersData?.data || [];

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!supplierId) { setError('Supplier is required.'); return; }
    try {
      const result = await create.mutateAsync({
        procurement_request_id: request.id, supplier_id: parseInt(supplierId, 10),
        items: request.items.map((it) => ({ procurement_request_item_id: it.id, item_name: it.item_name, quantity: it.quantity, unit_price: it.estimated_unit_price })),
      });
      toast.success(`${result.data.po_number} created.`);
      onClose();
      navigate(`/procurement/purchase-orders/${result.data.id}`);
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={create.isPending ? () => {} : onClose}
      title="Create Purchase Order"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button>
        <Button type="submit" form="create-po-form" disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create PO'}</Button>
      </>}
    >
      <form id="create-po-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
          The purchase order will be created with this request's own items and estimated prices — adjust unit prices afterward while the PO is still in draft.
        </p>
        <label style={fieldStyle}>
          <span style={labelStyle}>Supplier (active only)</span>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} style={inputStyle}>
            <option value="">Select a supplier…</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function Label({ children }) {
  return <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{children}</span>;
}

const backLinkStyle = { display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = { padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit' };
