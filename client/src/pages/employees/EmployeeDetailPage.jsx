import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Users2, Pencil, Archive, RotateCcw } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, ConfirmDialog, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useEmployee, useUpdateEmployeeStatus } from '../../hooks/useEmployees.js';
import { useAttendance } from '../../hooks/useAttendance.js';
import { useLeaveRequests } from '../../hooks/useLeave.js';
import { usePayrollHistory } from '../../hooks/useHrReports.js';
import { useTrucks } from '../../hooks/useTrucks.js';
import EmployeeFormModal from './EmployeeFormModal.jsx';

// Clear separation between general information and sensitive HR information
// (per the explicit UI requirement) — two distinct card groups, not one
// undifferentiated grid.
export default function EmployeeDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useEmployee(id);
  const [editOpen, setEditOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const updateStatus = useUpdateEmployeeStatus(id);
  const toast = useToast();
  const employee = data?.data;

  if (isLoading) return <LoadingState label="Loading employee…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!employee) return null;

  const isArchived = employee.status === 'archived';
  const hasSensitiveFields = 'guarantor_name' in employee; // absent entirely for zone_accountant (field-scoped response)

  async function handleArchiveToggle() {
    try {
      await updateStatus.mutateAsync(isArchived ? 'active' : 'archived');
      toast.success(isArchived ? 'Employee restored to active.' : 'Employee archived.');
      setArchiveConfirmOpen(false);
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    }
  }

  return (
    <div>
      <button onClick={() => navigate('/employees')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Employees
      </button>

      <PageHeader
        icon={Users2}
        title={employee.name}
        subtitle={`${employee.job_role || employee.employee_type}${employee.zone_name ? ` · ${employee.zone_name}` : ''}`}
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>Edit Employee</Button>
              <Button
                variant={isArchived ? 'primary' : 'danger'}
                icon={isArchived ? RotateCcw : Archive}
                onClick={() => setArchiveConfirmOpen(true)}
              >
                {isArchived ? 'Restore' : 'Archive'}
              </Button>
            </div>
          </RoleGate>
        }
      />

      <span style={sectionLabelStyle}>General information</span>
      <div style={{ marginBottom: '20px' }}>
        <DetailGrid items={[
          { label: 'Type', value: <span style={{ textTransform: 'capitalize' }}>{employee.employee_type}</span> },
          { label: 'Status', value: <StatusBadge status={employee.status} /> },
          { label: 'Zone', value: employee.zone_name || '— (company-wide)' },
          { label: 'Phone', value: employee.phone, className: 'tabular-nums' },
          employee.employee_type === 'collector' && {
            label: 'Collector classification',
            value: <span style={{ textTransform: 'capitalize' }}>{employee.collector_type || 'Not set'}{employee.commercial_shift ? ` — ${employee.commercial_shift}` : ''}</span>,
          },
          {
            // User-reported gap (Phase 10 Billing audit, continued
            // sweep): showed the raw numeric id instead of the username
            // — the backend now joins it, fall back to the id only if
            // that user account was since deleted.
            label: 'Linked account (reference only)',
            value: employee.user_id != null ? (employee.linked_username || `User #${employee.user_id}`) : '— (no login account)',
            hint: employee.user_id != null ? 'Recorded reference, not a verified account link.' : null,
          },
          { label: 'Join date', value: employee.join_date || '—' },
        ]} />
      </div>

      {hasSensitiveFields && (
        <>
          <span style={sectionLabelStyle}>Sensitive HR information</span>
          <DetailGrid items={[
            { label: 'Salary', value: employee.salary != null ? employee.salary : '—', className: 'tabular-nums' },
            { label: 'Guarantor', value: employee.guarantor_name || '—' },
            { label: 'Guarantor phone', value: employee.guarantor_phone || '—', className: 'tabular-nums' },
          ]} />
          {employee.notes && (
            <Card style={{ ...cardPad, marginTop: '16px' }}>
              <Label>Notes</Label>
              <p style={{ margin: '6px 0 0', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{employee.notes}</p>
            </Card>
          )}
        </>
      )}
      {!hasSensitiveFields && (
        <Card style={cardPad}>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>
            Sensitive HR information (salary, guarantor details) is not shown for your role.
          </p>
        </Card>
      )}

      {/* User-reported gap-audit sweep ('sii wad qaybaha kale'): this
          placeholder said 'will appear here once their respective modules
          are implemented' — Attendance, Leave, and Payroll are now all
          implemented and their own hooks (useAttendance, useLeaveRequests,
          usePayrollHistory) already existed, but nobody ever came back to
          replace this stale placeholder with the real sections. */}
      <EmployeeActivitySections employeeId={employee.id} employeeType={employee.employee_type} />

      <EmployeeFormModal open={editOpen} onClose={() => setEditOpen(false)} employee={employee} />
      <ConfirmDialog
        open={archiveConfirmOpen}
        onClose={() => setArchiveConfirmOpen(false)}
        onConfirm={handleArchiveToggle}
        title={isArchived ? 'Restore this employee?' : 'Archive this employee?'}
        message={isArchived
          ? `${employee.name} will become active again and reappear in the default employee list.`
          : `${employee.name} will be hidden from the default employee list. All history remains intact — this does not delete anything.`}
        confirmLabel={isArchived ? 'Restore' : 'Archive'}
        danger={!isArchived}
        isLoading={updateStatus.isPending}
      />
    </div>
  );
}

function Label({ children }) {
  return <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{children}</span>;
}

function EmployeeActivitySections({ employeeId, employeeType }) {
  const { data: attendanceData } = useAttendance({ employee_id: employeeId });
  const { data: leaveData } = useLeaveRequests({ employee_id: employeeId });
  const { data: payrollData } = usePayrollHistory(employeeId, { limit: 10 });
  // A truck can reference this employee as either its driver or its
  // collector — both queried, only whichever actually matches renders.
  const { data: asDriverData } = useTrucks({ driver_id: employeeId });
  const { data: asCollectorData } = useTrucks({ collector_id: employeeId });

  const attendance = (attendanceData?.data || []).slice(0, 5);
  const leave = (leaveData?.data || []).slice(0, 5);
  const payroll = (payrollData?.data || []).slice(0, 5);
  const trucks = [...(asDriverData?.data || []), ...(asCollectorData?.data || [])];

  return (
    <>
      <Card style={{ ...cardPad, marginTop: '16px' }}>
        <Label>Recent Attendance</Label>
        {attendance.length === 0 && <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>No attendance records yet.</p>}
        {attendance.map((a) => (
          <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
            <span>{new Date(a.attendance_date).toLocaleDateString()}</span>
            <StatusBadge status={a.status} map={{ present: 'success', absent: 'danger', late: 'warning', on_leave: 'info', half_day: 'warning' }} />
          </div>
        ))}
      </Card>

      <Card style={{ ...cardPad, marginTop: '16px' }}>
        <Label>Leave Requests</Label>
        {leave.length === 0 && <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>No leave requests yet.</p>}
        {leave.map((l) => (
          <div key={l.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
            <span>{l.leave_type_label} — {new Date(l.start_date).toLocaleDateString()} to {new Date(l.end_date).toLocaleDateString()}</span>
            <StatusBadge status={l.status} map={{ pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'info' }} />
          </div>
        ))}
      </Card>

      <Card style={{ ...cardPad, marginTop: '16px' }}>
        <Label>Payroll History</Label>
        {payroll.length === 0 && <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>No payroll records yet.</p>}
        {payroll.map((p) => (
          <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
            <span>{p.period_label || p.payroll_period_id}</span>
            <span className="tabular-nums" style={{ fontWeight: 700 }}>{parseFloat(p.net_salary).toFixed(2)}</span>
            <StatusBadge status={p.status} map={{ open: 'info', processing: 'warning', finalized: 'success', paid: 'success', reversed: 'danger' }} />
          </div>
        ))}
      </Card>

      {(employeeType === 'driver' || employeeType === 'collector') && (
        <Card style={{ ...cardPad, marginTop: '16px' }}>
          <Label>Truck Assignment</Label>
          {trucks.length === 0 && <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>Not currently assigned to a truck.</p>}
          {trucks.map((t) => (
            <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
              <span>{t.plate_number}</span>
              <StatusBadge status={t.status} />
            </div>
          ))}
        </Card>
      )}
    </>
  );
}

const cardPad = { padding: '16px' };
const sectionLabelStyle = {
  display: 'block', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--text-muted)', margin: '0 0 10px',
};
const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
