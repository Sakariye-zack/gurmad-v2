import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ShoppingCart, PackageCheck } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, ConfirmDialog, Modal, useToast } from '../../components/ui/index.js';
import { usePurchaseOrder, useOrderPurchaseOrder, useCancelPurchaseOrder, usePurchaseOrderReceipts, useCreateReceipt } from '../../hooks/useProcurement.js';

const STATUS_MAP = { draft: 'info', ordered: 'warning', partially_received: 'warning', received: 'success', cancelled: 'danger' };

export default function PurchaseOrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, isLoading, error, refetch } = usePurchaseOrder(id);
  const { data: receiptsData, refetch: refetchReceipts } = usePurchaseOrderReceipts(id);
  const orderMutation = useOrderPurchaseOrder();
  const cancelMutation = useCancelPurchaseOrder();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const po = data?.data;
  const receipts = receiptsData?.data || [];

  if (isLoading) return <LoadingState label="Loading purchase order…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!po) return null;

  async function handleOrder() {
    try { await orderMutation.mutateAsync(po.id); toast.success('Purchase order placed.'); refetch(); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }
  async function handleCancel(reason) {
    try { await cancelMutation.mutateAsync({ id: po.id, reason }); toast.success('Purchase order cancelled.'); setCancelOpen(false); refetch(); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }

  const canCancel = ['draft', 'ordered', 'partially_received'].includes(po.status);
  const canReceive = ['ordered', 'partially_received'].includes(po.status);

  return (
    <div>
      <button onClick={() => navigate('/procurement/purchase-orders')} style={backLinkStyle}><ArrowLeft size={14} /> Back to Purchase Orders</button>
      <PageHeader
        icon={ShoppingCart}
        title={po.po_number}
        subtitle={`Supplier: ${po.supplier?.name || ''}`}
        actions={
          <div style={{ display: 'flex', gap: '8px' }}>
            {po.status === 'draft' && <Button onClick={handleOrder} disabled={orderMutation.isPending}>Place Order</Button>}
            {canReceive && <Button icon={PackageCheck} variant="secondary" onClick={() => setReceiveOpen(true)}>Record Receipt</Button>}
            {canCancel && <Button variant="danger" onClick={() => setCancelOpen(true)}>Cancel</Button>}
          </div>
        }
      />
      <div style={{ marginBottom: '16px' }}><StatusBadge status={po.status} map={STATUS_MAP} /></div>
      <DetailGrid items={[
        { label: 'Total', value: parseFloat(po.total_amount).toFixed(2), className: 'tabular-nums' },
        { label: 'Request', value: po.request_number },
        { label: 'Supplier Status', value: <StatusBadge status={po.supplier?.status} map={{ active: 'success', inactive: 'info' }} /> },
      ]} />

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <Label>Items</Label>
        {po.items.map((item) => (
          <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
            <span>{item.item_name} — ordered {item.quantity}, received {item.received_quantity}, remaining {item.remaining_quantity}
              {item.needs_review && <span style={{ marginLeft: '8px' }}><StatusBadge status="Review" map={{ review: 'warning' }} /></span>}
            </span>
            <span className="tabular-nums">{parseFloat(item.line_total).toFixed(2)}</span>
          </div>
        ))}
      </Card>

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <Label>Receipt History</Label>
        {receipts.length === 0 && <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>No receipts recorded yet.</p>}
        {receipts.map((r) => (
          <div key={r.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
            <div>{new Date(r.received_at).toLocaleString()}</div>
            {r.items.map((it) => (
              <div key={it.id} style={{ color: 'var(--text-muted)', paddingLeft: '12px' }}>
                {it.item_name}: {it.quantity_received}{it.needs_review && <span style={{ marginLeft: '6px' }}><StatusBadge status="Review" map={{ review: 'warning' }} /></span>}
              </div>
            ))}
          </div>
        ))}
      </Card>

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={() => handleCancel(document.getElementById('cancel-po-reason')?.value)}
        title="Cancel this purchase order?"
        message={<span style={{ display: 'block' }}>Existing receipts remain unchanged and immutable.<input id="cancel-po-reason" placeholder="Reason for cancellation" style={{ ...inputStyle, marginTop: '10px' }} /></span>}
        confirmLabel="Cancel PO"
        danger
        isLoading={cancelMutation.isPending}
      />

      <ReceiveModal open={receiveOpen} onClose={() => setReceiveOpen(false)} po={po} onDone={() => { refetch(); refetchReceipts(); }} />
    </div>
  );
}

function ReceiveModal({ open, onClose, po, onDone }) {
  const [quantities, setQuantities] = useState({});
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const create = useCreateReceipt();
  const toast = useToast();

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const items = po.items
      .filter((it) => quantities[it.id] && parseInt(quantities[it.id], 10) > 0)
      .map((it) => ({ purchase_order_item_id: it.id, quantity_received: parseInt(quantities[it.id], 10) }));
    if (items.length === 0) { setError('Enter at least one received quantity.'); return; }
    try {
      const result = await create.mutateAsync({ id: po.id, notes: notes || undefined, items });
      const anyReview = result.data.items.some((i) => i.needs_review !== undefined);
      toast.success('Receipt recorded.');
      setQuantities({}); setNotes('');
      onDone();
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={create.isPending ? () => {} : onClose}
      title="Record Receipt"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button>
        <Button type="submit" form="receive-form" disabled={create.isPending}>{create.isPending ? 'Recording…' : 'Record Receipt'}</Button>
      </>}
    >
      <form id="receive-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {po.items.map((item) => (
          <label key={item.id} style={fieldStyle}>
            <span style={labelStyle}>{item.item_name} (ordered {item.quantity}, remaining {item.remaining_quantity})</span>
            <input type="number" min="0" step="1" value={quantities[item.id] || ''} onChange={(e) => setQuantities((prev) => ({ ...prev, [item.id]: e.target.value }))} style={inputStyle} />
          </label>
        ))}
        <label style={fieldStyle}><span style={labelStyle}>Notes (optional)</span><input value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle} /></label>
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
