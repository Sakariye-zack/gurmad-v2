import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, ChevronRight, MapPin } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useToast } from '../components/ui/index.js';
import CompanyLogo from '../components/CompanyLogo.jsx';

// Design pass 2 (user-requested rework — "not generic/AI, fits waste
// collection"). Dropped the soft-gradient SaaS-card look entirely for a
// "fleet dispatch manifest" concept instead: a route-map backdrop, hazard-
// stripe edge tape (the reflective marking on an actual collection truck),
// and a permit/manifest-styled access card — monospace data labels,
// stamped logo badge, condensed industrial display type. Still built
// entirely from the app's own --brand/--accent/--bg palette (tokens.css) —
// only the typefaces are new (Oswald + JetBrains Mono, loaded in
// index.html, scoped to this page via inline fontFamily only). Zero
// functional change: identical submit handler, 2FA branch, and auth calls
// as before.
const DISPLAY_FONT = "'Oswald', ui-sans-serif, sans-serif";
const MONO_FONT = "'JetBrains Mono', ui-monospace, monospace";

const fieldLabelStyle = {
  display: 'block',
  fontFamily: MONO_FONT,
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '0.12em',
  color: 'var(--text-muted)',
  marginBottom: '8px',
};
const inputStyle = {
  width: '100%',
  padding: '13px 14px',
  borderRadius: '4px',
  border: '2px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--text)',
  boxSizing: 'border-box',
  fontFamily: MONO_FONT,
  fontSize: '14px',
  transition: 'border-color 0.12s ease',
};

// A stop-and-go collection route: a dashed line threading between a few
// waypoint dots, ending at a filled pin — the one decorative graphic on
// the page, kept faint and pushed to a back corner. Not a stock map icon.
function RouteMotif({ style }) {
  return (
    <svg viewBox="0 0 260 200" width="260" height="200" style={style} aria-hidden="true">
      <path d="M8 170 C 60 170, 60 110, 110 110 S 160 40, 210 40" fill="none" stroke="var(--brand)" strokeWidth="2.5" strokeDasharray="1 9" strokeLinecap="round" opacity="0.5" />
      <circle cx="8" cy="170" r="4" fill="var(--brand)" opacity="0.55" />
      <circle cx="110" cy="110" r="4" fill="var(--accent)" opacity="0.55" />
      <circle cx="210" cy="40" r="5.5" fill="var(--accent)" opacity="0.7" />
    </svg>
  );
}

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

  const focusRing = (name) => (focused === name ? { borderColor: 'var(--brand)' } : {});
  const hazardTape = 'repeating-linear-gradient(-45deg, var(--brand) 0 14px, var(--accent) 14px 28px)';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* Reflective hazard tape — the edge marking on a real collection
          truck, not a UI gradient. Thin, functional, unmistakably
          industrial rather than decorative-SaaS. */}
      <div style={{ height: '8px', background: hazardTape, flexShrink: 0 }} />

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', position: 'relative', overflow: 'hidden' }}>
        <RouteMotif style={{ position: 'absolute', bottom: '-10px', right: '-10px', opacity: 0.8 }} />
        <RouteMotif style={{ position: 'absolute', top: '-30px', left: '-30px', transform: 'rotate(180deg)', opacity: 0.4 }} />

        <div style={{ position: 'relative', width: '100%', maxWidth: '384px' }}>
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderLeft: '6px solid var(--brand)',
              borderRadius: '6px',
              boxShadow: '0 16px 40px -14px rgba(0, 0, 0, 0.25)',
              padding: '34px 32px 30px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '22px' }}>
              <MapPin size={12} color="var(--accent)" />
              <span style={{ fontFamily: MONO_FONT, fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: 'var(--text-muted)' }}>
                COLLECTION OPS &nbsp;/&nbsp; ACCESS TERMINAL
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '28px' }}>
              <div
                style={{
                  width: '54px', height: '54px', flexShrink: 0,
                  background: 'var(--bg)', border: '2px dashed var(--border)', borderRadius: '4px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <CompanyLogo height={32} fallback={<Shield size={24} color="var(--brand)" />} />
              </div>
              <div>
                <h1 style={{ fontFamily: DISPLAY_FONT, fontSize: '26px', fontWeight: 700, letterSpacing: '0.01em', textTransform: 'uppercase', lineHeight: 1.05, color: 'var(--text)' }}>
                  Gurmad
                </h1>
                <div style={{ fontFamily: MONO_FONT, fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '3px', letterSpacing: '0.04em' }}>
                  Foundation build — staging
                </div>
              </div>
            </div>

            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={fieldLabelStyle}>[ USERNAME ]</label>
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

              <div>
                <label style={fieldLabelStyle}>[ PASSWORD ]</label>
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

              {require2FA && (
                <div>
                  <label style={fieldLabelStyle}>[ AUTH CODE ]</label>
                  <input
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    onFocus={() => setFocused('token')}
                    onBlur={() => setFocused(null)}
                    maxLength={6}
                    autoFocus
                    style={{ ...inputStyle, ...focusRing('token'), letterSpacing: '0.3em', textAlign: 'center', fontWeight: 700 }}
                  />
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                style={{
                  marginTop: '6px', width: '100%', padding: '14px 16px', border: 'none', borderRadius: '4px',
                  background: 'var(--brand)', color: '#fff',
                  fontFamily: DISPLAY_FONT, fontSize: '15px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                  cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.65 : 1,
                }}
              >
                {loading ? 'Signing in…' : 'Sign In'}
                {!loading && <ChevronRight size={17} strokeWidth={3} />}
              </button>
            </form>
          </div>

          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              fontFamily: MONO_FONT, fontSize: '10px', letterSpacing: '0.1em', color: 'var(--text-muted)',
              marginTop: '18px', textTransform: 'uppercase',
            }}
          >
            <span style={{ width: '20px', height: '1px', background: 'var(--border)' }} />
            Waste Collection &amp; Management Network
            <span style={{ width: '20px', height: '1px', background: 'var(--border)' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
