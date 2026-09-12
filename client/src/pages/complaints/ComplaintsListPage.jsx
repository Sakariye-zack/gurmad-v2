import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquareWarning, Plus } from 'lucide-react';
import { PageHeader, DataTable, StatusBadge, FilterBar, StatCard, Button, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useComplaints, useCreateComplaint } from '../../hooks/useComplaints.js';
import { useCustomers } from '../../hooks/useCustomers.js';

const STATUS_MAP = { pending: 'warning', in_progress: 'info', resolved: 'success', closed: 'info' };
const PRIORITY_MAP = { low: 'info', medium: 'warning', high: 'danger' };

// User-requested gap-audit sweep ('gabis kale... iga baadh iyo wax iga
// dhiman'): this screen was pure view-only — useCreateComplaint()
// already existed in useComplaints.js, fully wired to the backend
// (POST /v2/complaints, admin/gudoomiye — MANAGEMENT_ROLES), but
// nothing here ever called it. A staff member fielding a phone-in
// complaint had no way to log it at all.
export default function ComplaintsListPage() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, error, refetch } = useComplaints({ status: statusFilter || undefined });
  const complaints = data?.data || [];
  const pendingCount = complaints.filter((c) => c.status === 'pending').length;

  return (
    <div>
      <PageHeader
        icon={MessageSquareWarning}
        title="Complaints"
        subtitle="Customer complaints — submission, assignment, and resolution."
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setCreateOpen(true)}>New Complaint</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Total" value={error ? '—' : complaints.length} icon={MessageSquareWarning} />
        <StatCard label="Pending" value={error ? '—' : pendingCount} icon={MessageSquareWarning} accent="var(--warning)" />
      </div>

      <FilterBar searchValue="" onSearchChange={() => {}} searchPlaceholder="">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && complaints.length === 0}
        emptyTitle="No complaints"
        columns={[{ label: 'Customer' }, { label: 'Title' }, { label: 'Priority' }, { label: 'Status' }, { label: 'Assigned To' }, { label: 'Source' }, { label: 'Date' }]}
      >
        {complaints.map((c) => (
          <tr key={c.id} onClick={() => navigate(`/complaints/${c.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}>{c.customer_name} <span style={{ color: 'var(--text-muted)' }}>({c.customer_number})</span></td>
            <td style={cellStyle}>{c.title}</td>
            <td style={cellStyle}><StatusBadge status={c.priority} map={PRIORITY_MAP} /></td>
            <td style={cellStyle}><StatusBadge status={c.status} map={STATUS_MAP} /></td>
            <td style={cellStyle}>{c.assigned_to_name || <span style={{ color: 'var(--text-muted)' }}>Unassigned</span>}</td>
            <td style={{ ...cellStyle, textTransform: 'capitalize' }}>{c.source}</td>
            <td style={cellStyle}>{new Date(c.created_at).toLocaleDateString()}</td>
          </tr>
        ))}
      </DataTable>

      <NewComplaintModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function NewComplaintModal({ open, onClose }) {
  const [customerId, setCustomerId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [error, setError] = useState('');
  const { data: customersData } = useCustomers({});
  const createComplaint = useCreateComplaint();
  const toast = useToast();
  const customers = customersData?.data || [];

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!customerId) { setError('Select a customer.'); return; }
    if (!title.trim() || !description.trim()) { setError('Title and description are required.'); return; }
    try {
      await createComplaint.mutateAsync({ customer_id: parseInt(customerId, 10), title: title.trim(), description: description.trim(), priority });
      toast.success('Complaint logged.');
      onClose();
      setCustomerId(''); setTitle(''); setDescription(''); setPriority('medium');
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={createComplaint.isPending ? () => {} : onClose}
      title="New Complaint"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={createComplaint.isPending}>Cancel</Button>
        <Button type="submit" form="new-complaint-form" disabled={createComplaint.isPending}>{createComplaint.isPending ? 'Saving…' : 'Log Complaint'}</Button>
      </>}
    >
      <form id="new-complaint-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
          For a complaint received by phone, in person, or any channel other than the Customer Portal — a customer's own portal-submitted complaint already appears here automatically.
        </p>
        <label style={fieldStyle}>
          <span style={labelStyle}>Customer</span>
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} style={inputStyle}>
            <option value="">Select a customer…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_number} — {c.business_name || c.name}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} placeholder="Short summary" />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Description</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} style={{ ...inputStyle, minHeight: '80px', resize: 'vertical' }} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Priority</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} style={inputStyle}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
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
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
