import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Boxes, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useAssets, useCreateAsset, useInventoryStores } from '../../hooks/useInventory.js';
import { useZonesList } from '../../hooks/useCustomers.js';

const STATUS_MAP = { active: 'success', assigned: 'info', in_maintenance: 'warning', retired: 'danger' };

export default function AssetsListPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useAssets({ q: search || undefined, status: statusFilter || undefined });
  const assets = data?.data || [];

  return (
    <div>
      <PageHeader
        icon={Boxes}
        title="Asset Register"
        subtitle="Company equipment and its assignment/maintenance lifecycle."
        actions={<RoleGate roles={['admin']}><Button icon={Plus} onClick={() => setFormOpen(true)}>New Asset</Button></RoleGate>}
      />
      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search name, tag, or serial…">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="assigned">Assigned</option>
          <option value="in_maintenance">In Maintenance</option>
          <option value="retired">Retired</option>
        </select>
      </FilterBar>
      <DataTable
        loading={isLoading} error={error?.message} onRetry={refetch}
        isEmpty={!isLoading && !error && assets.length === 0}
        emptyTitle="No assets yet"
        columns={[{ label: 'Asset Tag' }, { label: 'Name' }, { label: 'Zone' }, { label: 'Assigned To' }, { label: 'Status' }]}
      >
        {assets.map((a) => (
          <tr key={a.id} onClick={() => navigate(`/inventory/assets/${a.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}>{a.asset_tag || '—'}</td>
            <td style={cellStyle}><strong>{a.name}</strong></td>
            <td style={cellStyle}>{a.zone_name || 'Company-wide'}</td>
            <td style={cellStyle}>{a.assigned_employee_name || '—'}</td>
            <td style={cellStyle}><StatusBadge status={a.status} map={STATUS_MAP} /></td>
          </tr>
        ))}
      </DataTable>
      <AssetFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function AssetFormModal({ open, onClose }) {
  const [name, setName] = useState(''); const [assetTag, setAssetTag] = useState(''); const [category, setCategory] = useState('');
  const [serialNumber, setSerialNumber] = useState(''); const [zoneId, setZoneId] = useState(''); const [storeLocationId, setStoreLocationId] = useState('');
  const [acquisitionCost, setAcquisitionCost] = useState(''); const [error, setError] = useState('');
  const { data: zonesData } = useZonesList();
  const { data: storesData } = useInventoryStores({ status: 'active' });
  const create = useCreateAsset();
  const toast = useToast();
  const zones = zonesData?.data || [];
  const stores = storesData?.data || [];
  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault(); setError('');
    if (!name.trim()) { setError('Name is required.'); return; }
    try {
      await create.mutateAsync({
        name: name.trim(), asset_tag: assetTag || undefined, category: category || undefined, serial_number: serialNumber || undefined,
        zone_id: zoneId || undefined, store_location_id: storeLocationId || undefined, acquisition_cost: acquisitionCost || undefined,
      });
      toast.success('Asset created.');
      setName(''); setAssetTag(''); setCategory(''); setSerialNumber(''); setZoneId(''); setStoreLocationId(''); setAcquisitionCost('');
      onClose();
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }

  return (
    <Modal open onClose={create.isPending ? () => {} : onClose} title="New Asset"
      footer={<><Button variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button><Button type="submit" form="asset-form" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Create Asset'}</Button></>}>
      <form id="asset-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}><span style={labelStyle}>Name</span><input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Asset tag (optional)</span><input value={assetTag} onChange={(e) => setAssetTag(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Category (optional)</span><input value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Serial number (optional)</span><input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Zone (optional — leave blank for company-wide)</span>
          <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} style={inputStyle}>
            <option value="">Company-wide</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Store location (optional)</span>
          <select value={storeLocationId} onChange={(e) => setStoreLocationId(e.target.value)} style={inputStyle}>
            <option value="">None</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label style={fieldStyle}><span style={labelStyle}>Acquisition cost (optional)</span><input type="number" min="0" step="0.01" value={acquisitionCost} onChange={(e) => setAcquisitionCost(e.target.value)} style={inputStyle} /></label>
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
