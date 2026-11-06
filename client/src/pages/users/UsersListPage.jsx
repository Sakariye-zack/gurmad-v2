import React, { useState } from 'react';
import { ShieldCheck, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, ConfirmDialog, useToast } from '../../components/ui/index.js';
import { useUsers, useCreateUser, useDisableUser, useEnableUser, useRevokeUser, useResetUserTwoFactor } from '../../hooks/useUsers.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useEmployees } from '../../hooks/useEmployees.js';
import { useRoles } from '../../hooks/useRoles.js';
import UserEditModal from './UserEditModal.jsx';
import UserResetPasswordModal from './UserResetPasswordModal.jsx';
import PasswordStrength from '../../components/PasswordStrength.jsx';
import { isPasswordAcceptable } from '../../lib/passwordPolicy.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

// User & Access Administration — admin-only. Role assignment used to be
// restricted to 6 hardcoded strings; Dynamic Roles & Permissions
// (user-requested) now populates this dropdown from GET /v2/roles, so any
// custom role created on the new Roles & Permissions page shows up here too.

export default function UsersListPage() {
  const { data, isLoading, error, refetch } = useUsers();
  const { data: rolesData } = useRoles();
  const roles = rolesData?.data || [];
  const users = data?.data || [];
  const toast = useToast();
  const { t } = useI18n();
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ username: '', password: '', full_name: '', role_id: '', employee_id: '' });
  const [editingUser, setEditingUser] = useState(null);
  const [resettingUser, setResettingUser] = useState(null);

  const createUser = useCreateUser();
  const disableUser = useDisableUser();
  const enableUser = useEnableUser();
  const revokeUser = useRevokeUser();
  const resetTwoFactor = useResetUserTwoFactor();
  const { user: me } = useAuth();
  const [twoFactorResetUser, setTwoFactorResetUser] = useState(null);

  async function handleResetTwoFactor() {
    const u = twoFactorResetUser;
    try {
      await resetTwoFactor.mutateAsync(u.id);
      toast.success(t('users.reset2fa.done', undefined, { user: u.username }));
      setTwoFactorResetUser(null);
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
    }
  }
  // User-reported gap (Phase 10 Billing audit, continued sweep): this
  // field used to be a raw "type the employee's numeric id" input — same
  // class of bug already fixed (in the reverse direction) on
  // EmployeeFormModal.jsx's own "Linked user account" picker. Narrowed
  // to employees not already linked to a user account, so a mistaken
  // re-link can't happen through this picker.
  const { data: employeesData } = useEmployees();
  const unlinkedEmployees = (employeesData?.data || []).filter((e) => !e.user_id);

  async function handleCreate(e) {
    e.preventDefault();
    if (!isPasswordAcceptable(form.password, form.username)) {
      toast.error(t('pwPolicy.summary'));
      return;
    }
    try {
      await createUser.mutateAsync({
        username: form.username.trim(),
        password: form.password,
        full_name: form.full_name.trim() || undefined,
        role_id: form.role_id ? Number(form.role_id) : undefined,
        employee_id: form.employee_id ? Number(form.employee_id) : undefined,
      });
      toast.success('User created.');
      setFormOpen(false);
      setForm({ username: '', password: '', full_name: '', role_id: '', employee_id: '' });
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
            <input required type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} style={inputStyle} />
            <PasswordStrength password={form.password} username={form.username} />
            <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>{t('pwPolicy.mustChangeNote')}</p>
          </div>
          <div>
            <label style={labelStyle}>Full name</label>
            <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Role</label>
            <select required value={form.role_id} onChange={(e) => setForm({ ...form, role_id: e.target.value })} style={inputStyle}>
              <option value="">Select a role…</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Linked employee (optional)</label>
            <select value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} style={inputStyle}>
              <option value="">None</option>
              {unlinkedEmployees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.job_role || e.employee_type})</option>)}
            </select>
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
                <Button variant="ghost" style={smallBtnStyle} onClick={() => setResettingUser(u)}>Reset Password</Button>
                <Button variant="ghost" style={smallBtnStyle} onClick={() => handleRevoke(u.id)}>Revoke Sessions</Button>
                {u.two_factor_enabled && u.id !== me?.id && (
                  <Button variant="ghost" style={smallBtnStyle} onClick={() => setTwoFactorResetUser(u)}>{t('users.reset2fa.action')}</Button>
                )}
              </div>
            </td>
          </tr>
        ))}
      </DataTable>

      <UserEditModal open={!!editingUser} user={editingUser} onClose={() => setEditingUser(null)} />
      <UserResetPasswordModal open={!!resettingUser} user={resettingUser} onClose={() => setResettingUser(null)} />
      <ConfirmDialog
        open={!!twoFactorResetUser}
        onClose={() => setTwoFactorResetUser(null)}
        onConfirm={handleResetTwoFactor}
        title={t('users.reset2fa.title')}
        message={t('users.reset2fa.confirm', undefined, { user: twoFactorResetUser?.username || '' })}
        confirmLabel={t('users.reset2fa.action')}
        danger
        isLoading={resetTwoFactor.isPending}
      />
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const labelStyle = { display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px' };
const inputStyle = { width: '100%', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '13px', boxSizing: 'border-box' };
const smallBtnStyle = { padding: '6px 10px', fontSize: '12px' };
