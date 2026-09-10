import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, FileText, Pencil, Repeat, Archive, RotateCcw, Ban, Download, Eye } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, Modal, ConfirmDialog, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import {
  useDocument, useUpdateDocument, useReplaceDocument, useArchiveDocument, useRestoreDocument, useVoidDocument,
  downloadDocumentFile, DOCUMENT_CATEGORIES, PREVIEWABLE_MIME_TYPES,
} from '../../hooks/useDocuments.js';
import DocumentPreviewModal from './DocumentPreviewModal.jsx';

const STATUS_MAP = { active: 'success', archived: 'warning', voided: 'danger' };

export default function DocumentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [editOpen, setEditOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const { data, isLoading, error, refetch } = useDocument(id);
  const archive = useArchiveDocument();
  const restore = useRestoreDocument();
  const toast = useToast();
  const doc = data?.data;

  if (isLoading) return <LoadingState label="Loading document…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!doc) return null;

  const isActive = doc.status === 'active';
  const isArchived = doc.status === 'archived';
  const isPreviewable = PREVIEWABLE_MIME_TYPES.includes(doc.mime_type);

  async function handleArchive() {
    try { await archive.mutateAsync({ id: doc.id }); toast.success('Document archived.'); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }
  async function handleRestore() {
    try { await restore.mutateAsync({ id: doc.id }); toast.success('Document restored.'); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }
  async function handleDownload() {
    try { await downloadDocumentFile(doc.id, doc.display_filename); }
    catch (err) { toast.error(err.message || 'Failed to download file.'); }
  }

  return (
    <div>
      <button onClick={() => navigate('/documents')} style={backLinkStyle}><ArrowLeft size={14} /> Back to Documents</button>
      <PageHeader
        icon={FileText}
        title={doc.title}
        subtitle={doc.display_filename}
        actions={
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {isPreviewable && <Button icon={Eye} variant="secondary" onClick={() => setPreviewOpen(true)}>Preview</Button>}
            <Button icon={Download} variant="secondary" onClick={handleDownload}>Download</Button>
            <RoleGate roles={['admin', 'gudoomiye']}>
              <Button icon={Pencil} variant="secondary" disabled={!isActive} onClick={() => setEditOpen(true)}>Edit</Button>
              <Button icon={Repeat} variant="secondary" disabled={!isActive} onClick={() => setReplaceOpen(true)}>Replace</Button>
            </RoleGate>
            <RoleGate roles={['admin']}>
              {isActive && <Button icon={Archive} variant="secondary" disabled={archive.isPending} onClick={handleArchive}>Archive</Button>}
              {isArchived && <Button icon={RotateCcw} variant="secondary" disabled={restore.isPending} onClick={handleRestore}>Restore</Button>}
              {doc.status !== 'voided' && <Button icon={Ban} variant="danger" onClick={() => setVoidOpen(true)}>Void</Button>}
            </RoleGate>
          </div>
        }
      />
      <div style={{ marginBottom: '16px' }}><StatusBadge status={doc.status} map={STATUS_MAP} /></div>

      <DetailGrid items={[
        { label: 'Category', value: DOCUMENT_CATEGORIES.find((c) => c.value === doc.category)?.label || doc.category },
        { label: 'Zone', value: doc.zone_name || 'Company-wide' },
        { label: 'Description', value: doc.description || '—' },
        { label: 'File type', value: doc.mime_type },
        { label: 'File size', value: doc.file_size ? `${(doc.file_size / 1024 / 1024).toFixed(2)} MB` : '—' },
        { label: 'Uploaded', value: new Date(doc.created_at).toLocaleString() },
      ]} />

      {doc.status === 'voided' && (
        <Card style={{ padding: '16px', marginTop: '16px' }}>
          <Label>Void Reason</Label>
          <p style={{ margin: '8px 0 0', fontSize: '13px' }}>{doc.voided_reason || '—'}</p>
          <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>{doc.voided_at ? new Date(doc.voided_at).toLocaleString() : ''}</p>
        </Card>
      )}
      {doc.replaces_document_id && (
        <Card style={{ padding: '16px', marginTop: '16px' }}>
          <Label>Replacement History</Label>
          <p style={{ margin: '8px 0 0', fontSize: '13px' }}>
            This document replaces <button onClick={() => navigate(`/documents/${doc.replaces_document_id}`)} style={linkButtonStyle}>document #{doc.replaces_document_id}</button>.
          </p>
        </Card>
      )}

      <EditModal open={editOpen} onClose={() => setEditOpen(false)} doc={doc} />
      <ReplaceModal open={replaceOpen} onClose={() => setReplaceOpen(false)} doc={doc} onReplaced={(newId) => navigate(`/documents/${newId}`)} />
      <VoidDialog open={voidOpen} onClose={() => setVoidOpen(false)} doc={doc} />
      {isPreviewable && <DocumentPreviewModal open={previewOpen} onClose={() => setPreviewOpen(false)} doc={doc} />}
    </div>
  );
}

function EditModal({ open, onClose, doc }) {
  const [title, setTitle] = useState(doc.title); const [category, setCategory] = useState(doc.category);
  const [description, setDescription] = useState(doc.description || ''); const [error, setError] = useState('');
  const update = useUpdateDocument();
  const toast = useToast();
  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault(); setError('');
    if (!title.trim()) { setError('Title cannot be empty.'); return; }
    try {
      await update.mutateAsync({ id: doc.id, title: title.trim(), category, description: description || null });
      toast.success('Document updated.'); onClose();
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }

  return (
    <Modal open onClose={update.isPending ? () => {} : onClose} title="Edit Document"
      footer={<><Button variant="secondary" onClick={onClose} disabled={update.isPending}>Cancel</Button><Button type="submit" form="edit-doc-form" disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save'}</Button></>}>
      <form id="edit-doc-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}><span style={labelStyle}>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle}>
            {DOCUMENT_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        <label style={fieldStyle}><span style={labelStyle}>Description</span><input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} /></label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function ReplaceModal({ open, onClose, doc, onReplaced }) {
  const [file, setFile] = useState(null); const [error, setError] = useState('');
  const replace = useReplaceDocument();
  const toast = useToast();
  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault(); setError('');
    if (!file) { setError('A file is required.'); return; }
    if (file.size > 15 * 1024 * 1024) { setError('File exceeds the 15MB size limit.'); return; }
    const formData = new FormData();
    formData.append('file', file);
    try {
      const result = await replace.mutateAsync({ id: doc.id, formData });
      toast.success('Document replaced.'); setFile(null); onClose();
      if (result?.data?.id) onReplaced(result.data.id);
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }

  return (
    <Modal open onClose={replace.isPending ? () => {} : onClose} title="Replace Document"
      footer={<><Button variant="secondary" onClick={onClose} disabled={replace.isPending}>Cancel</Button><Button type="submit" form="replace-doc-form" disabled={replace.isPending}>{replace.isPending ? 'Replacing…' : 'Replace'}</Button></>}>
      <form id="replace-doc-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>This creates a new document with the new file and voids the current one — the old file remains retained and accessible.</p>
        <label style={fieldStyle}>
          <span style={labelStyle}>New file (PDF, DOC, DOCX, XLS, XLSX, CSV, JPG, PNG, WEBP — max 15MB)</span>
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} style={inputStyle} />
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function VoidDialog({ open, onClose, doc }) {
  const [reason, setReason] = useState('');
  const voidDoc = useVoidDocument();
  const toast = useToast();

  async function handleConfirm() {
    if (!reason.trim()) return;
    try { await voidDoc.mutateAsync({ id: doc.id, reason: reason.trim() }); toast.success('Document voided.'); setReason(''); onClose(); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={handleConfirm}
      title={`Void "${doc.title}"?`}
      message={
        // ConfirmDialog renders `message` inside a <p> — a <div> here would
        // be invalid HTML nesting (block content inside a paragraph).
        // <span style="display:flex"> is phrasing content, so it nests
        // validly while keeping the same flex-column layout.
        <span style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <span>This is permanent — a voided document cannot be reactivated. The file and record remain retained for historical evidence.</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Void reason" style={inputStyle} />
        </span>
      }
      confirmLabel="Void"
      danger
      isLoading={voidDoc.isPending}
    />
  );
}

function Label({ children }) {
  return <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{children}</span>;
}
const backLinkStyle = { display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px' };
const linkButtonStyle = { background: 'none', border: 'none', color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer', padding: 0, font: 'inherit' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = { padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit' };
