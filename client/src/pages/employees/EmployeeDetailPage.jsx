import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Users2, Pencil, Archive, RotateCcw } from 'lucide-react';
import { PageHeader, Button, Card, StatusBadge, LoadingState, ErrorState, ConfirmDialog, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useEmployee, useUpdateEmployeeStatus } from '../../hooks/useEmployees.js';
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <Card style={cardPad}><Label>Type</Label><Value style={{ textTransform: 'capitalize' }}>{employee.employee_type}</Value></Card>
        <Card style={cardPad}><Label>Status</Label><div style={{ marginTop: '6px' }}><StatusBadge status={employee.status} /></div></Card>
        <Card style={cardPad}><Label>Zone</Label><Value>{employee.zone_name || '— (company-wide)'}</Value></Card>
        <Card style={cardPad}><Label>Phone</Label><Value className="tabular-nums">{employee.phone}</Value></Card>
        {employee.employee_type === 'collector' && (
          <Card style={cardPad}>
            <Label>Collector classification</Label>
            <Value style={{ textTransform: 'capitalize' }}>
              {employee.collector_type || 'Not set'}{employee.commercial_shift ? ` — ${employee.commercial_shift}` : ''}
            </Value>
          </Card>
        )}
        <Card style={cardPad}><Label>Linked account</Label><Value>{employee.user_id != null ? `User #${employee.user_id}` : '— (no login account)'}</Value></Card>
        <Card style={cardPad}><Label>Join date</Label><Value>{employee.join_date || '—'}</Value></Card>
      </div>

      {hasSensitiveFields && (
        <>
          <span style={sectionLabelStyle}>Sensitive HR information</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
            <Card style={cardPad}><Label>Salary</Label><Value className="tabular-nums">{employee.salary != null ? employee.salary : '—'}</Value></Card>
            <Card style={cardPad}><Label>Guarantor</Label><Value>{employee.guarantor_name || '—'}</Value></Card>
            <Card style={cardPad}><Label>Guarantor phone</Label><Value className="tabular-nums">{employee.guarantor_phone || '—'}</Value></Card>
          </div>
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

      <Card style={{ ...cardPad, marginTop: '16px' }}>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>
          Attendance, payroll, leave, and truck assignment for this employee will appear here
          once their respective modules are implemented, per the approved one-module-at-a-time sequence.
        </p>
      </Card>

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
function Value({ children, style, className }) {
  return <div className={className} style={{ marginTop: '6px', fontSize: '15px', fontWeight: 700, ...style }}>{children}</div>;
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
