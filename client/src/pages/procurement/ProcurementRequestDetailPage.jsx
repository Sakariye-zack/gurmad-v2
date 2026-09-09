import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ClipboardList, ShoppingCart } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, ConfirmDialog, Modal, useToast } from '../../components/ui/index.js';
import { useProcurementRequest, useSetRequestStatus, useCancelRequest } from '../../hooks/useProcurement.js';
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
    </div>
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
