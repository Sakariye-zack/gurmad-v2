import React, { useEffect, useRef, useState } from 'react';
import { ShieldCheck, Plus, X, Users, UserCheck, UserX, UserPlus, KeyRound, Lock, LogOut, ShieldOff, Pencil, MoreHorizontal } from 'lucide-react';
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

  const isLocked = (u) => u.locked_until && new Date(u.locked_until) > new Date();
  const counts = {
    total: users.length,
    active: users.filter((u) => u.is_active).length,
    twoFactor: users.filter((u) => u.two_factor_enabled).length,
    locked: users.filter(isLocked).length,
  };

  return (
    <div>
      <PageHeader
        icon={ShieldCheck}
        title="Users & Access"
        subtitle="Staff accounts, roles, and session security."
        actions={<Button icon={formOpen ? X : Plus} variant={formOpen ? 'secondary' : undefined} onClick={() => setFormOpen((o) => !o)}>{formOpen ? 'Close' : 'Create User'}</Button>}
      />

      {!isLoading && users.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '18px' }}>
          <SummaryChip icon={Users} label="Users" value={counts.total} />
          <SummaryChip icon={UserCheck} label="Active" value={counts.active} tone="var(--success)" />
          <SummaryChip icon={KeyRound} label="2FA on" value={`${counts.twoFactor}/${counts.total}`} tone={counts.twoFactor === counts.total ? 'var(--success)' : 'var(--warning)'} />
          {counts.locked > 0 && <SummaryChip icon={Lock} label="Locked" value={counts.locked} tone="var(--danger)" />}
        </div>
      )}

      {formOpen && (
        <form onSubmit={handleCreate} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg, 14px)', padding: '20px', marginBottom: '20px', boxShadow: 'var(--shadow-sm)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--brand-soft, rgba(74,222,128,0.15))', color: 'var(--brand)', display: 'grid', placeItems: 'center' }}><UserPlus size={18} /></div>
            <div>
              <div style={{ fontWeight: 800, fontSize: '15px' }}>New user</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('pwPolicy.mustChangeNote')}</div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px 16px' }}>
            <Field label="Username">
              <input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} style={inputStyle} autoComplete="off" />
            </Field>
            <Field label="Full name">
              <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} style={inputStyle} />
            </Field>
            <Field label="Temporary password">
              <input required type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} style={inputStyle} />
              <PasswordStrength password={form.password} username={form.username} />
            </Field>
            <Field label="Role">
              <select required value={form.role_id} onChange={(e) => setForm({ ...form, role_id: e.target.value })} style={inputStyle}>
                <option value="">Select a role…</option>
                {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </Field>
            <Field label="Linked employee (optional)">
              <select value={form.employee_id} onChange={(e) => setForm({ ...form, employee_id: e.target.value })} style={inputStyle}>
                <option value="">None</option>
                {unlinkedEmployees.map((e) => <option key={e.id} value={e.id}>{e.name} ({e.job_role || e.employee_type})</option>)}
              </select>
            </Field>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '18px', paddingTop: '14px', borderTop: '1px solid var(--border)' }}>
            <Button type="button" variant="ghost" onClick={() => setFormOpen(false)}>Cancel</Button>
            <Button type="submit" icon={UserPlus} disabled={createUser.isPending}>{createUser.isPending ? 'Creating…' : 'Create user'}</Button>
          </div>
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
          { label: 'User' }, { label: 'Role' }, { label: 'Employee' }, { label: 'Security' }, { label: 'Status' }, { label: '' },
        ]}
      >
        {users.map((u) => {
          const display = u.full_name || u.username;
          const isMe = u.id === me?.id;
          return (
            <tr key={u.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={cellStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <Initials name={display} muted={!u.is_active} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {display}
                      {isMe && <span style={tagStyle('var(--brand)')}>You</span>}
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>@{u.username}{u.zone ? ` · ${u.zone}` : ''}</div>
                  </div>
                </div>
              </td>
              <td style={cellStyle}><RolePill role={u.role} /></td>
              <td style={cellStyle}>
                {u.employee_name ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                    {u.employee_name === u.full_name ? <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Linked</span> : u.employee_name}
                    <StatusBadge status={u.employee_status} />
                  </div>
                ) : <span style={{ color: 'var(--text-muted)' }}>Not linked</span>}
              </td>
              <td style={cellStyle}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  <span style={tagStyle(u.two_factor_enabled ? 'var(--success)' : 'var(--text-muted)')} title="Two-factor authentication">
                    <KeyRound size={11} /> {u.two_factor_enabled ? '2FA on' : '2FA off'}
                  </span>
                  {u.must_change_password && <span style={tagStyle('var(--warning)')}>Must change password</span>}
                  {u.auth_source && u.auth_source !== 'v2' && <span style={tagStyle('var(--text-muted)')}>{String(u.auth_source).toUpperCase()}</span>}
                </div>
              </td>
              <td style={cellStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <StatusBadge status={u.is_active ? 'active' : 'disabled'} />
                  {isLocked(u) && <span style={tagStyle('var(--danger)')}><Lock size={11} /> Locked</span>}
                </div>
              </td>
              <td style={{ ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                <div style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
                  <Button variant="ghost" icon={Pencil} style={smallBtnStyle} onClick={() => setEditingUser(u)}>Edit</Button>
                  <ActionMenu items={[
                    u.is_active
                      ? { label: 'Disable user', icon: UserX, danger: true, onClick: () => handleDisable(u.id), hidden: isMe }
                      : { label: 'Enable user', icon: UserCheck, onClick: () => handleEnable(u.id) },
                    { label: 'Reset password', icon: KeyRound, onClick: () => setResettingUser(u) },
                    { label: 'Sign out everywhere', icon: LogOut, onClick: () => handleRevoke(u.id) },
                    { label: t('users.reset2fa.action'), icon: ShieldOff, danger: true, onClick: () => setTwoFactorResetUser(u), hidden: !u.two_factor_enabled || isMe },
                  ]} />
                </div>
              </td>
            </tr>
          );
        })}
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

function Field({ label, children }) {
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      {children}
    </div>
  );
}

function SummaryChip({ icon: Icon, label, value, tone = 'var(--text)' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', minWidth: '130px' }}>
      <Icon size={16} color={tone} />
      <div>
        <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
        <div style={{ fontSize: '17px', fontWeight: 800, color: tone }} className="tabular-nums">{value}</div>
      </div>
    </div>
  );
}

// Two-letter initials on a colour derived from the name, so each person is recognisable at a glance.
function Initials({ name, muted }) {
  const parts = String(name || '?').trim().split(/\s+/);
  const letters = ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] || ''))).toUpperCase();
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <div style={{
      width: 36, height: 36, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center',
      fontSize: '13px', fontWeight: 800, color: '#fff', background: muted ? 'var(--text-muted)' : `hsl(${h} 45% 40%)`,
    }}>{letters || '?'}</div>
  );
}

const ROLE_TONES = {
  admin: 'var(--danger)', gudoomiye: 'var(--brand)', zone_accountant: 'var(--info)',
  head_of_cashiers: 'var(--warning)', cashier: 'var(--warning)', collector: 'var(--success)',
};
function RolePill({ role }) {
  const tone = ROLE_TONES[role] || 'var(--text-muted)';
  return <span style={{ ...tagStyle(tone), textTransform: 'capitalize', fontSize: '12px' }}>{String(role || '').replace(/_/g, ' ')}</span>;
}

function ActionMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const visible = items.filter((i) => i && !i.hidden);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        style={{ width: 32, height: 32, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div role="menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 20, minWidth: '200px', padding: '6px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', textAlign: 'left' }}>
          {visible.map((i) => (
            <button key={i.label} type="button" role="menuitem" onClick={() => { setOpen(false); i.onClick(); }}
              style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', padding: '8px 10px', border: 'none', borderRadius: 'var(--radius-sm)', background: 'transparent', color: i.danger ? 'var(--danger)' : 'var(--text)', fontSize: '13px', fontWeight: 600, cursor: 'pointer', textAlign: 'left' }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
              <i.icon size={15} /> {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function tagStyle(tone) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', borderRadius: '999px',
    fontSize: '11px', fontWeight: 700, color: tone, border: `1px solid ${tone}`, background: 'transparent', whiteSpace: 'nowrap',
  };
}

const cellStyle = { padding: '12px 14px', verticalAlign: 'middle' };
const labelStyle = { display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.04em' };
const inputStyle = { width: '100%', padding: '9px 11px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: '13px', boxSizing: 'border-box' };
const smallBtnStyle = { padding: '6px 10px', fontSize: '12px' };
