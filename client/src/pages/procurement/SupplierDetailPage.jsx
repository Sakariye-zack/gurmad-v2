import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Building2, Pencil } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useSupplier, useUpdateSupplier, useSetSupplierStatus } from '../../hooks/useProcurement.js';
import { usePurchaseOrders } from '../../hooks/useProcurement.js';

export default function SupplierDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useSupplier(id);
  const { data: poData } = usePurchaseOrders({ supplier_id: id });
  const [editOpen, setEditOpen] = useState(false);
  const setStatus = useSetSupplierStatus();
  const supplier = data?.data;
  const pos = poData?.data || [];

  if (isLoading) return <LoadingState label="Loading supplier…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!supplier) return null;

  async function toggleStatus() {
    try {
      await setStatus.mutateAsync({ id: supplier.id, status: supplier.status === 'active' ? 'inactive' : 'active' });
      toast.success(`Supplier is now ${supplier.status === 'active' ? 'inactive' : 'active'}.`);
    } catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }

  return (
    <div>
      <button onClick={() => navigate('/procurement/suppliers')} style={backLinkStyle}><ArrowLeft size={14} /> Back to Suppliers</button>
      <PageHeader
        icon={Building2}
        title={supplier.name}
        subtitle={supplier.category || 'Supplier'}
        actions={
          <RoleGate roles={['admin']}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>Edit</Button>
              <Button variant={supplier.status === 'active' ? 'danger' : 'primary'} onClick={toggleStatus} disabled={setStatus.isPending}>
                {supplier.status === 'active' ? 'Deactivate' : 'Activate'}
              </Button>
            </div>
          </RoleGate>
        }
      />
      <div style={{ marginBottom: '16px' }}><StatusBadge status={supplier.status} map={{ active: 'success', inactive: 'info' }} /></div>
      <DetailGrid items={[
        { label: 'Contact', value: supplier.contact || '—' },
        { label: 'Phone', value: supplier.phone || '—' },
        { label: 'Email', value: supplier.email || '—' },
        { label: 'Address', value: supplier.address || '—' },
        { label: 'Category', value: supplier.category || '—' },
      ]} />

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <Label>Purchase Orders</Label>
        {pos.length === 0 && <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>No purchase orders for this supplier.</p>}
        {pos.map((po) => (
          <div key={po.id} onClick={() => navigate(`/procurement/purchase-orders/${po.id}`)} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px', cursor: 'pointer' }}>
            <span>{po.po_number}</span>
            <span className="tabular-nums">{parseFloat(po.total_amount).toFixed(2)}</span>
          </div>
        ))}
      </Card>

      <SupplierEditModal open={editOpen} onClose={() => setEditOpen(false)} supplier={supplier} />
    </div>
  );
}

function SupplierEditModal({ open, onClose, supplier }) {
  const [name, setName] = useState(supplier.name);
  const [contact, setContact] = useState(supplier.contact || '');
  const [phone, setPhone] = useState(supplier.phone || '');
  const [email, setEmail] = useState(supplier.email || '');
  const [address, setAddress] = useState(supplier.address || '');
  const [category, setCategory] = useState(supplier.category || '');
  const [error, setError] = useState('');
  const update = useUpdateSupplier();
  const toast = useToast();

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('Name is required.'); return; }
    try {
      await update.mutateAsync({ id: supplier.id, name: name.trim(), contact, phone, email, address, category });
      toast.success('Supplier updated.');
      onClose();
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }

  return (
    <Modal
      open
      onClose={update.isPending ? () => {} : onClose}
      title="Edit Supplier"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={update.isPending}>Cancel</Button>
        <Button type="submit" form="supplier-edit-form" disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <form id="supplier-edit-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}><span style={labelStyle}>Name</span><input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Contact</span><input value={contact} onChange={(e) => setContact(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Phone</span><input value={phone} onChange={(e) => setPhone(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Email</span><input value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Address</span><input value={address} onChange={(e) => setAddress(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Category</span><input value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle} /></label>
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
