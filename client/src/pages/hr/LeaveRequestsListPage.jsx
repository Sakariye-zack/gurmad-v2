import React, { useState } from 'react';
import { CalendarOff, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useLeaveRequests, useSetLeaveRequestStatus, useCancelLeaveRequest, useCreateLeaveRequest, useLeaveTypes } from '../../hooks/useLeave.js';
import { useEmployees } from '../../hooks/useEmployees.js';

const STATUS_MAP = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'info' };

export default function LeaveRequestsListPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [cancelTarget, setCancelTarget] = useState(null);
  // User-requested gap-audit sweep ('gabis kale... iga baadh iyo wax
  // iga dhiman'): this screen could approve/reject/cancel a leave
  // request but had no way to FILE one — useCreateLeaveRequest()
  // already existed in useLeave.js, fully wired, but nothing here ever
  // called it.
  const [fileOpen, setFileOpen] = useState(false);
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
      <PageHeader
        icon={CalendarOff}
        title="Leave Requests"
        subtitle="Employee leave requests and approvals."
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFileOpen(true)}>File Leave Request</Button>
          </RoleGate>
        }
      />

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

      <FileLeaveRequestModal open={fileOpen} onClose={() => setFileOpen(false)} />
    </div>
  );
}

function FileLeaveRequestModal({ open, onClose }) {
  const [employeeId, setEmployeeId] = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const { data: employeesData } = useEmployees({ status: 'active' });
  const { data: leaveTypesData } = useLeaveTypes();
  const createLeaveRequest = useCreateLeaveRequest();
  const toast = useToast();
  const employees = employeesData?.data || [];
  const leaveTypes = (leaveTypesData?.data || []).filter((t) => t.status === 'active');

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!employeeId) { setError('Select an employee.'); return; }
    if (!leaveTypeId) { setError('Select a leave type.'); return; }
    if (!startDate || !endDate) { setError('Start and end dates are required.'); return; }
    if (endDate < startDate) { setError('End date cannot be before the start date.'); return; }
    try {
      await createLeaveRequest.mutateAsync({
        employee_id: parseInt(employeeId, 10), leave_type_id: parseInt(leaveTypeId, 10),
        start_date: startDate, end_date: endDate, reason: reason || undefined,
      });
      toast.success('Leave request filed.');
      onClose();
      setEmployeeId(''); setLeaveTypeId(''); setStartDate(''); setEndDate(''); setReason('');
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={createLeaveRequest.isPending ? () => {} : onClose}
      title="File Leave Request"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={createLeaveRequest.isPending}>Cancel</Button>
        <Button type="submit" form="file-leave-form" disabled={createLeaveRequest.isPending}>{createLeaveRequest.isPending ? 'Filing…' : 'File Request'}</Button>
      </>}
    >
      <form id="file-leave-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Employee</span>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} style={inputStyle}>
            <option value="">Select an employee…</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.job_role || e.employee_type})</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Leave type</span>
          <select value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} style={inputStyle}>
            <option value="">Select a leave type…</option>
            {leaveTypes.map((t) => <option key={t.id} value={t.id}>{t.label}{t.is_paid ? '' : ' (unpaid)'}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', gap: '10px' }}>
          <label style={{ ...fieldStyle, flex: 1 }}>
            <span style={labelStyle}>Start date</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ ...fieldStyle, flex: 1 }}>
            <span style={labelStyle}>End date</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
          </label>
        </div>
        <label style={fieldStyle}>
          <span style={labelStyle}>Reason (optional)</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} />
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
