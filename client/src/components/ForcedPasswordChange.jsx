import React, { useState } from 'react';
import { KeyRound, LogOut } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { apiClient } from '../lib/apiClient.js';
import { isPasswordAcceptable } from '../lib/passwordPolicy.js';
import { useI18n } from '../i18n/I18nContext.jsx';
import PasswordStrength from './PasswordStrength.jsx';
import LanguageToggle from './LanguageToggle.jsx';

// Account security — shown INSTEAD of the app (staff shell and collector
// app alike) while the account has must_change_password set: an
// admin-created account or an admin password reset. The server blocks
// every other route with 403 PASSWORD_CHANGE_REQUIRED until this succeeds.
// onTokenChanged lets the collector app re-key its offline store for the
// fresh token the server returns.
export default function ForcedPasswordChange({ onTokenChanged }) {
  const { user, updateUser, logout } = useAuth();
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!isPasswordAcceptable(newPassword, user?.username)) return setError(t('pwPolicy.summary'));
    if (newPassword !== confirm) return setError(t('forcedPw.mismatch'));
    setSaving(true);
    try {
      const res = await apiClient.post('/v2/auth/password/change', { currentPassword, newPassword });
      if (res.data?.token) {
        apiClient.setToken(res.data.token);
        if (onTokenChanged) await onTokenChanged(res.data.token);
      }
      updateUser({ must_change_password: false, must_enroll_2fa: !!res.data?.must_enroll_2fa });
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: '16px' }}>
      <div style={{ position: 'fixed', top: '10px', right: '10px' }}><LanguageToggle /></div>
      <form onSubmit={submit} style={{ width: '100%', maxWidth: '420px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '24px', boxShadow: 'var(--shadow-md)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
          <KeyRound size={22} color="var(--brand)" />
          <h2 style={{ margin: 0, fontSize: '19px' }}>{t('forcedPw.title')}</h2>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--text-muted)' }}>{t('forcedPw.body')}</p>
        <label style={labelStyle}>{t('security.currentPassword')}</label>
        <input type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} style={inputStyle} />
        <label style={labelStyle}>{t('security.newPassword')}</label>
        <input type="password" autoComplete="new-password" required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={inputStyle} />
        <PasswordStrength password={newPassword} username={user?.username} />
        <label style={labelStyle}>{t('forcedPw.confirm')}</label>
        <input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} style={inputStyle} />
        {error && <p role="alert" style={{ margin: '10px 0 0', color: 'var(--danger)', fontSize: '13px', fontWeight: 600 }}>{error}</p>}
        <button type="submit" disabled={saving} style={{ ...btnStyle, marginTop: '16px', background: 'var(--brand)', color: '#fff', border: 'none', opacity: saving ? 0.65 : 1 }}>
          {saving ? t('common.saving') : t('security.changePassword')}
        </button>
        <button type="button" onClick={logout} style={{ ...btnStyle, marginTop: '8px', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
          <LogOut size={15} /> {t('nav.logout')}
        </button>
      </form>
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginTop: '14px', marginBottom: '6px' };
const inputStyle = { width: '100%', padding: '11px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '15px', boxSizing: 'border-box', fontFamily: 'inherit', background: 'var(--surface)', color: 'var(--text)' };
const btnStyle = { width: '100%', minHeight: '44px', padding: '11px 14px', borderRadius: 'var(--radius-md)', fontSize: '14px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
