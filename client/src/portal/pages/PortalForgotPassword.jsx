import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { portalApiClient } from '../apiClient.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

export default function PortalForgotPassword() {
  const { t } = useI18n();
  const [phone, setPhone] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    try {
      // Always shows the same generic confirmation, whether or not the
      // phone number matches an account — anti-enumeration (OD-6/§8).
      await portalApiClient.post('/auth/forgot-password', { phone });
    } finally {
      setLoading(false);
      setSubmitted(true);
    }
  }

  return (
    <div style={wrapStyle}>
      <div style={cardStyle}>
        <h2 style={{ margin: '0 0 4px' }}>{t('portal.forgot.title')}</h2>
        {submitted ? (
          <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '16px' }}>
            {t('portal.forgot.sent')}
          </p>
        ) : (
          <form onSubmit={handleSubmit}>
            <p style={{ margin: '0 0 16px', color: 'var(--text-muted)', fontSize: '13px' }}>
              {t('portal.forgot.intro')}
            </p>
            <label style={labelStyle}>{t('portal.forgot.phone')}</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} style={inputStyle} required autoFocus />
            <button type="submit" disabled={loading} style={btnStyle}>{loading ? t('portal.forgot.sending') : t('portal.forgot.send')}</button>
          </form>
        )}
        <Link to="/portal/login" style={linkStyle}>{t('portal.backToSignIn')}</Link>
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
