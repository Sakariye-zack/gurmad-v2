import React, { useState } from 'react';
import { UserCircle2, Plus } from 'lucide-react';
import { PageHeader, Card, Button, StatusBadge, LoadingState, Modal, useToast } from '../../components/ui/index.js';
import { useMyAttendance } from '../../hooks/useAttendance.js';
import { useMyLeaveRequests, useFileMyLeaveRequest, useLeaveTypes, useEmployeeEffectiveStatus } from '../../hooks/useLeave.js';
import { useMyEmployeeId } from '../../hooks/useEmployees.js';

const ATTENDANCE_STATUS_MAP = { present: 'success', absent: 'danger', late: 'warning', on_leave: 'info', half_day: 'warning' };
const LEAVE_STATUS_MAP = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'info' };
const EFFECTIVE_STATUS_MAP = { active: 'success', on_leave: 'info', suspended: 'warning', archived: 'danger' };

// New self-service page — user-requested gap-audit sweep ('sii wad
// qaybaha kale'). useMyAttendance() / useMyLeaveRequests() /
// useFileMyLeaveRequest() already existed, fully wired to the backend
// (GET/POST /v2/attendance/me, GET/POST /v2/leave-requests/me —
// self-scoped server-side, no role restriction beyond being logged in
// at all), but there was no page anywhere for any staff member to see
// their own attendance or request their own leave — those hooks were
// unreachable dead code. Reachable by EVERY authenticated staff role,
// not gated to admin/gudoomiye like the equivalent staff-facing pages.
export default function MyHrPage() {
  const { data: attendanceData, isLoading: attendanceLoading, error: attendanceError } = useMyAttendance();
  const { data: leaveData, isLoading: leaveLoading, error: leaveError } = useMyLeaveRequests();
  // Gap-audit sweep, continuation: useEmployeeEffectiveStatus() existed
  // but needed a numeric employee_id no /me endpoint returned. GET
  // /v2/employees/me (new, user-approved additive route) resolves that
  // id first; effective-status is then fetched only once it's known.
  const { data: myIdData, error: myIdError } = useMyEmployeeId();
  const myEmployeeId = myIdData?.data?.employee_id;
  const { data: effectiveStatusData } = useEmployeeEffectiveStatus(myEmployeeId);
  const [fileOpen, setFileOpen] = useState(false);
  const attendance = attendanceData?.data || [];
  const leave = leaveData?.data || [];
  const effectiveStatus = effectiveStatusData?.data?.effective_status;
  // Both /me endpoints return the identical 403 when no employee record
  // is linked to this login (e.g. a pure office/admin account that was
  // never linked to an Employees entry) — shown as a plain explanatory
  // state, never a raw error screen, since this is an expected outcome
  // for some accounts, not a failure.
  const notLinked = attendanceError?.status === 403 || leaveError?.status === 403 || myIdError?.status === 403;

  return (
    <div>
      <PageHeader icon={UserCircle2} title="My HR" subtitle="Your own attendance and leave — nothing else is shown here." />

      {notLinked ? (
        <Card style={{ padding: '20px' }}>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>
            No employee record is linked to your account, so there is no attendance or leave history to show.
            Ask an admin to link one from your Employee record if this isn't expected.
          </p>
        </Card>
      ) : (
        <>
          {effectiveStatus && (
            <Card style={{ padding: '16px', marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Label>Current Status</Label>
              <StatusBadge status={effectiveStatus} map={EFFECTIVE_STATUS_MAP} />
            </Card>
          )}
          <Card style={{ padding: '16px', marginBottom: '16px' }}>
            <Label>My Attendance</Label>
            {attendanceLoading && <LoadingState label="Loading…" />}
            {!attendanceLoading && attendance.length === 0 && (
              <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>No attendance records yet.</p>
            )}
            {attendance.map((a) => (
              <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
                <span>{new Date(a.attendance_date).toLocaleDateString()}</span>
                <StatusBadge status={a.status} map={ATTENDANCE_STATUS_MAP} />
              </div>
            ))}
          </Card>

          <Card style={{ padding: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <Label>My Leave Requests</Label>
              <Button icon={Plus} variant="secondary" onClick={() => setFileOpen(true)}>Request Leave</Button>
            </div>
            {leaveLoading && <LoadingState label="Loading…" />}
            {!leaveLoading && leave.length === 0 && (
              <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>No leave requests yet.</p>
            )}
            {leave.map((l) => (
              <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
                <span>{l.leave_type_label} — {new Date(l.start_date).toLocaleDateString()} to {new Date(l.end_date).toLocaleDateString()}</span>
                <StatusBadge status={l.status} map={LEAVE_STATUS_MAP} />
              </div>
            ))}
          </Card>
        </>
      )}

      <RequestLeaveModal open={fileOpen} onClose={() => setFileOpen(false)} />
    </div>
  );
}

function RequestLeaveModal({ open, onClose }) {
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const { data: leaveTypesData } = useLeaveTypes();
  const fileLeave = useFileMyLeaveRequest();
  const toast = useToast();
  const leaveTypes = (leaveTypesData?.data || []).filter((t) => t.status === 'active');

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!leaveTypeId) { setError('Select a leave type.'); return; }
    if (!startDate || !endDate) { setError('Start and end dates are required.'); return; }
    if (endDate < startDate) { setError('End date cannot be before the start date.'); return; }
    try {
      await fileLeave.mutateAsync({ leave_type_id: parseInt(leaveTypeId, 10), start_date: startDate, end_date: endDate, reason: reason || undefined });
      toast.success('Leave request filed.');
      onClose();
      setLeaveTypeId(''); setStartDate(''); setEndDate(''); setReason('');
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={fileLeave.isPending ? () => {} : onClose}
      title="Request Leave"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={fileLeave.isPending}>Cancel</Button>
        <Button type="submit" form="request-leave-form" disabled={fileLeave.isPending}>{fileLeave.isPending ? 'Filing…' : 'File Request'}</Button>
      </>}
    >
      <form id="request-leave-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
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

function Label({ children }) {
  return <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{children}</span>;
}

const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
