import React, { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button, Card, PageHeader, ConfirmDialog, useToast } from '../../components/ui/index.js';
import { apiClient } from '../../lib/apiClient.js';

// User & Access Administration — self-service staff account security.
// Directly mirrors the Customer Portal's own already-proven
// PortalAccountSecurity.jsx pattern (password change swaps in a fresh
// token so this device stays signed in; logout-all is the explicit
// security-compromise-response action, OD-3) — no new UX pattern invented.
export default function AccountSecurity() {
  const toast = useToast();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [logoutAllConfirmOpen, setLogoutAllConfirmOpen] = useState(false);
  const [loggingOutAll, setLoggingOutAll] = useState(false);

  async function handleChangePassword(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiClient.post('/v2/auth/password/change', { currentPassword, newPassword });
      if (res.data?.token) apiClient.setToken(res.data.token);
      toast.success(res.data?.message || 'Password changed.');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  async function handleLogoutAll() {
    setLoggingOutAll(true);
    try {
      await apiClient.post('/v2/auth/logout-all', {});
      // Account-wide revocation invalidates THIS device's token too —
      // redirect to login, matching the Portal's own established
      // behavior for the same action.
      apiClient.clearToken();
      window.location.href = '/login';
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
      setLoggingOutAll(false);
    }
  }

  return (
    <div>
      <PageHeader icon={ShieldAlert} title="Account Security" subtitle="Password and session management for your own account." />

      <Card style={{ padding: '24px', maxWidth: '480px', marginBottom: '20px' }}>
        <h3 style={{ marginTop: 0 }}>Change Password</h3>
        <form onSubmit={handleChangePassword}>
          <label style={labelStyle}>Current Password</label>
          <input type="password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} style={inputStyle} />
          <label style={labelStyle}>New Password</label>
          <input type="password" required minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={inputStyle} />
          <Button type="submit" disabled={saving} style={{ marginTop: '14px' }}>{saving ? 'Saving…' : 'Change Password'}</Button>
        </form>
      </Card>

      <Card style={{ padding: '24px', maxWidth: '480px' }}>
        <h3 style={{ marginTop: 0 }}>Active Sessions</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
          If you believe your account may be compromised, sign out of every device at once. You will need to sign in again here too.
        </p>
        <Button variant="danger" onClick={() => setLogoutAllConfirmOpen(true)}>Log Out of All Devices</Button>
      </Card>

      <ConfirmDialog
        open={logoutAllConfirmOpen}
        title="Log out of all devices?"
        message="This will immediately end every active session for your account, including this one."
        confirmLabel="Log Out Everywhere"
        danger
        isLoading={loggingOutAll}
        onConfirm={handleLogoutAll}
        onClose={() => setLogoutAllConfirmOpen(false)}
      />
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginTop: '14px', marginBottom: '6px' };
const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '14px', boxSizing: 'border-box', fontFamily: 'inherit' };
