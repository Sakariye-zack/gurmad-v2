import React, { useEffect, useState } from 'react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import { useUpdateUser } from '../../hooks/useUsers.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useRoles } from '../../hooks/useRoles.js';

// Roles the app elsewhere treats as zone-scoped (Sidebar.jsx's own
// ZONE_SCOPED_ROLES-shaped lists, RoleGate usage across the codebase) —
// not a new rule invented here, just mirrored so the Zone field's
// required/optional framing matches what the rest of the app already
// assumes about these roles. Dynamic Roles & Permissions (user-requested):
// a custom role is treated as zone-scoped too (safer default — it can
// always be left blank if genuinely company-wide).
const COMPANY_WIDE_ROLES = ['admin'];

// User-requested gap fix (Phase 10): the backend (routes/users.js PUT
// /:id) and even a working mutation hook (useUpdateUser, useUsers.js)
// already existed and were fully wired — Users & Access simply had no
// Edit entry point anywhere in the UI, so an account's Zone (or role, or
// display name) could only ever be set once, at creation, with no way to
// correct or update it afterward. This modal is the missing entry point
// only — no new backend/hook logic.
export default function UserEditModal({ open, onClose, user }) {
  if (!open || !user) return null;
  return <Content onClose={onClose} user={user} />;
}

function Content({ onClose, user }) {
  const [fullName, setFullName] = useState(user.full_name || '');
  const [roleId, setRoleId] = useState(user.role_id ? String(user.role_id) : '');
  const toast = useToast();
  const updateUser = useUpdateUser();
  const { data: zonesData } = useZonesList();
  const { data: rolesData } = useRoles();
  const roles = rolesData?.data || [];
  const zones = zonesData?.data || [];
  const selectedRole = roles.find((r) => String(r.id) === roleId);
  const isZoneScoped = !COMPANY_WIDE_ROLES.includes(selectedRole?.key || user.role);

  // Fallback for a user row with no role_id yet (pre-migration or a raw
  // legacy row) — resolve it from the role KEY string once roles load.
  useEffect(() => {
    if (roleId || roles.length === 0) return;
    const match = roles.find((r) => r.key === user.role);
    if (match) setRoleId(String(match.id));
  }, [roles, roleId, user.role]);

  // v2_users.zone stores the zone's NAME (string), not an id (confirmed in
  // routes/users.js — no FK, just VARCHAR) — the dropdown below still
  // offers real zones by id/name pair for a correct list, but what's sent
  // back is the matching zone's name, to stay consistent with what every
  // existing row already has (e.g. "Farah Omar", not a numeric id).
  const [zoneName, setZoneName] = useState(user.zone || '');

  async function handleSubmit(e) {
    e.preventDefault();
    try {
      await updateUser.mutateAsync({
        id: user.id,
        full_name: fullName.trim() || null,
        role_id: roleId ? Number(roleId) : undefined,
        zone: isZoneScoped ? (zoneName || null) : null,
      });
      toast.success(`${user.username} updated.`);
      onClose();
    } catch (err) {
      toast.error(err.message || 'Failed to update user.');
    }
  }

  return (
    <Modal
      open
      onClose={updateUser.isPending ? () => {} : onClose}
      title={`Edit User — ${user.username}`}
      maxWidth="440px"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={updateUser.isPending}>Cancel</Button>
          <Button type="submit" form="user-edit-form" disabled={updateUser.isPending}>{updateUser.isPending ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      <form id="user-edit-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <Field label="Full name">
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} style={inputStyle} />
        </Field>

        <Field label="Role">
          <select value={roleId} onChange={(e) => setRoleId(e.target.value)} style={inputStyle}>
            {roles.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </Field>

        <Field
          label={isZoneScoped ? 'Zone (required for this role)' : 'Zone'}
          hint={!isZoneScoped ? 'This role is company-wide — zone is not used.' : undefined}
        >
          <select value={zoneName} onChange={(e) => setZoneName(e.target.value)} style={inputStyle} disabled={!isZoneScoped}>
            <option value="">{isZoneScoped ? 'Select a zone…' : 'No zone (company-wide)'}</option>
            {zones.map((z) => <option key={z.id} value={z.name}>{z.name}</option>)}
          </select>
        </Field>
      </form>
    </Modal>
  );
}

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '12px', fontWeight: 700 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{hint}</span>}
    </label>
  );
}

const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
