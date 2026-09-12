import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Package, Pencil } from 'lucide-react';
import { PageHeader, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, Button, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useInventoryItem, useUpdateInventoryItem } from '../../hooks/useInventory.js';

// User-requested gap-audit sweep ('sii wad'): this screen was pure
// view-only — useUpdateInventoryItem() already existed in
// useInventory.js, fully wired to the backend (PUT /v2/inventory/
// items/:id, admin-only), but nothing here ever called it. A typo in
// an item's name, SKU, unit, or reorder level had no way to be fixed
// short of deleting and recreating it (Activate/Deactivate, on the
// list page, is the only inventory-item action that existed anywhere).
export default function InventoryItemDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const { data, isLoading, error, refetch } = useInventoryItem(id);
  const item = data?.data;

  if (isLoading) return <LoadingState label="Loading item…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!item) return null;

  return (
    <div>
      <button onClick={() => navigate('/inventory/items')} style={backLinkStyle}><ArrowLeft size={14} /> Back to Items</button>
      <PageHeader
        icon={Package}
        title={item.name}
        subtitle={item.category || 'Inventory item'}
        actions={
          <RoleGate roles={['admin']}>
            <Button icon={Pencil} variant="secondary" onClick={() => setEditOpen(true)}>Edit</Button>
          </RoleGate>
        }
      />
      <div style={{ marginBottom: '16px' }}><StatusBadge status={item.status} map={{ active: 'success', inactive: 'info' }} /></div>
      <DetailGrid items={[
        { label: 'SKU', value: item.sku || '—' },
        { label: 'Unit of measure', value: item.unit_of_measure },
        { label: 'Reorder level', value: item.reorder_level ?? '—' },
        { label: 'Description', value: item.description || '—' },
        { label: 'Total stock (all stores)', value: item.stock?.total_balance ?? 0, className: 'tabular-nums' },
      ]} />
      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <Label>Stock by Store</Label>
        {(item.stock?.per_store || []).length === 0 && <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>No stock recorded for this item yet.</p>}
        {(item.stock?.per_store || []).map((row) => (
          <div key={row.store_id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
            <span>{row.store_name}</span>
            <span className="tabular-nums">{row.balance}</span>
          </div>
        ))}
      </Card>

      <EditItemModal open={editOpen} onClose={() => setEditOpen(false)} item={item} />
    </div>
  );
}

function EditItemModal({ open, onClose, item }) {
  const [sku, setSku] = useState(item.sku || '');
  const [name, setName] = useState(item.name || '');
  const [category, setCategory] = useState(item.category || '');
  const [unit, setUnit] = useState(item.unit_of_measure || '');
  const [reorderLevel, setReorderLevel] = useState(item.reorder_level ?? '');
  const [description, setDescription] = useState(item.description || '');
  const [error, setError] = useState('');
  const update = useUpdateInventoryItem();
  const toast = useToast();

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('Name is required.'); return; }
    if (!unit.trim()) { setError('Unit of measure is required.'); return; }
    try {
      await update.mutateAsync({
        id: item.id, sku: sku.trim() || null, name: name.trim(), category: category.trim() || null,
        unit_of_measure: unit.trim(), reorder_level: reorderLevel === '' ? null : parseInt(reorderLevel, 10),
        description: description.trim() || null,
      });
      toast.success('Item updated.');
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={update.isPending ? () => {} : onClose}
      title="Edit Inventory Item"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={update.isPending}>Cancel</Button>
        <Button type="submit" form="edit-inventory-item-form" disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save Changes'}</Button>
      </>}
    >
      <form id="edit-inventory-item-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </label>
        <div style={{ display: 'flex', gap: '10px' }}>
          <label style={{ ...fieldStyle, flex: 1 }}>
            <span style={labelStyle}>SKU</span>
            <input value={sku} onChange={(e) => setSku(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ ...fieldStyle, flex: 1 }}>
            <span style={labelStyle}>Category</span>
            <input value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle} />
          </label>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <label style={{ ...fieldStyle, flex: 1 }}>
            <span style={labelStyle}>Unit of measure</span>
            <input value={unit} onChange={(e) => setUnit(e.target.value)} style={inputStyle} placeholder="e.g. pcs, liters" />
          </label>
          <label style={{ ...fieldStyle, flex: 1 }}>
            <span style={labelStyle}>Reorder level (optional)</span>
            <input type="number" min="0" value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} style={inputStyle} />
          </label>
        </div>
        <label style={fieldStyle}>
          <span style={labelStyle}>Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} />
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
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
