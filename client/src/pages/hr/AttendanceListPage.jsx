import React, { useState } from 'react';
import { CalendarCheck, Plus, Pencil } from 'lucide-react';
import { PageHeader, DataTable, StatusBadge, FilterBar, Button, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useAttendance, useMarkAttendance, useCorrectAttendance } from '../../hooks/useAttendance.js';
import { useEmployees } from '../../hooks/useEmployees.js';

const STATUS_MAP = { present: 'success', absent: 'danger', late: 'warning', on_leave: 'info', half_day: 'warning' };
const STATUS_OPTIONS = [
  { value: 'present', label: 'Present' }, { value: 'absent', label: 'Absent' }, { value: 'late', label: 'Late' },
  { value: 'on_leave', label: 'On Leave' }, { value: 'half_day', label: 'Half Day' },
];

// User-requested gap-audit sweep ('gabis kale... iga baadh iyo wax iga
// dhiman'): this screen was pure view-only — useMarkAttendance() and
// useCorrectAttendance() already existed in useAttendance.js, fully
// wired to the backend (POST /v2/attendance, POST /v2/attendance/:id/
// correct), but nothing on this page ever called either. There was no
// way to actually record a day's attendance through the UI at all.
export default function AttendanceListPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [markOpen, setMarkOpen] = useState(false);
  const [correctTarget, setCorrectTarget] = useState(null);
  const { data, isLoading, error, refetch } = useAttendance({ status: statusFilter || undefined });
  const records = data?.data || [];

  return (
    <div>
      <PageHeader
        icon={CalendarCheck}
        title="Attendance"
        subtitle="Daily attendance records. Informational only — never used to calculate payroll."
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setMarkOpen(true)}>Mark Attendance</Button>
          </RoleGate>
        }
      />

      <FilterBar searchValue="" onSearchChange={() => {}} searchPlaceholder="">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && records.length === 0}
        emptyTitle="No attendance records"
        columns={[{ label: 'Employee' }, { label: 'Date' }, { label: 'Status' }, { label: 'Clock In' }, { label: 'Clock Out' }, { label: 'Actions' }]}
      >
        {records.map((r) => (
          <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{r.employee_name}</td>
            <td style={cellStyle}>{new Date(r.attendance_date).toLocaleDateString()}</td>
            <td style={cellStyle}><StatusBadge status={r.status} map={STATUS_MAP} /></td>
            <td style={cellStyle}>{r.clock_in ? new Date(r.clock_in).toLocaleTimeString() : '—'}</td>
            <td style={cellStyle}>{r.clock_out ? new Date(r.clock_out).toLocaleTimeString() : '—'}</td>
            <td style={cellStyle}>
              <RoleGate roles={['admin', 'gudoomiye']}>
                <Button variant="ghost" icon={Pencil} style={{ padding: '6px 10px', fontSize: '12px' }} onClick={() => setCorrectTarget(r)}>Correct</Button>
              </RoleGate>
            </td>
          </tr>
        ))}
      </DataTable>

      <MarkAttendanceModal open={markOpen} onClose={() => setMarkOpen(false)} />
      <CorrectAttendanceModal record={correctTarget} onClose={() => setCorrectTarget(null)} />
    </div>
  );
}

function MarkAttendanceModal({ open, onClose }) {
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [status, setStatus] = useState('present');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const { data: employeesData } = useEmployees({ status: 'active' });
  const markAttendance = useMarkAttendance();
  const toast = useToast();
  const employees = employeesData?.data || [];

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!employeeId) { setError('Select an employee.'); return; }
    if (!date) { setError('Select a date.'); return; }
    try {
      await markAttendance.mutateAsync({ employee_id: parseInt(employeeId, 10), attendance_date: date, status, notes: notes || undefined });
      toast.success('Attendance recorded.');
      onClose();
      setEmployeeId(''); setStatus('present'); setNotes('');
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={markAttendance.isPending ? () => {} : onClose}
      title="Mark Attendance"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={markAttendance.isPending}>Cancel</Button>
        <Button type="submit" form="mark-attendance-form" disabled={markAttendance.isPending}>{markAttendance.isPending ? 'Saving…' : 'Mark Attendance'}</Button>
      </>}
    >
      <form id="mark-attendance-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Employee</span>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} style={inputStyle}>
            <option value="">Select an employee…</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.job_role || e.employee_type})</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', gap: '10px' }}>
          <label style={{ ...fieldStyle, flex: 1 }}>
            <span style={labelStyle}>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ ...fieldStyle, flex: 1 }}>
            <span style={labelStyle}>Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
              {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
        </div>
        <label style={fieldStyle}>
          <span style={labelStyle}>Notes (optional)</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle} />
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function CorrectAttendanceModal({ record, onClose }) {
  const [status, setStatus] = useState(record?.status || 'present');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const correctAttendance = useCorrectAttendance();
  const toast = useToast();

  React.useEffect(() => {
    if (record) { setStatus(record.status); setReason(''); setError(''); }
  }, [record]);

  if (!record) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!reason.trim()) { setError('A correction reason is required.'); return; }
    try {
      await correctAttendance.mutateAsync({ id: record.id, status, correction_reason: reason.trim() });
      toast.success('Attendance corrected.');
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={correctAttendance.isPending ? () => {} : onClose}
      title={`Correct Attendance — ${record.employee_name}`}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={correctAttendance.isPending}>Cancel</Button>
        <Button type="submit" form="correct-attendance-form" disabled={correctAttendance.isPending}>{correctAttendance.isPending ? 'Saving…' : 'Save Correction'}</Button>
      </>}
    >
      <form id="correct-attendance-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
          {new Date(record.attendance_date).toLocaleDateString()} — currently <strong style={{ textTransform: 'capitalize' }}>{record.status.replace('_', ' ')}</strong>.
          A correction creates a new, linked record — the original is preserved, never overwritten.
        </p>
        <label style={fieldStyle}>
          <span style={labelStyle}>Corrected status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
            {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Correction reason (required)</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} placeholder="e.g. Marked absent by mistake — was on approved leave" />
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
