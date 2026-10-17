import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { Button, StatusBadge, LoadingState, ErrorState, ConfirmDialog, useToast } from '../../../components/ui/index.js';
import PortalPageHeader from '../../components/PortalPageHeader.jsx';
import PortalCard from '../../components/PortalCard.jsx';
import { portalApiClient } from '../../apiClient.js';
import { useI18n } from '../../../i18n/I18nContext.jsx';

// Rebuild — Implementation Spec §21/§6: password change (now transparently
// swaps the stored token — the backend bumps token_version and returns a
// fresh one so THIS device stays logged in while every other device's
// token dies), account status, and "log out of all devices" (the concrete
// customer-facing security-compromise-response action, OD-3).
export default function PortalAccountSecurity() {
  const { t } = useI18n();
  const toast = useToast();
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    portalApiClient.get('/me')
      .then((res) => setProfile(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleChangePassword(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await portalApiClient.put('/me/password', { currentPassword, newPassword });
      // The old token is now invalid (token_version bumped) — swap in the
      // fresh one the server returned so this device's session continues
      // uninterrupted, matching the "you stay logged in here" copy below.
      if (res.data?.token) portalApiClient.setToken(res.data.token);
      toast.success(t('portal.security.changed'));
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
    } finally {
      setSaving(false);
    }
  }

  async function handleRevokeAll() {
    setRevoking(true);
    try {
      await portalApiClient.post('/me/revoke-sessions');
      // This device's own token is ALSO now dead (revocation is
      // account-wide, not per-device) — the correct behavior for an
      // explicit "log out everywhere" action, so redirect to login.
      portalApiClient.clearToken();
      window.location.href = '/portal/login';
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
      setRevoking(false);
    }
  }

  return (
    <div>
      <PortalPageHeader title={t('portal.myAccount')} subtitle={t('portal.account.subtitle')} />
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', borderBottom: '1px solid var(--border)' }}>
        <NavLink to="/portal/account/profile" style={({ isActive }) => tabStyle(isActive)}>{t('portal.account.profile')}</NavLink>
        <NavLink to="/portal/account/security" style={({ isActive }) => tabStyle(isActive)}>{t('portal.account.security')}</NavLink>
      </div>

      {loading ? <LoadingState label={t('common.loading')} /> : error ? <ErrorState message={error} onRetry={load} /> : profile && (
        <>
          <PortalCard>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0, fontSize: '14px' }}>{t('portal.security.status')}</h3>
              <StatusBadge status={profile.status} />
            </div>
          </PortalCard>

          <PortalCard style={{ marginTop: '16px' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: '14px' }}>{t('portal.security.changePassword')}</h3>
            <form onSubmit={handleChangePassword} style={{ maxWidth: '320px' }}>
              <label style={labelStyle}>{t('security.currentPassword')}</label>
              <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} style={inputStyle} required />
              <label style={labelStyle}>{t('security.newPassword')}</label>
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={inputStyle} required minLength={8} />
              <Button type="submit" disabled={saving} style={{ marginTop: '14px' }}>{saving ? t('common.saving') : t('portal.security.changePassword')}</Button>
            </form>
          </PortalCard>

          <PortalCard style={{ marginTop: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <ShieldAlert size={16} color="#DC2626" />
              <h3 style={{ margin: 0, fontSize: '14px' }}>{t('security.logoutAll')}</h3>
            </div>
            <p style={{ margin: '0 0 12px', fontSize: '13px', color: 'var(--text-muted)' }}>
              {t('portal.security.logoutAllBody')}
            </p>
            <Button variant="danger" onClick={() => setRevokeConfirmOpen(true)}>{t('portal.security.logoutEverywhere')}</Button>
          </PortalCard>
        </>
      )}

      <ConfirmDialog
        open={revokeConfirmOpen}
        onClose={() => setRevokeConfirmOpen(false)}
        onConfirm={handleRevokeAll}
        title={t('portal.security.confirmTitle')}
        message={t('portal.security.confirmBody')}
        confirmLabel={t('portal.security.logoutEverywhere')}
        danger
        isLoading={revoking}
      />
    </div>
  );
}

function tabStyle(isActive) {
  return {
    padding: '8px 4px', marginRight: '20px', fontSize: '13px', fontWeight: 700, textDecoration: 'none',
    color: isActive ? 'var(--brand)' : 'var(--text-muted)',
    borderBottom: isActive ? '2px solid var(--brand)' : '2px solid transparent',
  };
}

const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginTop: '12px', marginBottom: '6px' };
const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '14px', boxSizing: 'border-box' };
