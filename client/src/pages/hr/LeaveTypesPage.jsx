import React, { useState } from 'react';
import { Tags, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useLeaveTypes, useCreateLeaveType, useSetLeaveTypeStatus } from '../../hooks/useLeave.js';

export default function LeaveTypesPage() {
  const [formOpen, setFormOpen] = useState(false);
  const { data, isLoading, error, refetch } = useLeaveTypes();
  const setStatus = useSetLeaveTypeStatus();
  const toast = useToast();
  const types = data?.data || [];

  async function toggleStatus(type) {
    try {
      await setStatus.mutateAsync({ id: type.id, status: type.status === 'active' ? 'inactive' : 'active' });
      toast.success(`${type.label} is now ${type.status === 'active' ? 'inactive' : 'active'}.`);
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    }
  }

  return (
    <div>
      <PageHeader
        icon={Tags}
        title="Leave Types"
        subtitle="The controlled catalog of leave categories staff can request."
        actions={
          <RoleGate roles={['admin']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>New Leave Type</Button>
          </RoleGate>
        }
      />

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && types.length === 0}
        emptyTitle="No leave types"
        columns={[{ label: 'Code' }, { label: 'Label' }, { label: 'Paid' }, { label: 'Status' }, { label: 'Actions' }]}
      >
        {types.map((t) => (
          <tr key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle} className="tabular-nums">{t.code}</td>
            <td style={cellStyle}>{t.label}</td>
            <td style={cellStyle}>{t.is_paid ? 'Yes' : 'No'}</td>
            <td style={cellStyle}><StatusBadge status={t.status} map={{ active: 'success', inactive: 'info' }} /></td>
            <td style={cellStyle}>
              <RoleGate roles={['admin']}>
                <Button variant="secondary" onClick={() => toggleStatus(t)} disabled={setStatus.isPending}>
                  {t.status === 'active' ? 'Deactivate' : 'Activate'}
                </Button>
              </RoleGate>
            </td>
          </tr>
        ))}
      </DataTable>

      <LeaveTypeFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function LeaveTypeFormModal({ open, onClose }) {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [isPaid, setIsPaid] = useState(true);
  const [error, setError] = useState('');
  const create = useCreateLeaveType();
  const toast = useToast();

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!code || !label) { setError('Code and label are required.'); return; }
    try {
      await create.mutateAsync({ code, label, is_paid: isPaid });
      toast.success(`${label} created.`);
      setCode(''); setLabel(''); setIsPaid(true);
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={create.isPending ? () => {} : onClose}
      title="New Leave Type"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={create.isPending}>Cancel</Button>
        <Button type="submit" form="leave-type-form" disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Create'}</Button>
      </>}
    >
      <form id="leave-type-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Code</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} style={inputStyle} placeholder="e.g. maternity" />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Label</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} style={inputStyle} placeholder="e.g. Maternity" />
        </label>
        <label style={{ ...fieldStyle, flexDirection: 'row', alignItems: 'center', gap: '8px' }}>
          <input type="checkbox" checked={isPaid} onChange={(e) => setIsPaid(e.target.checked)} />
          <span style={labelStyle}>Paid leave</span>
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

const cellStyle = { padding: '12px 14px' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
