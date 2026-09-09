import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Package, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useInventoryItems, useCreateInventoryItem, useSetInventoryItemStatus } from '../../hooks/useInventory.js';

export default function InventoryItemsListPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useInventoryItems({ q: search || undefined, status: statusFilter || undefined });
  const setStatus = useSetInventoryItemStatus();
  const toast = useToast();
  const items = data?.data || [];

  async function toggleStatus(item, e) {
    e.stopPropagation();
    try { await setStatus.mutateAsync({ id: item.id, status: item.status === 'active' ? 'inactive' : 'active' }); toast.success('Item status updated.'); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }

  return (
    <div>
      <PageHeader
        icon={Package}
        title="Inventory Items"
        subtitle="Company-wide item master data."
        actions={<RoleGate roles={['admin']}><Button icon={Plus} onClick={() => setFormOpen(true)}>New Item</Button></RoleGate>}
      />
      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search name, SKU, or category…">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </FilterBar>
      <DataTable
        loading={isLoading} error={error?.message} onRetry={refetch}
        isEmpty={!isLoading && !error && items.length === 0}
        emptyTitle="No inventory items yet"
        columns={[{ label: 'Name' }, { label: 'SKU' }, { label: 'Category' }, { label: 'Unit' }, { label: 'Reorder Level' }, { label: 'Status' }, { label: 'Actions' }]}
      >
        {items.map((item) => (
          <tr key={item.id} onClick={() => navigate(`/inventory/items/${item.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong>{item.name}</strong></td>
            <td style={cellStyle}>{item.sku || '—'}</td>
            <td style={cellStyle}>{item.category || '—'}</td>
            <td style={cellStyle}>{item.unit_of_measure}</td>
            <td style={cellStyle} className="tabular-nums">{item.reorder_level ?? '—'}</td>
            <td style={cellStyle}><StatusBadge status={item.status} map={{ active: 'success', inactive: 'info' }} /></td>
            <td style={cellStyle}>
              <RoleGate roles={['admin']}>
                <Button variant="secondary" onClick={(e) => toggleStatus(item, e)} disabled={setStatus.isPending}>{item.status === 'active' ? 'Deactivate' : 'Activate'}</Button>
              </RoleGate>
            </td>
          </tr>
        ))}
      </DataTable>
      <ItemFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function ItemFormModal({ open, onClose }) {
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [category, setCategory] = useState('');
  const [unit, setUnit] = useState('');
  const [reorderLevel, setReorderLevel] = useState('');
  const [error, setError] = useState('');
  const create = useCreateInventoryItem();
  const toast = useToast();
  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('Name is required.'); return; }
    if (!unit.trim()) { setError('Unit of measure is required.'); return; }
    try {
      await create.mutateAsync({ name: name.trim(), sku: sku || undefined, category: category || undefined, unit_of_measure: unit.trim(), reorder_level: reorderLevel || undefined });
      toast.success('Item created.');
      setName(''); setSku(''); setCategory(''); setUnit(''); setReorderLevel('');
      onClose();
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }

  return (
    <Modal open onClose={create.isPending ? () => {} : onClose} title="New Inventory Item"
      footer={<><Button variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button><Button type="submit" form="item-form" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Create Item'}</Button></>}>
      <form id="item-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}><span style={labelStyle}>Name</span><input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>SKU (optional)</span><input value={sku} onChange={(e) => setSku(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Category (optional)</span><input value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Unit of measure</span><input value={unit} onChange={(e) => setUnit(e.target.value)} style={inputStyle} placeholder="pcs, box, liter…" /></label>
        <label style={fieldStyle}><span style={labelStyle}>Reorder level (optional)</span><input type="number" min="0" value={reorderLevel} onChange={(e) => setReorderLevel(e.target.value)} style={inputStyle} /></label>
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
