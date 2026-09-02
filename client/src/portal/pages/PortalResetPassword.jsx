import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { portalApiClient } from '../apiClient.js';

export default function PortalResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') || '';
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await portalApiClient.post('/auth/reset-password', { token, newPassword });
      setDone(true);
    } catch (err) {
      setError(err.message || 'Reset failed.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={wrapStyle}>
      <div style={cardStyle}>
        <h2 style={{ margin: '0 0 4px' }}>Set New Password</h2>
        {done ? (
          <>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '16px' }}>Password reset successfully.</p>
            <button onClick={() => navigate('/portal/login')} style={btnStyle}>Go to Sign In</button>
          </>
        ) : !token ? (
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '16px' }}>This reset link is missing its token.</p>
        ) : (
          <form onSubmit={handleSubmit}>
            {error && <div style={errorStyle}>{error}</div>}
            <label style={labelStyle}>New Password</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={inputStyle} required minLength={8} autoFocus />
            <button type="submit" disabled={loading} style={btnStyle}>{loading ? 'Resetting…' : 'Reset Password'}</button>
          </form>
        )}
        <Link to="/portal/login" style={linkStyle}>Back to Sign In</Link>
      </div>
    </div>
  );
}

const wrapStyle = { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' };
const cardStyle = { width: '100%', maxWidth: '360px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '28px', boxShadow: 'var(--shadow-md)' };
const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginTop: '14px', marginBottom: '6px' };
const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '14px', boxSizing: 'border-box' };
const btnStyle = { width: '100%', marginTop: '20px', padding: '11px', borderRadius: 'var(--radius-md)', border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 800, fontSize: '14px', cursor: 'pointer' };
const linkStyle = { display: 'block', marginTop: '14px', textAlign: 'center', fontSize: '13px', color: 'var(--brand)' };
const errorStyle = { background: '#FEE2E2', color: '#991B1B', padding: '10px 12px', borderRadius: 'var(--radius-md)', fontSize: '13px', marginBottom: '10px' };
