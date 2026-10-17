import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { User, Lock, ChevronRight, MapPin } from 'lucide-react';
import { usePortalAuth } from '../PortalAuthContext.jsx';
import {
  DISPLAY_FONT, MONO_FONT, hazardTape, dispatchFieldLabelStyle, dispatchInputStyle, dispatchFocusRing,
  RouteMotif, DispatchMedallion,
} from '../../components/dispatchAuthKit.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';
import LanguageToggle from '../../components/LanguageToggle.jsx';

// Same "fleet dispatch manifest" visual kit as the staff Login page and
// the Collector LoginScreen (dispatchAuthKit.jsx), toned for a customer
// audience — no ops-panel/HUD hero, no "TERMINAL" language, softer
// eyebrow copy ("Track your collection account" rather than "Access
// Terminal"). Zero functional change from the original: identical
// usePortalAuth().login() call, identical error handling, identical
// forgot-password link.
export default function PortalLogin() {
  const { login, loading } = usePortalAuth();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [focused, setFocused] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    try {
      await login(phone, password);
      navigate('/portal');
    } catch (err) {
      setError(err.message || t('portal.login.failed'));
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{ height: '8px', background: hazardTape, flexShrink: 0 }} />

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: '10px', right: '10px', zIndex: 2 }}><LanguageToggle /></div>
        <RouteMotif style={{ position: 'absolute', bottom: '-10px', right: '-10px', opacity: 0.7 }} />
        <RouteMotif style={{ position: 'absolute', top: '-30px', left: '-30px', transform: 'rotate(180deg)', opacity: 0.35 }} />

        <div style={{ position: 'relative', width: '100%', maxWidth: '380px' }}>
          <form
            onSubmit={handleSubmit}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderLeft: '6px solid var(--brand)',
              borderRadius: '8px',
              boxShadow: '0 16px 40px -14px rgba(0, 0, 0, 0.22)',
              padding: '34px 32px 30px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '22px' }}>
              <MapPin size={12} color="var(--accent)" />
              <span style={{ fontFamily: MONO_FONT, fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: 'var(--text-muted)' }}>
                {t('portal.login.label')}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '26px' }}>
              <DispatchMedallion fallback={null} />
              <div>
                <h1 style={{ fontFamily: DISPLAY_FONT, fontSize: '24px', fontWeight: 700, letterSpacing: '0.01em', textTransform: 'uppercase', lineHeight: 1.05, color: 'var(--text)' }}>
                  {t('portal.myAccount')}
                </h1>
                <div style={{ fontFamily: MONO_FONT, fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '3px' }}>
                  {t('portal.login.tagline')}
                </div>
              </div>
            </div>

            {error && (
              <div style={{ background: 'var(--danger-bg)', color: 'var(--danger)', padding: '10px 12px', borderRadius: '4px', fontSize: '13px', marginBottom: '16px', fontFamily: MONO_FONT }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={dispatchFieldLabelStyle}>[ {t('portal.login.phone')} ]</label>
                <div style={{ position: 'relative' }}>
                  <User size={15} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    onFocus={() => setFocused('phone')}
                    onBlur={() => setFocused(null)}
                    required
                    autoFocus
                    type="tel"
                    autoComplete="tel"
                    style={{ ...dispatchInputStyle, paddingLeft: '38px', ...dispatchFocusRing(focused === 'phone') }}
                  />
                </div>
              </div>

              <div>
                <label style={dispatchFieldLabelStyle}>[ {t('login.password')} ]</label>
                <div style={{ position: 'relative' }}>
                  <Lock size={15} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={() => setFocused('password')}
                    onBlur={() => setFocused(null)}
                    required
                    autoComplete="current-password"
                    style={{ ...dispatchInputStyle, paddingLeft: '38px', ...dispatchFocusRing(focused === 'password') }}
                  />
                </div>
              </div>

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
                {loading ? t('collector.reauth.signingIn') : t('login.signIn')}
                {!loading && <ChevronRight size={17} strokeWidth={3} />}
              </button>

              <Link
                to="/portal/forgot-password"
                style={{ display: 'block', textAlign: 'center', fontFamily: MONO_FONT, fontSize: '12px', color: 'var(--brand)', marginTop: '2px' }}
              >
                {t('portal.login.forgot')}
              </Link>
            </div>
          </form>

          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              fontFamily: MONO_FONT, fontSize: '10px', letterSpacing: '0.1em', color: 'var(--text-muted)',
              marginTop: '18px', textTransform: 'uppercase',
            }}
          >
            <span style={{ width: '20px', height: '1px', background: 'var(--border)' }} />
            {t('login.footer')}
            <span style={{ width: '20px', height: '1px', background: 'var(--border)' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
