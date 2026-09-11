import React, { useState } from 'react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import { useCreateEmployee, useUpdateEmployee } from '../../hooks/useEmployees.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useUsers } from '../../hooks/useUsers.js';
import { useAuth } from '../../auth/AuthContext.jsx';

const EMPTY = {
  name: '', job_role: '', employee_type: 'office', phone: '', zone_id: '',
  collector_type: '', commercial_shift: '', salary: '', join_date: '',
  guarantor_name: '', guarantor_phone: '', notes: '', user_id: '',
};

function toFormState(employee) {
  if (!employee) return EMPTY;
  return {
    name: employee.name || '', job_role: employee.job_role || '', employee_type: employee.employee_type || 'office',
    phone: employee.phone || '', zone_id: employee.zone_id != null ? String(employee.zone_id) : '',
    collector_type: employee.collector_type || '', commercial_shift: employee.commercial_shift || '',
    salary: employee.salary ?? '', join_date: employee.join_date ? String(employee.join_date).slice(0, 10) : '',
    guarantor_name: employee.guarantor_name || '', guarantor_phone: employee.guarantor_phone || '',
    notes: employee.notes || '', user_id: employee.user_id != null ? String(employee.user_id) : '',
  };
}

// Create Employee + Edit Employee — one shared form. Only mounted while
// `open` is true (same pattern as Zones/Customers — clean initial state on
// every open, no setState-in-effect resync).
export default function EmployeeFormModal({ open, onClose, employee }) {
  if (!open) return null;
  return <Content onClose={onClose} employee={employee} />;
}

function Content({ onClose, employee }) {
  const isEdit = !!employee;
  const [form, setForm] = useState(() => toFormState(employee));
  const [fieldErrors, setFieldErrors] = useState({});
  const toast = useToast();
  const createEmployee = useCreateEmployee();
  const updateEmployee = useUpdateEmployee(employee?.id);
  const { data: zonesData } = useZonesList();
  const zones = zonesData?.data || [];
  // "Linked user account" picker (user-requested fix — was a raw numeric
  // ID text box: "e.g. 3", nothing to look the number up against). Only
  // admin can actually list users (GET /v2/users is admin-only), so the
  // dropdown is admin-only too; a non-admin sees the original ID input
  // unchanged, since they have no way to look up a valid one either way.
  const isAdmin = (useAuth().user?.role || '').toLowerCase() === 'admin';
  const { data: usersData } = useUsers(isAdmin);
  const users = usersData?.data || [];
  const busy = createEmployee.isPending || updateEmployee.isPending;
  const isCollector = form.employee_type === 'collector';
  const isCommercial = form.collector_type === 'commercial';

  function set(field, value) {
    setForm((f) => {
      const next = { ...f, [field]: value };
      // Clearing a no-longer-applicable field when its trigger changes —
      // keeps the payload consistent with the server's own validation
      // rules (collector_type only for collectors, shift only for
      // commercial), not just visually hidden.
      if (field === 'employee_type' && value !== 'collector') {
        next.collector_type = '';
        next.commercial_shift = '';
        next.zone_id = f.zone_id; // zone is not cleared — becoming non-collector doesn't force-clear an existing zone
      }
      if (field === 'collector_type' && value !== 'commercial') {
        next.commercial_shift = '';
      }
      return next;
    });
  }

  function validate() {
    const errs = {};
    if (!form.name.trim()) errs.name = 'Name is required.';
    if (!form.phone.trim()) errs.phone = 'Phone is required.';
    if (isCollector && !form.zone_id) errs.zone_id = 'Zone is required for collectors.';
    if (form.user_id && !/^\d+$/.test(form.user_id.trim())) errs.user_id = 'User ID must be a positive number.';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validate()) return;

    const payload = {
      name: form.name.trim(), phone: form.phone.trim(), employee_type: form.employee_type,
      job_role: form.job_role.trim() || null,
      zone_id: form.zone_id ? parseInt(form.zone_id, 10) : null,
      collector_type: isCollector ? (form.collector_type || null) : null,
      commercial_shift: isCollector && isCommercial ? (form.commercial_shift || null) : null,
      salary: form.salary === '' ? null : parseFloat(form.salary),
      join_date: form.join_date || null,
      guarantor_name: form.guarantor_name.trim() || null,
      guarantor_phone: form.guarantor_phone.trim() || null,
      notes: form.notes.trim() || null,
      user_id: form.user_id.trim() ? parseInt(form.user_id.trim(), 10) : null,
    };
    try {
      if (isEdit) {
        await updateEmployee.mutateAsync(payload);
        toast.success(`${payload.name} updated.`);
      } else {
        await createEmployee.mutateAsync(payload);
        toast.success(`${payload.name} created.`);
      }
      onClose();
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={isEdit ? 'Edit Employee' : 'Create Employee'}
      maxWidth="620px"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="employee-form" disabled={busy}>{busy ? 'Saving…' : 'Save Employee'}</Button>
        </>
      }
    >
      <form id="employee-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <Field label="Full name" error={fieldErrors.name}>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} style={inputStyle} />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label="Phone" error={fieldErrors.phone}>
            <input value={form.phone} onChange={(e) => set('phone', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Job title">
            <input value={form.job_role} onChange={(e) => set('job_role', e.target.value)} style={inputStyle} placeholder="e.g. Driver, Accountant" />
          </Field>
        </div>

        <Field label="Employee type">
          <select value={form.employee_type} onChange={(e) => set('employee_type', e.target.value)} style={inputStyle}>
            <option value="office">Office</option>
            <option value="driver">Driver</option>
            <option value="collector">Collector</option>
            <option value="cashier">Cashier</option>
            <option value="head_of_cashiers">Head of Cashiers</option>
            <option value="other">Other</option>
          </select>
        </Field>

        <Field label={`Zone${isCollector ? ' (required for collectors)' : ' (optional)'}`} error={fieldErrors.zone_id}>
          <select value={form.zone_id} onChange={(e) => set('zone_id', e.target.value)} style={inputStyle}>
            <option value="">{isCollector ? 'Select a zone…' : 'No zone (company-wide)'}</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </Field>

        {isCollector && (
          <>
            <Field label="Collector type">
              <select value={form.collector_type} onChange={(e) => set('collector_type', e.target.value)} style={inputStyle}>
                <option value="">Not set</option>
                <option value="residential">Residential</option>
                <option value="commercial">Commercial</option>
              </select>
            </Field>
            {isCommercial && (
              <Field label="Commercial shift">
                <select value={form.commercial_shift} onChange={(e) => set('commercial_shift', e.target.value)} style={inputStyle}>
                  <option value="">Not set</option>
                  <option value="day">Day</option>
                  <option value="night">Night</option>
                </select>
              </Field>
            )}
          </>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label="Salary">
            <input type="number" value={form.salary} onChange={(e) => set('salary', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Join date">
            <input type="date" value={form.join_date} onChange={(e) => set('join_date', e.target.value)} style={inputStyle} />
          </Field>
        </div>

        {isAdmin ? (
          <Field label="Linked user account (optional)" hint="For collectors who sign in to the Collector Mobile app — links this employee to their login.">
            <select value={form.user_id} onChange={(e) => set('user_id', e.target.value)} style={inputStyle}>
              <option value="">No linked account</option>
              {users.map((u) => {
                // A user already linked to a DIFFERENT employee is shown
                // but disabled — picking it here would silently steal the
                // link from whichever employee currently has it, which the
                // backend itself doesn't guard against (user_id has no
                // uniqueness constraint), so it's guarded here instead.
                const linkedElsewhere = u.employee_id && u.employee_id !== employee?.id;
                return (
                  <option key={u.id} value={u.id} disabled={linkedElsewhere}>
                    {u.full_name || u.username} ({u.username}, {u.role}){linkedElsewhere ? ` — already linked to ${u.employee_name}` : ''}
                  </option>
                );
              })}
            </select>
          </Field>
        ) : (
          <Field label="Linked user account ID" error={fieldErrors.user_id} hint="Optional, recorded as a reference only — not verified against the login system.">
            <input value={form.user_id} onChange={(e) => set('user_id', e.target.value)} style={inputStyle} placeholder="e.g. 3" />
          </Field>
        )}

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '10px', marginTop: '2px' }}>
          <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>
            Sensitive HR information
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label="Guarantor name">
            <input value={form.guarantor_name} onChange={(e) => set('guarantor_name', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Guarantor phone">
            <input value={form.guarantor_phone} onChange={(e) => set('guarantor_phone', e.target.value)} style={inputStyle} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} maxLength={2000} />
        </Field>
      </form>
    </Modal>
  );
}

function Field({ label, error, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '12px', fontWeight: 700 }}>{label}</span>
      {children}
      {hint && !error && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{hint}</span>}
      {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
    </label>
  );
}

const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
