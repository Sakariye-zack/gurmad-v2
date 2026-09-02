import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MessageSquareWarning } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { apiClient } from '../../lib/apiClient.js';
import {
  useComplaint, useUpdateComplaintStatus, useAssignComplaint, useSetComplaintPriority, useReplyToComplaint,
} from '../../hooks/useComplaints.js';

const STATUS_MAP = { pending: 'warning', in_progress: 'info', resolved: 'success', closed: 'info' };
const PRIORITY_MAP = { low: 'info', medium: 'warning', high: 'danger' };

// Approved linear lifecycle (Implementation Spec §7) — mirrored here ONLY
// for the "what's the next legal transition" UI affordance; the actual
// enforcement is server-side (updateComplaintStatus()), this is not a
// second source of truth, just knowing which single button to show next.
const NEXT_STATUS = { pending: 'in_progress', in_progress: 'resolved', resolved: 'closed', closed: null };
const NEXT_LABEL = { in_progress: 'Start Progress', resolved: 'Mark Resolved', closed: 'Close Complaint' };

export default function ComplaintDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useComplaint(id);
  const [employeeId, setEmployeeId] = useState('');
  const [replyText, setReplyText] = useState('');
  const statusMut = useUpdateComplaintStatus(id);
  const assignMut = useAssignComplaint(id);
  const priorityMut = useSetComplaintPriority(id);
  const replyMut = useReplyToComplaint(id);
  const toast = useToast();
  const complaint = data?.data;

  if (isLoading) return <LoadingState label="Loading complaint…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!complaint) return null;

  const nextStatus = NEXT_STATUS[complaint.status];

  async function handleAdvance() {
    try {
      await statusMut.mutateAsync(nextStatus);
      toast.success(`Complaint moved to ${nextStatus.replace('_', ' ')}.`);
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    }
  }

  async function handleAssign() {
    if (!employeeId) return;
    try {
      await assignMut.mutateAsync(Number(employeeId));
      toast.success('Complaint assigned.');
      setEmployeeId('');
    } catch (err) {
      toast.error(err.message || 'Assignment failed.');
    }
  }

  async function handlePriority(p) {
    try {
      await priorityMut.mutateAsync(p);
      toast.success('Priority updated.');
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    }
  }

  async function handleReply() {
    if (!replyText.trim()) return;
    try {
      await replyMut.mutateAsync(replyText.trim());
      toast.success('Reply sent — the customer has been notified.');
      setReplyText('');
    } catch (err) {
      toast.error(err.message || 'Failed to send reply.');
    }
  }

  return (
    <div>
      <button onClick={() => navigate('/complaints')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Complaints
      </button>
      <PageHeader
        icon={MessageSquareWarning}
        title={complaint.title}
        subtitle={`${complaint.customer_name} (${complaint.customer_number}) · ${new Date(complaint.created_at).toLocaleString()}`}
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            {nextStatus && (
              <Button onClick={handleAdvance} disabled={statusMut.isPending}>{NEXT_LABEL[nextStatus]}</Button>
            )}
          </RoleGate>
        }
      />

      <DetailGrid items={[
        { label: 'Status', value: <StatusBadge status={complaint.status} map={STATUS_MAP} /> },
        { label: 'Priority', value: <StatusBadge status={complaint.priority} map={PRIORITY_MAP} /> },
        { label: 'Source', value: <span style={{ textTransform: 'capitalize' }}>{complaint.source}</span> },
        { label: 'Assigned To', value: complaint.assigned_to_name || '—' },
        { label: 'Resolved At', value: complaint.resolved_at ? new Date(complaint.resolved_at).toLocaleString() : '—' },
        { label: 'Closed At', value: complaint.closed_at ? new Date(complaint.closed_at).toLocaleString() : '—' },
      ]} />

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <h3 style={{ margin: '0 0 8px', fontSize: '14px' }}>Description</h3>
        <p style={{ margin: 0, fontSize: '13px', whiteSpace: 'pre-wrap' }}>{complaint.description}</p>
      </Card>

      {complaint.attachments && complaint.attachments.length > 0 && (
        <Card style={{ padding: '16px', marginTop: '16px' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: '14px' }}>Attachments</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {complaint.attachments.map((a) => (
              <button
                key={a.id}
                onClick={() => apiClient.downloadAuthorizedFile(`/v2/complaints/${id}/attachments/${a.id}`, a.original_filename)}
                style={attachmentLinkStyle}
              >
                {a.original_filename} ({a.mime_type})
              </button>
            ))}
          </div>
        </Card>
      )}

      <RoleGate roles={['admin', 'gudoomiye']}>
        <Card style={{ padding: '16px', marginTop: '16px' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: '14px' }}>Manage</h3>

          <div style={{ marginBottom: '14px' }}>
            <label style={labelStyle}>Priority</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              {['low', 'medium', 'high'].map((p) => (
                <Button key={p} variant={complaint.priority === p ? 'primary' : 'secondary'} onClick={() => handlePriority(p)} disabled={priorityMut.isPending}>
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </Button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: '14px' }}>
            <label style={labelStyle}>Assign to Employee (office staff, same zone, active)</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="number" placeholder="Employee ID" value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)} style={inputStyle}
              />
              <Button onClick={handleAssign} disabled={assignMut.isPending || !employeeId}>Assign</Button>
            </div>
          </div>

          <div>
            <label style={labelStyle}>Reply to Customer</label>
            <textarea
              value={replyText} onChange={(e) => setReplyText(e.target.value)}
              rows={3} style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', resize: 'vertical' }}
              placeholder="Write a reply — the customer will be notified."
            />
            <Button onClick={handleReply} disabled={replyMut.isPending || !replyText.trim()} style={{ marginTop: '8px' }}>Send Reply</Button>
          </div>
        </Card>
      </RoleGate>

      {complaint.admin_reply && (
        <Card style={{ padding: '16px', marginTop: '16px' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: '14px' }}>Staff Reply</h3>
          <p style={{ margin: 0, fontSize: '13px', whiteSpace: 'pre-wrap' }}>{complaint.admin_reply}</p>
          <p style={{ margin: '8px 0 0', fontSize: '11px', color: 'var(--text-muted)' }}>{new Date(complaint.replied_at).toLocaleString()}</p>
        </Card>
      )}
    </div>
  );
}

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
const labelStyle = { display: 'block', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)', marginBottom: '6px' };
const inputStyle = { padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', fontFamily: 'inherit' };
const attachmentLinkStyle = { display: 'block', textAlign: 'left', background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: '13px', color: 'var(--brand)', cursor: 'pointer' };
