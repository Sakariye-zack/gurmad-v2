import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Truck as TruckIcon, ChevronRight, MapPin } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext.jsx';
import { apiClient } from '../../lib/apiClient.js';
import { useCompanyName } from '../../hooks/useSettings.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import LanguageToggle from '../../components/LanguageToggle.jsx';
import { deriveKeyFromToken } from '../lib/collectorCrypto.js';
import {
  DISPLAY_FONT, MONO_FONT, hazardTape, dispatchFieldLabelStyle, dispatchInputStyle, dispatchFocusRing,
  IsoTruck, DispatchMedallion,
} from '../../components/dispatchAuthKit.jsx';

// Screen 6.1 (Decisions §17). Reuses useAuth().login() exactly as the
// existing desktop Login page does — the desktop pages/Login.jsx file
// itself is not imported or modified; this is a separate entry point for
// the Collector Mobile route tree only, per §7's "reuse the architecture,
// not necessarily the exact page component" allowance (no auth logic is
// duplicated — only the surrounding screen/navigation differs).
//
// Visual design shares the same "fleet dispatch manifest" kit as
// pages/Login.jsx and portal/pages/PortalLogin.jsx (dispatchAuthKit.jsx)
// — single-column, no split hero (this screen is always mobile-width by
// design), with the isometric truck shown small and low as a field-app
// badge rather than a full illustration. Zero functional change from the
// original: identical login()/deriveKeyFromToken()/navigate calls.
export default function LoginScreen() {
  const { login, loading } = useAuth();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [focused, setFocused] = useState(null);
  // System name — user-requested ('meel kasta oo magaca system ku ka soo
  // muuqanayo waa in aan markan update gareeyo'). Public endpoint (see
  // its own comment) — reachable before login, no token needed.
  const { data: companyNameData } = useCompanyName();
  const companyName = companyNameData?.data?.company_name || 'GURMAD';

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const result = await login(username, password, '');
      if (result.require2FA) {
        setError(t('collector.login.no2fa'));
        return;
      }
      await deriveKeyFromToken(apiClient.getToken());
      navigate('/collector');
    } catch (err) {
      setError(err.message || t('collector.reauth.failed'));
    }
  };

  if (!navigator.onLine) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
        <div style={{ height: '8px', background: hazardTape, flexShrink: 0 }} />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '28px', textAlign: 'center', maxWidth: '340px' }}>
            <h3 style={{ fontFamily: DISPLAY_FONT, textTransform: 'uppercase' }}>{t('collector.login.noConnection')}</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', fontFamily: MONO_FONT }}>{t('collector.login.connect')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{ height: '8px', background: hazardTape, flexShrink: 0 }} />

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: '10px', right: '10px', zIndex: 2 }}><LanguageToggle /></div>
        <div style={{ position: 'relative', width: '100%', maxWidth: '360px' }}>
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderLeft: '6px solid var(--brand)',
              borderRadius: '8px',
              boxShadow: '0 16px 40px -14px rgba(0, 0, 0, 0.22)',
              padding: '30px 26px 26px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '20px' }}>
              <MapPin size={12} color="var(--accent)" />
              <span style={{ fontFamily: MONO_FONT, fontSize: '10px', fontWeight: 700, letterSpacing: '0.14em', color: 'var(--text-muted)' }}>
                {t('collector.login.appLabel')}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '24px' }}>
              <DispatchMedallion fallback={<TruckIcon size={22} color="var(--brand)" />} />
              <div>
                <h1 style={{ fontFamily: DISPLAY_FONT, fontSize: '22px', fontWeight: 700, letterSpacing: '0.01em', textTransform: 'uppercase', lineHeight: 1.05, color: 'var(--text)' }}>
                  {t('collector.role')}
                </h1>
                <div style={{ fontFamily: MONO_FONT, fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '3px' }}>
                  {t('collector.login.fieldUnit', undefined, { company: companyName })}
                </div>
              </div>
            </div>

            <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={dispatchFieldLabelStyle}>[ {t('login.username')} ]</label>
                <input
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onFocus={() => setFocused('username')}
                  onBlur={() => setFocused(null)}
                  style={{ ...dispatchInputStyle, padding: '14px', fontSize: '16px', minHeight: '44px', ...dispatchFocusRing(focused === 'username') }}
                />
              </div>
              <div>
                <label style={dispatchFieldLabelStyle}>[ {t('login.password')} ]</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onFocus={() => setFocused('password')}
                  onBlur={() => setFocused(null)}
                  style={{ ...dispatchInputStyle, padding: '14px', fontSize: '16px', minHeight: '44px', ...dispatchFocusRing(focused === 'password') }}
                />
              </div>

              {error && (
                <div style={{ background: 'var(--danger-bg)', color: 'var(--danger)', padding: '10px 12px', borderRadius: '4px', fontSize: '13px', fontFamily: MONO_FONT }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                style={{
                  marginTop: '4px', width: '100%', minHeight: '48px', padding: '14px 16px', border: 'none', borderRadius: '5px',
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
            </form>

            <div style={{ height: '70px', marginTop: '18px', position: 'relative', opacity: 0.9 }}>
              <IsoTruck style={{ position: 'absolute', bottom: '-46px', left: '50%', transform: 'translateX(-50%) scale(0.42)', filter: 'drop-shadow(0 10px 12px rgba(0,0,0,0.3))' }} />
            </div>
          </div>

          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              fontFamily: MONO_FONT, fontSize: '10px', letterSpacing: '0.1em', color: 'var(--text-muted)',
              marginTop: '18px', textTransform: 'uppercase', textAlign: 'center',
            }}
          >
            {t('login.footer')}
          </div>
        </div>
      </div>
    </div>
  );
}
