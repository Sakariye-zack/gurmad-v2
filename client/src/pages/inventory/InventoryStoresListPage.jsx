import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Warehouse, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useInventoryStores, useCreateInventoryStore, useSetInventoryStoreStatus } from '../../hooks/useInventory.js';
import { useZonesList } from '../../hooks/useCustomers.js';

export default function InventoryStoresListPage() {
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useInventoryStores({ q: search || undefined });
  const setStatus = useSetInventoryStoreStatus();
  const toast = useToast();
  const stores = data?.data || [];

  async function toggleStatus(store, e) {
    e.stopPropagation();
    try { await setStatus.mutateAsync({ id: store.id, status: store.status === 'active' ? 'inactive' : 'active' }); toast.success('Store status updated.'); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }

  return (
    <div>
      <PageHeader icon={Warehouse} title="Inventory Stores" subtitle="Physical stock locations." actions={<RoleGate roles={['admin']}><Button icon={Plus} onClick={() => setFormOpen(true)}>New Store</Button></RoleGate>} />
      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search store name…" />
      <DataTable
        loading={isLoading} error={error?.message} onRetry={refetch}
        isEmpty={!isLoading && !error && stores.length === 0}
        emptyTitle="No stores yet"
        columns={[{ label: 'Name' }, { label: 'Zone' }, { label: 'Status' }, { label: 'Actions' }]}
      >
        {stores.map((s) => (
          <tr key={s.id} onClick={() => navigate(`/inventory/stores/${s.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong>{s.name}</strong></td>
            <td style={cellStyle}>{s.zone_name || 'Company-wide'}</td>
            <td style={cellStyle}><StatusBadge status={s.status} map={{ active: 'success', inactive: 'info' }} /></td>
            <td style={cellStyle}>
              <RoleGate roles={['admin']}>
                <Button variant="secondary" onClick={(e) => toggleStatus(s, e)} disabled={setStatus.isPending}>{s.status === 'active' ? 'Deactivate' : 'Activate'}</Button>
              </RoleGate>
            </td>
          </tr>
        ))}
      </DataTable>
      <StoreFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function StoreFormModal({ open, onClose }) {
  const [name, setName] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [error, setError] = useState('');
  const { data: zonesData } = useZonesList();
  const create = useCreateInventoryStore();
  const toast = useToast();
  const zones = zonesData?.data || [];
  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('Name is required.'); return; }
    try {
      await create.mutateAsync({ name: name.trim(), zone_id: zoneId || undefined });
      toast.success('Store created.');
      setName(''); setZoneId('');
      onClose();
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }

  return (
    <Modal open onClose={create.isPending ? () => {} : onClose} title="New Store"
      footer={<><Button variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button><Button type="submit" form="store-form" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Create Store'}</Button></>}>
      <form id="store-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}><span style={labelStyle}>Name</span><input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Zone (optional — leave blank for company-wide)</span>
          <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} style={inputStyle}>
            <option value="">Company-wide</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

const cellStyle = { padding: '12px 14px' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = { padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit' };
