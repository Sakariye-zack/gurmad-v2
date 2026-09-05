import React, { useState } from 'react';
import { Modal, Button } from '../../components/ui/index.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { deriveKeyForReauth } from '../lib/collectorCrypto.js';
import { reencryptAllRows } from '../lib/collectorStore.js';
import { apiClient } from '../../lib/apiClient.js';

// Field Collector Mobile — Implementation Spec §6.6/§17. Preserves the
// local queue (never cleared here) — only re-establishes a valid session.
// Reuses the existing, unmodified login flow (useAuth().login) exactly as
// the desktop Login page does; not a new authentication path.
export default function ReauthModal({ open, onSuccess }) {
  const { login, loading } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const result = await login(username, password, '');
      if (result.require2FA) {
        setError('2FA is required — please use the main login screen.');
        return;
      }
      // H-FC-1 fix: rotate the encryption key rather than blindly re-deriving
      // it — carries the existing queue/cache forward, re-encrypted under the
      // new key, but ONLY when the reauthenticating identity matches the
      // session the current key belongs to (never across a different
      // collector's login on the same device — that case is intentionally
      // left orphaned, preserving cross-collector isolation).
      await deriveKeyForReauth(apiClient.getToken(), reencryptAllRows);
      setUsername(''); setPassword('');
      onSuccess();
    } catch (err) {
      setError(err.message || 'Sign in failed.');
    }
  };

  return (
    <Modal open={open} onClose={() => {}} title="Sign in again to sync your visits">
      <p style={{ margin: '0 0 12px', color: 'var(--text-muted)', fontSize: '13px' }}>
        Your queued visits are safe and will sync automatically once you sign in.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <input autoFocus placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)}
          style={{ padding: '12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '15px' }} />
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
          style={{ padding: '12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '15px' }} />
        {error && <div style={{ color: 'var(--danger)', fontSize: '13px', fontWeight: 700 }}>{error}</div>}
        <Button type="submit" disabled={loading} style={{ width: '100%', minHeight: '44px' }}>
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </Modal>
  );
}
