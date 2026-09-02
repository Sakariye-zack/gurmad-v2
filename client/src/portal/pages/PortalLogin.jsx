import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePortalAuth } from '../PortalAuthContext.jsx';

export default function PortalLogin() {
  const { login, loading } = usePortalAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    try {
      await login(phone, password);
      navigate('/portal');
    } catch (err) {
      setError(err.message || 'Login failed.');
    }
  }

  return (
    <div style={wrapStyle}>
      <form onSubmit={handleSubmit} style={cardStyle}>
        <h2 style={{ margin: '0 0 4px' }}>Customer Portal</h2>
        <p style={{ margin: '0 0 20px', color: 'var(--text-muted)', fontSize: '13px' }}>Sign in with your phone number.</p>
        {error && <div style={errorStyle}>{error}</div>}
        <label style={labelStyle}>Phone Number</label>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} style={inputStyle} required autoFocus />
        <label style={labelStyle}>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} required />
        <button type="submit" disabled={loading} style={btnStyle}>{loading ? 'Signing in…' : 'Sign In'}</button>
        <Link to="/portal/forgot-password" style={linkStyle}>Forgot password?</Link>
      </form>
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
