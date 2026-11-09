import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LocateFixed, MapPin, CheckCircle2 } from 'lucide-react';
import { portalApiClient } from '../apiClient.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import LanguageToggle from '../../components/LanguageToggle.jsx';

// Public customer self-signup request. No OTP (no SMS available): the office
// reviews and approves each request; the applicant can log in afterwards
// with the phone + password chosen here.
const MIN_PASSWORD = 8; // same rule as the portal reset-password route

const EMPTY = {
  full_name: '', phone: '', alternate_phone: '', customer_type: 'residential', business_name: '',
  zone_id: '', area: '', door_number: '', address_line: '', lat: '', lng: '',
  preferred_billing: 'monthly', password: '', password_confirm: '', notes: '', website: '',
};

export default function PortalSignup() {
  const { t } = useI18n();
  const [form, setForm] = useState(EMPTY);
  const [districts, setDistricts] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState(false);

  useEffect(() => {
    portalApiClient.get('/signup/districts').then((r) => setDistricts(r.data || [])).catch(() => setDistricts([]));
  }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  function useMyLocation() {
    setLocError(false);
    if (!navigator.geolocation) { setLocError(true); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocating(false); setForm((f) => ({ ...f, lat: pos.coords.latitude, lng: pos.coords.longitude })); },
      () => { setLocating(false); setLocError(true); },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (form.password.length < MIN_PASSWORD) { setError(t('signup.tooShort')); return; }
    if (form.password !== form.password_confirm) { setError(t('signup.mismatch')); return; }
    setLoading(true);
    try {
      const body = { ...form, zone_id: form.zone_id ? Number(form.zone_id) : null };
      if (body.lat === '' || body.lng === '') { delete body.lat; delete body.lng; }
      if (body.customer_type !== 'commercial') delete body.business_name;
      await portalApiClient.post('/signup', body);
      setDone(true);
    } catch (err) {
      setError(err.message || t('signup.failed'));
    } finally {
      setLoading(false);
    }
  }

  const hasLoc = form.lat !== '' && form.lng !== '';

  return (
    <div style={wrapStyle}>
      <div style={{ position: 'absolute', top: '10px', right: '10px' }}><LanguageToggle /></div>
      <div style={cardStyle}>
        {done ? (
          <div style={{ textAlign: 'center' }}>
            <CheckCircle2 size={40} color="var(--success, var(--brand))" />
            <h2 style={{ margin: '10px 0 6px' }}>{t('signup.doneTitle')}</h2>
            <p style={{ fontSize: '14px', color: 'var(--text-muted)' }}>{t('signup.doneBody')}</p>
            <Link to="/portal/login" style={linkStyle}>{t('portal.backToSignIn')}</Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate={false}>
            <h2 style={{ margin: '0 0 4px' }}>{t('signup.title')}</h2>
            <p style={{ margin: '0 0 8px', color: 'var(--text-muted)', fontSize: '13px' }}>{t('signup.intro')}</p>

            {error && <div role="alert" style={errStyle}>{error}</div>}

            <label style={labelStyle}>{t('signup.fullName')} *</label>
            <input value={form.full_name} onChange={(e) => set('full_name', e.target.value)} style={inputStyle} required maxLength={100} autoComplete="name" />

            <label style={labelStyle}>{t('signup.phone')} *</label>
            <input value={form.phone} onChange={(e) => set('phone', e.target.value)} style={inputStyle} required type="tel" autoComplete="tel" placeholder="063 4123456" />
            <div style={hintStyle}>{t('signup.phoneHint')}</div>

            <label style={labelStyle}>{t('signup.altPhone')}</label>
            <input value={form.alternate_phone} onChange={(e) => set('alternate_phone', e.target.value)} style={inputStyle} type="tel" />

            <label style={labelStyle}>{t('signup.type')} *</label>
            <select value={form.customer_type} onChange={(e) => set('customer_type', e.target.value)} style={inputStyle}>
              <option value="residential">{t('signup.residential')}</option>
              <option value="commercial">{t('signup.commercial')}</option>
            </select>
            {form.customer_type === 'commercial' && (
              <>
                <label style={labelStyle}>{t('signup.businessName')} *</label>
                <input value={form.business_name} onChange={(e) => set('business_name', e.target.value)} style={inputStyle} required maxLength={150} />
              </>
            )}

            <label style={labelStyle}>{t('signup.district')} *</label>
            <select value={form.zone_id} onChange={(e) => set('zone_id', e.target.value)} style={inputStyle} required>
              <option value="">{t('signup.selectDistrict')}</option>
              {districts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>

            <label style={labelStyle}>{t('signup.area')}</label>
            <input value={form.area} onChange={(e) => set('area', e.target.value)} style={inputStyle} maxLength={100} />

            <label style={labelStyle}>{t('signup.door')}</label>
            <input value={form.door_number} onChange={(e) => set('door_number', e.target.value.replace(/\D/g, ''))} style={inputStyle} inputMode="numeric" maxLength={20} />
            <div style={hintStyle}>{t('signup.doorHint')}</div>

            <label style={labelStyle}>{t('signup.address')}</label>
            <input value={form.address_line} onChange={(e) => set('address_line', e.target.value)} style={inputStyle} maxLength={200} />

            <label style={labelStyle}>{t('signup.location')}</label>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" onClick={useMyLocation} disabled={locating} style={secondaryBtn}>
                <LocateFixed size={14} /> {locating ? t('signup.locating') : t('signup.useLocation')}
              </button>
              {hasLoc && (
                <>
                  <a href={`https://www.openstreetmap.org/?mlat=${form.lat}&mlon=${form.lng}#map=18/${form.lat}/${form.lng}`} target="_blank" rel="noreferrer" style={{ fontSize: '12px', color: 'var(--brand)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                    <MapPin size={12} /> {Number(form.lat).toFixed(5)}, {Number(form.lng).toFixed(5)}
                  </a>
                  <button type="button" onClick={() => setForm((f) => ({ ...f, lat: '', lng: '' }))} style={{ ...secondaryBtn, padding: '4px 8px' }}>{t('signup.clearLocation')}</button>
                </>
              )}
            </div>
            {locError && <div style={{ ...hintStyle, color: 'var(--danger)' }}>{t('signup.locationFailed')}</div>}

            <label style={labelStyle}>{t('signup.billing')}</label>
            <select value={form.preferred_billing} onChange={(e) => set('preferred_billing', e.target.value)} style={inputStyle}>
              <option value="monthly">{t('signup.monthly')}</option>
              <option value="daily">{t('signup.daily')}</option>
            </select>

            <label style={labelStyle}>{t('signup.password')} *</label>
            <input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} style={inputStyle} required minLength={MIN_PASSWORD} autoComplete="new-password" />
            <div style={hintStyle}>{t('signup.passwordHint')}</div>
            <label style={labelStyle}>{t('signup.confirm')} *</label>
            <input type="password" value={form.password_confirm} onChange={(e) => set('password_confirm', e.target.value)} style={inputStyle} required autoComplete="new-password" />

            <label style={labelStyle}>{t('signup.notes')}</label>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} style={{ ...inputStyle, minHeight: '64px' }} maxLength={1000} />

            {/* Honeypot: hidden from people, bots tend to fill it. */}
            <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: '1px', height: '1px', overflow: 'hidden' }}>
              <label>Website<input tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => set('website', e.target.value)} /></label>
            </div>

            <button type="submit" disabled={loading} style={btnStyle}>{loading ? t('signup.sending') : t('signup.submit')}</button>
            <Link to="/portal/login" style={linkStyle}>{t('signup.haveAccount')}</Link>
          </form>
        )}
      </div>
    </div>
  );
}

const wrapStyle = { minHeight: '100vh', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', background: 'var(--bg)', padding: '48px 16px', boxSizing: 'border-box', position: 'relative' };
const cardStyle = { width: '100%', maxWidth: '440px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '28px', boxShadow: 'var(--shadow-md)', position: 'relative', boxSizing: 'border-box' };
const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginTop: '14px', marginBottom: '6px' };
const hintStyle = { fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' };
const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '14px', boxSizing: 'border-box', background: 'var(--surface)', color: 'var(--text)' };
const errStyle = { background: 'var(--danger-bg)', color: 'var(--danger)', padding: '10px 12px', borderRadius: '4px', fontSize: '13px', marginTop: '10px' };
const btnStyle = { width: '100%', marginTop: '20px', padding: '11px', borderRadius: 'var(--radius-md)', border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 800, fontSize: '14px', cursor: 'pointer' };
const secondaryBtn = { display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '13px', cursor: 'pointer' };
const linkStyle = { display: 'block', marginTop: '14px', textAlign: 'center', fontSize: '13px', color: 'var(--brand)' };
