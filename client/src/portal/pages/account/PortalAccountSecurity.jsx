import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { Button, StatusBadge, LoadingState, ErrorState, ConfirmDialog, useToast } from '../../../components/ui/index.js';
import PortalPageHeader from '../../components/PortalPageHeader.jsx';
import PortalCard from '../../components/PortalCard.jsx';
import { portalApiClient } from '../../apiClient.js';

// Rebuild — Implementation Spec §21/§6: password change (now transparently
// swaps the stored token — the backend bumps token_version and returns a
// fresh one so THIS device stays logged in while every other device's
// token dies), account status, and "log out of all devices" (the concrete
// customer-facing security-compromise-response action, OD-3).
export default function PortalAccountSecurity() {
  const toast = useToast();
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    portalApiClient.get('/me')
      .then((res) => setProfile(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleChangePassword(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await portalApiClient.put('/me/password', { currentPassword, newPassword });
      // The old token is now invalid (token_version bumped) — swap in the
      // fresh one the server returned so this device's session continues
      // uninterrupted, matching the "you stay logged in here" copy below.
      if (res.data?.token) portalApiClient.setToken(res.data.token);
      toast.success('Password changed. You remain signed in on this device — other devices will need to sign in again.');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRevokeAll() {
    setRevoking(true);
    try {
      await portalApiClient.post('/me/revoke-sessions');
      // This device's own token is ALSO now dead (revocation is
      // account-wide, not per-device) — the correct behavior for an
      // explicit "log out everywhere" action, so redirect to login.
      portalApiClient.clearToken();
      window.location.href = '/portal/login';
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
      setRevoking(false);
    }
  }

  return (
    <div>
      <PortalPageHeader title="My Account" subtitle="Profile and security settings" />
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', borderBottom: '1px solid var(--border)' }}>
        <NavLink to="/portal/account/profile" style={({ isActive }) => tabStyle(isActive)}>Profile</NavLink>
        <NavLink to="/portal/account/security" style={({ isActive }) => tabStyle(isActive)}>Security</NavLink>
      </div>

      {loading ? <LoadingState label="Loading…" /> : error ? <ErrorState message={error} onRetry={load} /> : profile && (
        <>
          <PortalCard>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: '14px' }}>Account Status</h3>
              <StatusBadge status={profile.status} />
            </div>
          </PortalCard>

          <PortalCard style={{ marginTop: '16px' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: '14px' }}>Change Password</h3>
            <form onSubmit={handleChangePassword} style={{ maxWidth: '320px' }}>
              <label style={labelStyle}>Current Password</label>
              <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} style={inputStyle} required />
              <label style={labelStyle}>New Password</label>
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={inputStyle} required minLength={8} />
              <Button type="submit" disabled={saving} style={{ marginTop: '14px' }}>{saving ? 'Saving…' : 'Change Password'}</Button>
            </form>
          </PortalCard>

          <PortalCard style={{ marginTop: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <ShieldAlert size={16} color="#DC2626" />
              <h3 style={{ margin: 0, fontSize: '14px' }}>Log Out of All Devices</h3>
            </div>
            <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--text-muted)' }}>
              If you suspect your account has been accessed by someone else, use this to immediately end every
              signed-in session, including this one. You'll need to sign in again afterward.
            </p>
            <Button variant="danger" onClick={() => setRevokeConfirmOpen(true)}>Log Out Everywhere</Button>
          </PortalCard>
        </>
      )}

      <ConfirmDialog
        open={revokeConfirmOpen}
        onClose={() => setRevokeConfirmOpen(false)}
        onConfirm={handleRevokeAll}
        title="Log out of all devices?"
        message="This will immediately end every signed-in session on every device, including this one. You will need to sign in again."
        confirmLabel="Log Out Everywhere"
        danger
        isLoading={revoking}
      />
    </div>
  );
}

function tabStyle(isActive) {
  return {
    padding: '8px 4px', marginRight: '20px', fontSize: '13px', fontWeight: 700, textDecoration: 'none',
    color: isActive ? 'var(--brand)' : 'var(--text-muted)',
    borderBottom: isActive ? '2px solid var(--brand)' : '2px solid transparent',
  };
}

const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginTop: '12px', marginBottom: '6px' };
const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '14px', boxSizing: 'border-box' };
