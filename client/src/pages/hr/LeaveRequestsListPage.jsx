import React, { useState } from 'react';
import { CalendarOff } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useLeaveRequests, useSetLeaveRequestStatus, useCancelLeaveRequest } from '../../hooks/useLeave.js';

const STATUS_MAP = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'info' };

export default function LeaveRequestsListPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [cancelTarget, setCancelTarget] = useState(null);
  const { data, isLoading, error, refetch } = useLeaveRequests({ status: statusFilter || undefined });
  const setStatus = useSetLeaveRequestStatus();
  const cancel = useCancelLeaveRequest();
  const toast = useToast();
  const requests = data?.data || [];

  async function handleDecision(id, status) {
    try {
      await setStatus.mutateAsync({ id, status });
      toast.success(`Leave request ${status}.`);
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    }
  }

  async function handleCancel(reason) {
    try {
      await cancel.mutateAsync({ id: cancelTarget.id, reason });
      toast.success('Leave request cancelled.');
      setCancelTarget(null);
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    }
  }

  return (
    <div>
      <PageHeader icon={CalendarOff} title="Leave Requests" subtitle="Employee leave requests and approvals." />

      <FilterBar searchValue="" onSearchChange={() => {}} searchPlaceholder="">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && requests.length === 0}
        emptyTitle="No leave requests"
        columns={[{ label: 'Employee' }, { label: 'Type' }, { label: 'Dates' }, { label: 'Status' }, { label: 'Actions' }]}
      >
        {requests.map((r) => (
          <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{r.employee_name}</td>
            <td style={cellStyle}>{r.leave_type_label}</td>
            <td style={cellStyle} className="tabular-nums">{new Date(r.start_date).toLocaleDateString()} – {new Date(r.end_date).toLocaleDateString()}</td>
            <td style={cellStyle}><StatusBadge status={r.status} map={STATUS_MAP} /></td>
            <td style={cellStyle}>
              <RoleGate roles={['admin', 'gudoomiye']}>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {r.status === 'pending' && (
                    <>
                      <Button variant="secondary" onClick={() => handleDecision(r.id, 'approved')} disabled={setStatus.isPending}>Approve</Button>
                      <Button variant="secondary" onClick={() => handleDecision(r.id, 'rejected')} disabled={setStatus.isPending}>Reject</Button>
                    </>
                  )}
                  {r.status === 'approved' && (
                    <Button variant="danger" onClick={() => setCancelTarget(r)}>Cancel</Button>
                  )}
                </div>
              </RoleGate>
            </td>
          </tr>
        ))}
      </DataTable>

      <Modal
        open={!!cancelTarget}
        onClose={() => setCancelTarget(null)}
        title="Cancel Leave Request"
        footer={<>
          <Button variant="secondary" onClick={() => setCancelTarget(null)}>Back</Button>
          <Button variant="danger" onClick={() => handleCancel(document.getElementById('cancel-reason')?.value)} disabled={cancel.isPending}>Cancel Request</Button>
        </>}
      >
        <input id="cancel-reason" placeholder="Reason for cancellation" style={inputStyle} />
      </Modal>
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
