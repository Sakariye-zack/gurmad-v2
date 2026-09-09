import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useSuppliers, useCreateSupplier } from '../../hooks/useProcurement.js';

const STATUS_MAP = { active: 'success', inactive: 'info' };

export default function SuppliersListPage() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useSuppliers({ q: search || undefined, status: statusFilter || undefined });
  const suppliers = data?.data || [];

  return (
    <div>
      <PageHeader
        icon={Building2}
        title="Suppliers"
        subtitle="Procurement supplier directory."
        actions={
          <RoleGate roles={['admin']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>New Supplier</Button>
          </RoleGate>
        }
      />

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search name, contact, or category…">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && suppliers.length === 0}
        emptyTitle="No suppliers yet"
        columns={[{ label: 'Name' }, { label: 'Contact' }, { label: 'Phone' }, { label: 'Category' }, { label: 'Status' }]}
      >
        {suppliers.map((s) => (
          <tr key={s.id} onClick={() => navigate(`/procurement/suppliers/${s.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong>{s.name}</strong></td>
            <td style={cellStyle}>{s.contact || '—'}</td>
            <td style={cellStyle}>{s.phone || '—'}</td>
            <td style={cellStyle}>{s.category || '—'}</td>
            <td style={cellStyle}><StatusBadge status={s.status} map={STATUS_MAP} /></td>
          </tr>
        ))}
      </DataTable>

      <SupplierFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function SupplierFormModal({ open, onClose }) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [category, setCategory] = useState('');
  const [error, setError] = useState('');
  const create = useCreateSupplier();
  const toast = useToast();

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('Name is required.'); return; }
    try {
      const result = await create.mutateAsync({ name: name.trim(), contact: contact || undefined, phone: phone || undefined, email: email || undefined, address: address || undefined, category: category || undefined });
      toast.success(`${result.data.name} created.`);
      setName(''); setContact(''); setPhone(''); setEmail(''); setAddress(''); setCategory('');
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={create.isPending ? () => {} : onClose}
      title="New Supplier"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button>
        <Button type="submit" form="supplier-form" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Create Supplier'}</Button>
      </>}
    >
      <form id="supplier-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}><span style={labelStyle}>Name</span><input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Contact (optional)</span><input value={contact} onChange={(e) => setContact(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Phone (optional)</span><input value={phone} onChange={(e) => setPhone(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Email (optional)</span><input value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Address (optional)</span><input value={address} onChange={(e) => setAddress(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>Category (optional)</span><input value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle} /></label>
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
