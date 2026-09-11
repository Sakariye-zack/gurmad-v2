import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, ChevronRight, MapPin, Radio, Recycle } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useToast } from '../components/ui/index.js';
import {
  DISPLAY_FONT, MONO_FONT, hazardTape, dispatchFieldLabelStyle, dispatchInputStyle, dispatchFocusRing,
  IsoTruck, RouteMotif, DispatchStatChip, DispatchMedallion,
} from '../components/dispatchAuthKit.jsx';

// "Fleet dispatch manifest" design — refactored to share its visual kit
// (dispatchAuthKit.jsx) with PortalLogin.jsx and collector/screens/
// LoginScreen.jsx, so all three login surfaces read as one system instead
// of three hand-copied designs. This file now holds only the staff-Login-
// specific layout (the split ops-panel hero) and its own auth wiring —
// zero functional change from before the refactor.
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
      // User-reported live (Phase 10): a collector signing in through
      // this staff form landed in the field-role bottom-tab shell
      // (MobileTabBar.jsx's "Home / My Batch / Collect"), which was built
      // for cashier (Collect -> Billing, a payment-recording page a
      // collector has no access to at all; My Batch -> Collection Cycles,
      // a read-only admin list with no click-through to actual assigned
      // work). None of it is the collector's real job. The fully-built,
      // purpose-made experience for that job already exists at /collector
      // (assignments, photo capture, offline sync) and shares this exact
      // same auth token/localStorage, so no second login is needed - just
      // send a collector there directly instead of into the mismatched
      // staff shell.
      navigate(result.user?.role === 'collector' ? '/collector' : '/dashboard');
    } catch (err) {
      toast.error(err.message || 'Login failed');
    }
  };

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
              <DispatchStatChip label="Zones" value="12+" />
              <DispatchStatChip label="Trucks" value="40+" />
              <DispatchStatChip label="Uptime" value="99.9%" />
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
                <DispatchMedallion fallback={<Shield size={24} color="var(--brand)" />} />
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
                  <label style={dispatchFieldLabelStyle}>[ USERNAME ]</label>
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onFocus={() => setFocused('username')}
                    onBlur={() => setFocused(null)}
                    required
                    autoFocus
                    autoComplete="username"
                    style={{ ...dispatchInputStyle, ...dispatchFocusRing(focused === 'username') }}
                  />
                </div>

                <div>
                  <label style={dispatchFieldLabelStyle}>[ PASSWORD ]</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={() => setFocused('password')}
                    onBlur={() => setFocused(null)}
                    required
                    autoComplete="current-password"
                    style={{ ...dispatchInputStyle, ...dispatchFocusRing(focused === 'password') }}
                  />
                </div>

                {require2FA && (
                  <div>
                    <label style={dispatchFieldLabelStyle}>[ AUTH CODE ]</label>
                    <input
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      onFocus={() => setFocused('token')}
                      onBlur={() => setFocused(null)}
                      maxLength={6}
                      autoFocus
                      style={{ ...dispatchInputStyle, ...dispatchFocusRing(focused === 'token'), letterSpacing: '0.3em', textAlign: 'center', fontWeight: 700 }}
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
