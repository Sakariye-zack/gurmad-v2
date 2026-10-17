import React, { useState } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button, Card, PageHeader, ConfirmDialog, useToast } from '../../components/ui/index.js';
import { apiClient } from '../../lib/apiClient.js';
import { useTwoFactorStatus, useStartTwoFactorSetup, useEnableTwoFactor, useDisableTwoFactor } from '../../hooks/useTwoFactor.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

// User & Access Administration — self-service staff account security.
// Directly mirrors the Customer Portal's own already-proven
// PortalAccountSecurity.jsx pattern (password change swaps in a fresh
// token so this device stays signed in; logout-all is the explicit
// security-compromise-response action, OD-3) — no new UX pattern invented.
export default function AccountSecurity() {
  const toast = useToast();
  const { t } = useI18n();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [logoutAllConfirmOpen, setLogoutAllConfirmOpen] = useState(false);
  const [loggingOutAll, setLoggingOutAll] = useState(false);

  async function handleChangePassword(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiClient.post('/v2/auth/password/change', { currentPassword, newPassword });
      if (res.data?.token) apiClient.setToken(res.data.token);
      toast.success(res.data?.message || t('security.pwChanged'));
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
    } finally {
      setSaving(false);
    }
  }

  async function handleLogoutAll() {
    setLoggingOutAll(true);
    try {
      await apiClient.post('/v2/auth/logout-all', {});
      // Account-wide revocation invalidates THIS device's token too —
      // redirect to login, matching the Portal's own established
      // behavior for the same action.
      apiClient.clearToken();
      window.location.href = '/login';
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
      setLoggingOutAll(false);
    }
  }

  return (
    <div>
      <PageHeader icon={ShieldAlert} title={t('security.title')} subtitle={t('security.subtitle')} />

      <Card style={{ padding: '24px', maxWidth: '480px', marginBottom: '20px' }}>
        <h3 style={{ marginTop: 0 }}>{t('security.changePassword')}</h3>
        <form onSubmit={handleChangePassword}>
          <label style={labelStyle}>{t('security.currentPassword')}</label>
          <input type="password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} style={inputStyle} />
          <label style={labelStyle}>{t('security.newPassword')}</label>
          <input type="password" required minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={inputStyle} />
          <Button type="submit" disabled={saving} style={{ marginTop: '14px' }}>{saving ? t('common.saving') : t('security.changePassword')}</Button>
        </form>
      </Card>

      <Card style={{ padding: '24px', maxWidth: '480px' }}>
        <h3 style={{ marginTop: 0 }}>{t('security.activeSessions')}</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
          {t('security.logoutAllBody')}
        </p>
        <Button variant="danger" onClick={() => setLogoutAllConfirmOpen(true)}>{t('security.logoutAll')}</Button>
      </Card>

      <ConfirmDialog
        open={logoutAllConfirmOpen}
        title={t('portal.security.confirmTitle')}
        message={t('security.logoutAllConfirm')}
        confirmLabel="Log Out Everywhere"
        danger
        isLoading={loggingOutAll}
        onConfirm={handleLogoutAll}
        onClose={() => setLogoutAllConfirmOpen(false)}
      />

      <TwoFactorCard />
    </div>
  );
}

// Two-Factor Authentication (user-requested) — TOTP enrollment, plus the
// backup-codes recovery path for a lost authenticator device ('sidan uga
// furayo authenticationka'). Three states: off (offer to enable), mid-
// enrollment (QR + confirm code), on (offer to disable).
function TwoFactorCard() {
  const toast = useToast();
  const { t } = useI18n();
  const { data: statusData, isLoading } = useTwoFactorStatus();
  const enabled = statusData?.data?.enabled;
  const startSetup = useStartTwoFactorSetup();
  const enableTwoFactor = useEnableTwoFactor();
  const disableTwoFactor = useDisableTwoFactor();

  const [setupData, setSetupData] = useState(null); // { secret, qrDataUrl }
  const [confirmCode, setConfirmCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null); // shown once, right after enabling
  const [disablePassword, setDisablePassword] = useState('');
  const [disableOpen, setDisableOpen] = useState(false);

  async function handleStart() {
    try {
      const res = await startSetup.mutateAsync();
      setSetupData(res.data);
    } catch (err) {
      toast.error(err.message || t('security.setupFailed'));
    }
  }

  async function handleConfirm(e) {
    e.preventDefault();
    try {
      const res = await enableTwoFactor.mutateAsync(confirmCode);
      setBackupCodes(res.data.backupCodes);
      setSetupData(null);
      setConfirmCode('');
      toast.success(t('security.enabledToast'));
    } catch (err) {
      toast.error(err.message || t('security.badCode'));
    }
  }

  async function handleDisable() {
    try {
      await disableTwoFactor.mutateAsync(disablePassword);
      toast.success(t('security.disabledToast'));
      setDisableOpen(false);
      setDisablePassword('');
    } catch (err) {
      toast.error(err.message || t('security.badPassword'));
    }
  }

  if (isLoading) return null;

  // Backup codes are shown exactly once, right after enabling — the
  // server never returns them again (only bcrypt hashes are stored).
  if (backupCodes) {
    return (
      <Card style={{ padding: '24px', maxWidth: '480px', marginTop: '20px' }}>
        <h3 style={{ marginTop: 0 }}>{t('security.backupTitle')}</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
          {t('security.backupBody')}
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontFamily: 'monospace', fontSize: '14px', background: 'var(--bg)', padding: '14px', borderRadius: 'var(--radius-md)', margin: '12px 0' }}>
          {backupCodes.map((c) => <div key={c}>{c}</div>)}
        </div>
        <Button onClick={() => setBackupCodes(null)}>{t('security.backupSaved')}</Button>
      </Card>
    );
  }

  if (setupData) {
    return (
      <Card style={{ padding: '24px', maxWidth: '480px', marginTop: '20px' }}>
        <h3 style={{ marginTop: 0 }}>{t('security.setupTitle')}</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{t('security.setupScan')}</p>
        <img src={setupData.qrDataUrl} alt={t('security.qrAlt')} style={{ display: 'block', margin: '12px 0', width: '180px', height: '180px' }} />
        <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('security.cantScan')} <code>{setupData.secret}</code></p>
        <form onSubmit={handleConfirm}>
          <label style={labelStyle}>{t('security.sixDigit')}</label>
          <input required maxLength={6} value={confirmCode} onChange={(e) => setConfirmCode(e.target.value)} style={inputStyle} />
          <div style={{ display: 'flex', gap: '8px', marginTop: '14px' }}>
            <Button type="submit" disabled={enableTwoFactor.isPending}>{enableTwoFactor.isPending ? t('security.verifying') : t('security.confirmEnable')}</Button>
            <Button type="button" variant="secondary" onClick={() => setSetupData(null)}>{t('common.cancel')}</Button>
          </div>
        </form>
      </Card>
    );
  }

  return (
    <Card style={{ padding: '24px', maxWidth: '480px', marginTop: '20px' }}>
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
        <ShieldCheck size={18} color={enabled ? 'var(--success)' : 'var(--text-muted)'} />
        {t('security.twoFactor')}
      </h3>
      {enabled ? (
        <>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{t('security.twoFactorEnabled')}</p>
          <Button variant="danger" onClick={() => setDisableOpen(true)}>{t('security.disable2fa')}</Button>
        </>
      ) : (
        <>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{t('security.notEnabled')}</p>
          <Button onClick={handleStart} disabled={startSetup.isPending}>{startSetup.isPending ? t('security.starting') : t('security.enable2fa')}</Button>
        </>
      )}

      <ConfirmDialog
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        onConfirm={handleDisable}
        title={t('security.disableTitle')}
        message={
          <div>
            <p style={{ margin: '0 0 8px' }}>{t('security.disableConfirm')}</p>
            <input type="password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} style={inputStyle} placeholder={t('security.currentPassword')} />
          </div>
        }
        confirmLabel={t('security.disable2fa')}
        danger
        isLoading={disableTwoFactor.isPending}
      />
    </Card>
  );
}

const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginTop: '14px', marginBottom: '6px' };
const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '14px', boxSizing: 'border-box', fontFamily: 'inherit' };
