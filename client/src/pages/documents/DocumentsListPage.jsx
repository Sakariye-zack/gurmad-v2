import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useDocuments, useUploadDocument, DOCUMENT_CATEGORIES } from '../../hooks/useDocuments.js';
import { useZonesList } from '../../hooks/useCustomers.js';

const STATUS_MAP = { active: 'success', archived: 'warning', voided: 'danger' };

export default function DocumentsListPage() {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('active');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useDocuments({ title: title || undefined, category: category || undefined, status: status || undefined });
  const docs = data?.data || [];

  return (
    <div>
      <PageHeader
        icon={FileText}
        title="Documents"
        subtitle="Centralized document and file storage."
        actions={<RoleGate roles={['admin', 'gudoomiye']}><Button icon={Plus} onClick={() => setFormOpen(true)}>Upload Document</Button></RoleGate>}
      />
      <FilterBar searchValue={title} onSearchChange={setTitle} searchPlaceholder="Search title…">
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={selectStyle}>
          <option value="">All categories</option>
          {DOCUMENT_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle}>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="voided">Voided</option>
        </select>
      </FilterBar>
      <DataTable
        loading={isLoading} error={error?.message} onRetry={refetch}
        isEmpty={!isLoading && !error && docs.length === 0}
        emptyTitle="No documents yet"
        columns={[{ label: 'Title' }, { label: 'Category' }, { label: 'Zone' }, { label: 'File' }, { label: 'Status' }]}
      >
        {docs.map((d) => (
          <tr key={d.id} onClick={() => navigate(`/documents/${d.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong>{d.title}</strong></td>
            <td style={cellStyle}>{DOCUMENT_CATEGORIES.find((c) => c.value === d.category)?.label || d.category}</td>
            <td style={cellStyle}>{d.zone_name || 'Company-wide'}</td>
            <td style={cellStyle}>{d.display_filename}</td>
            <td style={cellStyle}><StatusBadge status={d.status} map={STATUS_MAP} /></td>
          </tr>
        ))}
      </DataTable>
      <UploadModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function UploadModal({ open, onClose }) {
  const [title, setTitle] = useState(''); const [category, setCategory] = useState('');
  const [description, setDescription] = useState(''); const [zoneId, setZoneId] = useState('');
  const [file, setFile] = useState(null); const [error, setError] = useState('');
  const { data: zonesData } = useZonesList();
  const upload = useUploadDocument();
  const toast = useToast();
  const zones = zonesData?.data || [];
  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault(); setError('');
    if (!title.trim()) { setError('Title is required.'); return; }
    if (!category) { setError('Category is required.'); return; }
    if (!file) { setError('A file is required.'); return; }
    if (file.size > 15 * 1024 * 1024) { setError('File exceeds the 15MB size limit.'); return; }
    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', title.trim());
    formData.append('category', category);
    if (description) formData.append('description', description);
    if (zoneId) formData.append('zone_id', zoneId);
    try {
      await upload.mutateAsync(formData);
      toast.success('Document uploaded.');
      setTitle(''); setCategory(''); setDescription(''); setZoneId(''); setFile(null);
      onClose();
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }

  return (
    <Modal open onClose={upload.isPending ? () => {} : onClose} title="Upload Document"
      footer={<><Button variant="secondary" onClick={onClose} disabled={upload.isPending}>Cancel</Button><Button type="submit" form="upload-doc-form" disabled={upload.isPending}>{upload.isPending ? 'Uploading…' : 'Upload'}</Button></>}>
      <form id="upload-doc-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}><span style={labelStyle}>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle}>
            <option value="">Select a category…</option>
            {DOCUMENT_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label style={fieldStyle}><span style={labelStyle}>Description (optional)</span><input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Zone (optional — leave blank for company-wide)</span>
          <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} style={inputStyle}>
            <option value="">Company-wide</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>File (PDF, DOC, DOCX, XLS, XLSX, CSV, JPG, PNG, WEBP — max 15MB)</span>
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} style={inputStyle} />
        </label>
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
