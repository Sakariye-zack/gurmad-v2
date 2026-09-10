import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, ChevronRight, MapPin, Radio, Recycle } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useToast } from '../components/ui/index.js';
import CompanyLogo from '../components/CompanyLogo.jsx';

// Design pass 3 (user-requested: richer, more dimensional, "professional").
// Split layout: a dark illustrated ops panel (isometric collection-truck
// SVG built from shaded facets for real depth, a HUD-style live readout
// strip, a route map) on one side, an embossed access-manifest card on
// the other. Everything still derives from the app's own --brand/
// --accent/--bg palette (tokens.css); only the two Google Fonts (Oswald,
// JetBrains Mono, loaded in index.html) and this page's own layout are
// new. Zero functional change from the original: identical submit
// handler, 2FA branch, and useAuth/useToast/useNavigate calls.
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
  // Longhand, not shorthand `border` — focusRing() below overrides only
  // borderColor on focus, and mixing shorthand/longhand for the same
  // property on the same element is a real React warning (style-diffing
  // can silently drop the shorthand's width/style on the next render).
  borderWidth: '2px',
  borderStyle: 'solid',
  borderColor: 'var(--border)',
  background: 'var(--bg)',
  color: 'var(--text)',
  boxSizing: 'border-box',
  fontFamily: MONO_FONT,
  fontSize: '14px',
  transition: 'border-color 0.12s ease, box-shadow 0.12s ease',
};

// An isometric collection truck, built from shaded facets (three tones
// per surface — base/light/shadow) the way real isometric illustration
// fakes depth without any 3D engine. Recognizable silhouette: cab, chassis,
// rear hopper with a lifted lid line. Not a stock icon.
function IsoTruck({ style }) {
  return (
    <svg viewBox="0 0 340 220" width="100%" height="100%" style={style} aria-hidden="true">
      <defs>
        <linearGradient id="hopperTop" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brand)" />
          <stop offset="1" stopColor="var(--brand-dark)" />
        </linearGradient>
      </defs>
      {/* ground shadow */}
      <ellipse cx="170" cy="200" rx="130" ry="12" fill="#000" opacity="0.28" />

      {/* rear hopper block — three faces for depth */}
      <path d="M60 70 L180 40 L180 150 L60 180 Z" fill="url(#hopperTop)" />
      <path d="M180 40 L250 65 L250 172 L180 150 Z" fill="var(--brand-dark)" />
      <path d="M60 70 L180 40 L250 65 L130 95 Z" fill="var(--brand)" opacity="0.92" />
      {/* hopper lid seam + rivets, manifest-plate detail */}
      <path d="M70 95 L172 68" stroke="#000" strokeOpacity="0.18" strokeWidth="2" />
      <circle cx="90" cy="130" r="3" fill="#000" opacity="0.2" />
      <circle cx="130" cy="118" r="3" fill="#000" opacity="0.2" />
      <circle cx="170" cy="106" r="3" fill="#000" opacity="0.2" />

      {/* cab */}
      <path d="M250 100 L296 116 L296 172 L250 172 Z" fill="var(--accent)" />
      <path d="M250 100 L296 116 L262 126 L232 112 Z" fill="var(--accent-dark)" />
      <path d="M232 112 L262 126 L262 178 L232 178 Z" fill="var(--accent-dark)" opacity="0.9" />
      {/* windshield */}
      <path d="M240 116 L258 122 L258 140 L240 136 Z" fill="var(--bg)" opacity="0.85" />

      {/* chassis */}
      <rect x="60" y="178" width="236" height="10" fill="#000" opacity="0.35" />

      {/* wheels */}
      <circle cx="100" cy="196" r="16" fill="#111" />
      <circle cx="100" cy="196" r="6" fill="var(--text-muted)" />
      <circle cx="200" cy="196" r="16" fill="#111" />
      <circle cx="200" cy="196" r="6" fill="var(--text-muted)" />
      <circle cx="270" cy="196" r="16" fill="#111" />
      <circle cx="270" cy="196" r="6" fill="var(--text-muted)" />
    </svg>
  );
}

function RouteMotif({ style }) {
  return (
    <svg viewBox="0 0 260 200" width="260" height="200" style={style} aria-hidden="true">
      <path d="M8 170 C 60 170, 60 110, 110 110 S 160 40, 210 40" fill="none" stroke="var(--brand)" strokeWidth="2.5" strokeDasharray="1 9" strokeLinecap="round" opacity="0.55" />
      <circle cx="8" cy="170" r="4" fill="var(--brand)" opacity="0.6" />
      <circle cx="110" cy="110" r="4" fill="var(--accent)" opacity="0.6" />
      <circle cx="210" cy="40" r="5.5" fill="var(--accent)" opacity="0.75" />
    </svg>
  );
}

function StatChip({ label, value }) {
  return (
    <div style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', minWidth: '84px' }}>
      <div style={{ fontFamily: MONO_FONT, fontSize: '18px', fontWeight: 700, color: '#fff', lineHeight: 1 }}>{value}</div>
      <div style={{ fontFamily: MONO_FONT, fontSize: '9px', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.55)', marginTop: '5px', textTransform: 'uppercase' }}>{label}</div>
    </div>
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

  const focusRing = (name) => (focused === name ? { borderColor: 'var(--brand)', boxShadow: '0 0 0 4px color-mix(in srgb, var(--brand) 22%, transparent)' } : {});
  const hazardTape = 'repeating-linear-gradient(-45deg, var(--brand) 0 14px, var(--accent) 14px 28px)';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{ height: '8px', background: hazardTape, flexShrink: 0 }} />

      <div style={{ flex: 1, display: 'flex' }}>
        {/* Ops panel — hidden on narrow viewports, the login card alone
            still stands on its own there. */}
        <div
          className="login-ops-panel"
          style={{
            flex: '1 1 52%',
            position: 'relative',
            overflow: 'hidden',
            background: 'linear-gradient(160deg, #10140c 0%, #1b2313 55%, #14170f 100%)',
            display: 'none',
            flexDirection: 'column',
            justifyContent: 'space-between',
            padding: '40px',
          }}
        >
          <RouteMotif style={{ position: 'absolute', top: '20px', right: '20px', opacity: 0.35 }} />
          <RouteMotif style={{ position: 'absolute', bottom: '-20px', left: '-40px', transform: 'rotate(150deg)', opacity: 0.2 }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Radio size={13} color="var(--accent)" />
            <span style={{ fontFamily: MONO_FONT, fontSize: '10px', letterSpacing: '0.16em', color: 'rgba(255,255,255,0.6)' }}>
              LIVE FLEET NETWORK
            </span>
          </div>

          <div style={{ position: 'relative', zIndex: 1 }}>
            <h1 style={{ fontFamily: DISPLAY_FONT, fontSize: '42px', fontWeight: 700, textTransform: 'uppercase', lineHeight: 1.05, color: '#fff', maxWidth: '380px' }}>
              Keeping the routes running, zone by zone.
            </h1>
            <p style={{ fontFamily: MONO_FONT, fontSize: '12px', color: 'rgba(255,255,255,0.55)', marginTop: '14px', maxWidth: '340px', lineHeight: 1.6 }}>
              Collection scheduling, cashout reconciliation, and fleet
              operations for every zone — one dispatch terminal.
            </p>

            <div style={{ display: 'flex', gap: '10px', marginTop: '26px' }}>
              <StatChip label="Zones" value="12+" />
              <StatChip label="Trucks" value="40+" />
              <StatChip label="Uptime" value="99.9%" />
            </div>
          </div>

          <div style={{ position: 'relative', height: '190px', marginTop: '20px' }}>
            <IsoTruck style={{ position: 'absolute', bottom: '-10px', left: '0', filter: 'drop-shadow(0 18px 20px rgba(0,0,0,0.45))' }} />
            <div style={{ position: 'absolute', top: '6px', right: '0', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Recycle size={13} color="var(--brand)" />
              <span style={{ fontFamily: MONO_FONT, fontSize: '9px', letterSpacing: '0.12em', color: 'rgba(255,255,255,0.5)' }}>UNIT-07 // EN ROUTE</span>
            </div>
          </div>
        </div>

        {/* Access card panel */}
        <div style={{ flex: '1 1 48%', minWidth: '340px', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', position: 'relative' }}>
          <div style={{ position: 'relative', width: '100%', maxWidth: '384px' }}>
            <div
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderLeft: '6px solid var(--brand)',
                borderRadius: '8px',
                boxShadow: '0 2px 0 rgba(255,255,255,0.4) inset, 0 30px 60px -18px rgba(0,0,0,0.35), 0 10px 20px -10px rgba(0,0,0,0.2)',
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
                {/* Embossed medallion — layered inset+outset shadow and a
                    gradient rim is what fakes a raised, stamped disc here. */}
                <div
                  style={{
                    width: '58px', height: '58px', flexShrink: 0, borderRadius: '50%',
                    background: 'linear-gradient(155deg, var(--surface), var(--bg))',
                    boxShadow: '0 1px 0 rgba(255,255,255,0.5) inset, 0 -1px 4px rgba(0,0,0,0.15) inset, 0 6px 14px -4px rgba(0,0,0,0.3)',
                    border: '1px solid var(--border)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <CompanyLogo height={32} fallback={<Shield size={24} color="var(--brand)" />} style={{ borderRadius: '50%' }} />
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
                    marginTop: '6px', width: '100%', padding: '14px 16px', border: 'none', borderRadius: '5px',
                    background: 'linear-gradient(180deg, var(--brand), var(--brand-dark))', color: '#fff',
                    boxShadow: '0 1px 0 rgba(255,255,255,0.25) inset, 0 8px 18px -6px color-mix(in srgb, var(--brand) 60%, transparent)',
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

      <style>{`@media (min-width: 940px) { .login-ops-panel { display: flex !important; } }`}</style>
    </div>
  );
}
