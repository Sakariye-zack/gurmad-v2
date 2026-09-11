import React, { useState } from 'react';
import { ShieldCheck, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, useToast } from '../../components/ui/index.js';
import { useUsers, useCreateUser, useDisableUser, useEnableUser, useRevokeUser } from '../../hooks/useUsers.js';
import UserEditModal from './UserEditModal.jsx';

// User & Access Administration — admin-only. Role assignment is
// restricted to the 7 approved static roles (OD-2) — this page never
// offers a way to type a free-text role or create a new one.
const APPROVED_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier', 'collector'];

export default function UsersListPage() {
  const { data, isLoading, error, refetch } = useUsers();
  const users = data?.data || [];
  const toast = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', full_name: '', role: 'cashier', employee_id: '' });
  const [editingUser, setEditingUser] = useState(null);

  const createUser = useCreateUser();
  const disableUser = useDisableUser();
  const enableUser = useEnableUser();
  const revokeUser = useRevokeUser();

  async function handleCreate(e) {
    e.preventDefault();
    try {
      await createUser.mutateAsync({
        username: form.username.trim(),
        password: form.password,
        full_name: form.full_name.trim() || undefined,
        role: form.role,
        employee_id: form.employee_id ? Number(form.employee_id) : undefined,
      });
      toast.success('User created.');
      setFormOpen(false);
      setForm({ username: '', password: '', full_name: '', role: 'cashier', employee_id: '' });
    } catch (err) {
      toast.error(err.message || 'Failed to create user.');
    }
  }

  async function handleDisable(id) {
    try { await disableUser.mutateAsync(id); toast.success('User disabled — active sessions revoked.'); }
    catch (err) { toast.error(err.message || 'Failed to disable user.'); }
  }
  async function handleEnable(id) {
    try { await enableUser.mutateAsync(id); toast.success('User re-enabled.'); }
    catch (err) { toast.error(err.message || 'Failed to enable user.'); }
  }
  async function handleRevoke(id) {
    try { await revokeUser.mutateAsync(id); toast.success('All active sessions revoked for this user.'); }
    catch (err) { toast.error(err.message || 'Failed to revoke sessions.'); }
  }

  return (
    <div>
      <PageHeader
        icon={ShieldCheck}
        title="Users & Access"
        subtitle="Staff accounts, roles, and session security."
        actions={<Button icon={Plus} onClick={() => setFormOpen((o) => !o)}>Create User</Button>}
      />

      {formOpen && (
        <form onSubmit={handleCreate} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px', marginBottom: '20px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', alignItems: 'end' }}>
          <div>
            <label style={labelStyle}>Username</label>
            <input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Password</label>
            <input required type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Full name</label>
            <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Role</label>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} style={inputStyle}>
              {APPROVED_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Employee ID (optional)</label>
            <input value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} style={inputStyle} placeholder="Links to an existing employee" />
          </div>
          <Button type="submit" disabled={createUser.isPending}>{createUser.isPending ? 'Creating…' : 'Create'}</Button>
        </form>
      )}

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && users.length === 0}
        emptyTitle="No users yet"
        emptySubtitle="Create the first V2-native user account to get started."
        columns={[
          { label: 'Username' }, { label: 'Role' }, { label: 'Zone' }, { label: 'Employee' },
          { label: 'Auth Source' }, { label: 'Status' }, { label: 'Actions' },
        ]}
      >
        {users.map((u) => (
          <tr key={u.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}><strong>{u.username}</strong>{u.full_name ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> — {u.full_name}</span> : ''}</td>
            <td style={cellStyle}><span style={{ textTransform: 'capitalize' }}>{u.role.replace('_', ' ')}</span></td>
            <td style={cellStyle}>{u.zone || '—'}</td>
            <td style={cellStyle}>
              {u.employee_name ? (
                <span>{u.employee_name} <StatusBadge status={u.employee_status} /></span>
              ) : '—'}
            </td>
            <td style={cellStyle}><span style={{ textTransform: 'uppercase', fontSize: '11px', color: 'var(--text-muted)' }}>{u.auth_source}</span></td>
            <td style={cellStyle}>
              <StatusBadge status={u.is_active ? 'active' : 'disabled'} />
              {u.locked_until && new Date(u.locked_until) > new Date() && <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--danger)' }}>locked</span>}
            </td>
            <td style={cellStyle}>
              <div style={{ display: 'flex', gap: '6px' }}>
                <Button variant="ghost" style={smallBtnStyle} onClick={() => setEditingUser(u)}>Edit</Button>
                {u.is_active ? (
                  <Button variant="ghost" style={smallBtnStyle} onClick={() => handleDisable(u.id)}>Disable</Button>
                ) : (
                  <Button variant="ghost" style={smallBtnStyle} onClick={() => handleEnable(u.id)}>Enable</Button>
                )}
                <Button variant="ghost" style={smallBtnStyle} onClick={() => handleRevoke(u.id)}>Revoke Sessions</Button>
              </div>
            </td>
          </tr>
        ))}
      </DataTable>

      <UserEditModal open={!!editingUser} user={editingUser} onClose={() => setEditingUser(null)} />
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const labelStyle = { display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px' };
const inputStyle = { width: '100%', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '13px', boxSizing: 'border-box' };
const smallBtnStyle = { padding: '6px 10px', fontSize: '12px' };
