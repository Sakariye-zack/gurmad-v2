import React, { useEffect, useState } from 'react';
import { ShieldCheck, Plus, Trash2 } from 'lucide-react';
import { PageHeader, Button, Card, LoadingState, ErrorState, ConfirmDialog, useToast } from '../../components/ui/index.js';
import { useRoles, usePermissionsCatalog, useCreateRole, useUpdateRolePermissions, useDeleteRole } from '../../hooks/useRoles.js';

// Dynamic Roles & Permissions — user-requested. A Super Admin creates a
// custom role and controls what it can see, without a developer touching
// code. This is the admin UI half of that feature — the other half is
// GET /v2/auth/my-permissions + RoleGate's `permission` check (already
// wired everywhere via client/src/layout/Sidebar.jsx's NAV array).
//
// Scope note, shown inline below: a custom role's permissions control
// Sidebar visibility for that role's users, but do not change what the
// rest of the backend's existing role-name checks allow — that is an
// explicitly separate, later phase.
export default function RolesPermissionsPage() {
  const { data: rolesData, isLoading, error, refetch } = useRoles();
  const { data: catalogData } = usePermissionsCatalog();
  const roles = rolesData?.data || [];
  const catalog = catalogData?.data || [];
  const toast = useToast();

  const [selectedId, setSelectedId] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [checked, setChecked] = useState(new Set());

  const createRole = useCreateRole();
  const updatePerms = useUpdateRolePermissions();
  const deleteRole = useDeleteRole();

  const selected = roles.find((r) => r.id === selectedId) || null;

  useEffect(() => {
    if (!selected) { setChecked(new Set()); return; }
    setChecked(new Set(selected.permissions || []));
  }, [selectedId, selected?.permissions?.join(',')]);

  useEffect(() => {
    if (!selectedId && roles.length > 0) setSelectedId(roles[0].id);
  }, [roles, selectedId]);

  const grouped = catalog.reduce((acc, p) => {
    (acc[p.module] ||= []).push(p);
    return acc;
  }, {});

  function toggle(key) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function handleCreate(e) {
    e.preventDefault();
    try {
      const result = await createRole.mutateAsync({ label: newLabel.trim() });
      toast.success('Role created.');
      setCreateOpen(false);
      setNewLabel('');
      setSelectedId(result.data.id);
    } catch (err) {
      toast.error(err.message || 'Failed to create role.');
    }
  }

  async function handleSave() {
    if (!selected) return;
    try {
      await updatePerms.mutateAsync({ id: selected.id, permission_keys: Array.from(checked) });
      toast.success('Permissions saved.');
    } catch (err) {
      toast.error(err.message || 'Failed to save permissions.');
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    try {
      await deleteRole.mutateAsync(deleteTarget.id);
      toast.success('Role deleted.');
      setDeleteTarget(null);
      if (selectedId === deleteTarget.id) setSelectedId(null);
    } catch (err) {
      toast.error(err.message || 'Failed to delete role.');
    }
  }

  if (isLoading) return <LoadingState label="Loading roles…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;

  return (
    <div>
      <PageHeader
        icon={ShieldCheck}
        title="Roles & Permissions"
        subtitle="Create custom roles and control exactly what each one can see."
        actions={<Button icon={Plus} onClick={() => setCreateOpen((o) => !o)}>New Role</Button>}
      />

      <Card style={{ padding: '14px 16px', marginBottom: '20px', background: 'var(--warning-bg, var(--bg))', border: '1px solid var(--border)' }}>
        <p style={{ margin: 0, fontSize: '12.5px', color: 'var(--text-muted)' }}>
          A custom role's permissions control what its users see in the sidebar. Actions inside pages built for the
          6 original roles (admin, gudoomiye, zone_accountant, head_of_cashiers, cashier, collector) may still be
          denied by the backend for a brand-new custom role until those pages are separately updated to recognize it.
        </p>
      </Card>

      {createOpen && (
        <form onSubmit={handleCreate} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '16px', marginBottom: '20px', display: 'flex', gap: '12px', alignItems: 'end' }}>
          <div style={{ flex: 1 }}>
            <label style={labelStyle}>Role name</label>
            <input required value={newLabel} onChange={(e) => setNewLabel(e.target.value)} placeholder="e.g. Regional Supervisor" style={inputStyle} />
          </div>
          <Button type="submit" disabled={createRole.isPending}>{createRole.isPending ? 'Creating…' : 'Create'}</Button>
        </form>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: '20px', alignItems: 'start' }}>
        <Card style={{ padding: '8px' }}>
          {roles.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedId(r.id)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
                padding: '10px 12px', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer', marginBottom: '2px',
                background: r.id === selectedId ? 'var(--success-bg)' : 'transparent',
                color: r.id === selectedId ? 'var(--brand)' : 'var(--text)', fontWeight: 700, fontSize: '13px', textAlign: 'left',
              }}
            >
              <span>{r.label}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                {r.is_system && <span style={{ fontSize: '10px', fontWeight: 800, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: '4px', padding: '1px 5px' }}>SYSTEM</span>}
                {!r.is_system && (
                  <Trash2
                    size={14}
                    style={{ color: 'var(--danger)' }}
                    onClick={(e) => { e.stopPropagation(); setDeleteTarget(r); }}
                  />
                )}
              </span>
            </button>
          ))}
        </Card>

        {selected ? (
          <Card style={{ padding: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <h3 style={{ margin: 0, fontSize: '15px' }}>{selected.label}</h3>
              <Button onClick={handleSave} disabled={updatePerms.isPending}>{updatePerms.isPending ? 'Saving…' : 'Save Permissions'}</Button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '16px' }}>
              {Object.entries(grouped).map(([module, perms]) => (
                <div key={module}>
                  <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)', marginBottom: '6px' }}>
                    {module.replace(/_/g, ' ')}
                  </div>
                  {perms.map((p) => (
                    <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', padding: '4px 0', cursor: 'pointer' }}>
                      <input type="checkbox" checked={checked.has(p.key)} onChange={() => toggle(p.key)} />
                      {p.label}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </Card>
        ) : (
          <Card style={{ padding: '16px' }}><p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>Select a role to edit its permissions.</p></Card>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={`Delete "${deleteTarget?.label}"?`}
        message="This cannot be undone. Users currently assigned to this role must be reassigned first."
        confirmLabel="Delete Role"
        danger
        isLoading={deleteRole.isPending}
      />
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '4px' };
const inputStyle = { width: '100%', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '13px', boxSizing: 'border-box' };
