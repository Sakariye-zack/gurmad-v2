import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Truck } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { Button, Card } from '../../components/ui/index.js';
import { apiClient } from '../../lib/apiClient.js';
import { deriveKeyFromToken } from '../lib/collectorCrypto.js';

// Screen 6.1 (Decisions §17). Reuses useAuth().login() exactly as the
// existing desktop Login page does — the desktop pages/Login.jsx file
// itself is not imported or modified; this is a separate entry point for
// the Collector Mobile route tree only, per §7's "reuse the architecture,
// not necessarily the exact page component" allowance (no auth logic is
// duplicated — only the surrounding screen/navigation differs).
export default function LoginScreen() {
  const { login, loading } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const result = await login(username, password, '');
      if (result.require2FA) {
        setError('2FA accounts must sign in via the desktop app.');
        return;
      }
      await deriveKeyFromToken(apiClient.getToken());
      navigate('/collector');
    } catch (err) {
      setError(err.message || 'Sign in failed.');
    }
  };

  if (!navigator.onLine) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
        <Card style={{ padding: '24px', textAlign: 'center', maxWidth: '360px' }}>
          <h3>No connection</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Connect to the internet to sign in.</p>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', background: 'var(--bg)' }}>
      <Card style={{ padding: '28px', width: '100%', maxWidth: '360px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'var(--success-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Truck size={20} color="var(--brand)" />
          </div>
          <div>
            <h2 style={{ margin: 0 }}>GURMAD Collector</h2>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '12px' }}>Field collection app</p>
          </div>
        </div>
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <input autoFocus placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)}
            style={{ padding: '14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '16px', minHeight: '44px' }} />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)}
            style={{ padding: '14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '16px', minHeight: '44px' }} />
          {error && <div style={{ color: 'var(--danger)', fontSize: '13px', fontWeight: 700 }}>{error}</div>}
          <Button type="submit" disabled={loading} style={{ width: '100%', minHeight: '48px', fontSize: '16px' }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
