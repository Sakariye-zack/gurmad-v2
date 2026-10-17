import React, { useState } from 'react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import { useResetUserPassword } from '../../hooks/useUsers.js';

// Admin-set password for another user (forgotten password). The backend
// also signs the user out everywhere and clears any failed-login lockout.
export default function UserResetPasswordModal({ open, onClose, user }) {
  if (!open || !user) return null;
  return <Content onClose={onClose} user={user} />;
}

function Content({ onClose, user }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  const reset = useResetUserPassword();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (password !== confirm) return setError('The two passwords do not match.');
    try {
      await reset.mutateAsync({ id: user.id, password });
      toast.success(`Password reset for ${user.username} — they were signed out everywhere.`);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to reset password.');
    }
  }

  return (
    <Modal
      open
      onClose={reset.isPending ? () => {} : onClose}
      title={`Reset Password — ${user.username}`}
      maxWidth="440px"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={reset.isPending}>Cancel</Button>
          <Button type="submit" form="user-reset-password-form" disabled={reset.isPending}>{reset.isPending ? 'Resetting…' : 'Reset Password'}</Button>
        </>
      }
    >
      <form id="user-reset-password-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
          Set a new password for this user and give it to them directly. They will be signed out of every device and should change it from Account Security after signing in.
        </p>
        <label style={fieldStyle}>
          <span style={labelStyle}>New password</span>
          <input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Confirm new password</span>
          <input type="password" autoComplete="new-password" minLength={8} required value={confirm} onChange={(e) => setConfirm(e.target.value)} style={inputStyle} />
        </label>
        {error && <p role="alert" style={{ margin: 0, color: 'var(--danger)', fontSize: '13px', fontWeight: 600 }}>{error}</p>}
      </form>
    </Modal>
  );
}

const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
