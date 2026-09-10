import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Lock, User, ArrowRight } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { Button, useToast } from '../components/ui/index.js';
import CompanyLogo from '../components/CompanyLogo.jsx';

// Design pass (user-requested, Phase 10) — the previous version was a
// bare centered form: no background treatment, small unstyled logo slot,
// plain browser-default inputs. Redesigned within the EXISTING design
// system only (design-system/tokens.css's --brand/--accent/--bg palette,
// drawn from the logo itself per that file's own header comment) — no
// new tokens invented, no component library added. Functionality is
// byte-for-byte identical: same submit handler, same 2FA branch, same
// useAuth/useToast/useNavigate calls.
const inputWrapStyle = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
};
const inputIconStyle = {
  position: 'absolute',
  left: '14px',
  color: 'var(--text-muted)',
  pointerEvents: 'none',
};
const inputStyle = {
  width: '100%',
  padding: '13px 14px 13px 42px',
  borderRadius: 'var(--radius-md)',
  border: '1.5px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--text)',
  boxSizing: 'border-box',
  fontSize: '14px',
  transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
};

export default function Login() {
  const { login, loading } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [require2FA, setRequire2FA] = useState(false);
  const [focused, setFocused] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    try {
      const result = await login(username, password, token);
      if (result.require2FA) {
        setRequire2FA(true);
        toast.success('Enter your 2FA code');
        return;
      }
      toast.success('Welcome back');
      navigate('/dashboard');
    } catch (err) {
      toast.error(err.message || 'Login failed');
    }
  };

  const focusRing = (name) =>
    focused === name
      ? { borderColor: 'var(--brand)', boxShadow: '0 0 0 3px var(--success-bg)' }
      : {};

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        position: 'relative',
        overflow: 'hidden',
        background: 'var(--bg)',
      }}
    >
      {/* Ambient brand-colored glow, purely decorative — two soft radial
          blobs in the logo's own green/orange, well below any text's
          contrast requirements against --bg either theme. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background:
            'radial-gradient(600px circle at 15% 20%, color-mix(in srgb, var(--brand) 16%, transparent), transparent 60%), ' +
            'radial-gradient(560px circle at 85% 85%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 60%)',
        }}
      />

      <div style={{ position: 'relative', width: '100%', maxWidth: '400px' }}>
        <div
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: '0 20px 48px -12px rgba(28, 35, 29, 0.18), var(--shadow-sm)',
            overflow: 'hidden',
          }}
        >
          {/* Top accent strip in the two logo colors — the one deliberate
              flourish on an otherwise quiet, utilitarian page. */}
          <div style={{ height: '5px', background: 'linear-gradient(90deg, var(--brand), var(--accent))' }} />

          <div style={{ padding: '40px 36px 32px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginBottom: '30px' }}>
              <div
                style={{
                  width: '68px', height: '68px', borderRadius: 'var(--radius-lg)',
                  background: 'var(--success-bg)', border: '1px solid var(--border)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  marginBottom: '16px',
                }}
              >
                <CompanyLogo height={40} fallback={<Shield size={30} color="var(--brand)" />} />
              </div>
              <h1 style={{ fontSize: '22px' }}>Gurmad V2</h1>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>Foundation build — staging</div>
            </div>

            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '7px', color: 'var(--text)' }}>Username</label>
                <div style={inputWrapStyle}>
                  <User size={16} style={inputIconStyle} />
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onFocus={() => setFocused('username')}
                    onBlur={() => setFocused(null)}
                    required
                    autoFocus
                    autoComplete="username"
                    style={{ ...inputStyle, ...focusRing('username') }}
                  />
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '7px', color: 'var(--text)' }}>Password</label>
                <div style={inputWrapStyle}>
                  <Lock size={16} style={inputIconStyle} />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={() => setFocused('password')}
                    onBlur={() => setFocused(null)}
                    required
                    autoComplete="current-password"
                    style={{ ...inputStyle, ...focusRing('password') }}
                  />
                </div>
              </div>

              {require2FA && (
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '7px', color: 'var(--text)' }}>Authenticator code</label>
                  <div style={inputWrapStyle}>
                    <Shield size={16} style={inputIconStyle} />
                    <input
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      onFocus={() => setFocused('token')}
                      onBlur={() => setFocused(null)}
                      maxLength={6}
                      autoFocus
                      style={{ ...inputStyle, ...focusRing('token'), letterSpacing: '3px', fontWeight: 700 }}
                    />
                  </div>
                </div>
              )}

              <Button type="submit" icon={ArrowRight} disabled={loading} style={{ marginTop: '8px', width: '100%', padding: '13px 16px', fontSize: '15px' }}>
                {loading ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </div>
        </div>

        <div style={{ textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)', marginTop: '20px' }}>
          Waste Management System
        </div>
      </div>
    </div>
  );
}
