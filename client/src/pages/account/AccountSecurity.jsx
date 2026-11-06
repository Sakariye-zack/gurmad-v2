import React, { useState } from 'react';
import { ShieldAlert, ShieldCheck, Monitor, History, LogOut } from 'lucide-react';
import { Button, Card, PageHeader, ConfirmDialog, useToast } from '../../components/ui/index.js';
import { apiClient } from '../../lib/apiClient.js';
import { useTwoFactorStatus, useStartTwoFactorSetup, useEnableTwoFactor, useDisableTwoFactor } from '../../hooks/useTwoFactor.js';
import { useMySessions, useRevokeSession, useMyLoginHistory } from '../../hooks/useAccountSecurity.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { isPasswordAcceptable } from '../../lib/passwordPolicy.js';
import PasswordStrength from '../../components/PasswordStrength.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';

// User & Access Administration — self-service staff account security.
// Directly mirrors the Customer Portal's own already-proven
// PortalAccountSecurity.jsx pattern (password change swaps in a fresh
// token so this device stays signed in; logout-all is the explicit
// security-compromise-response action, OD-3) — no new UX pattern invented.
export default function AccountSecurity() {
  const toast = useToast();
  const { t } = useI18n();
  const { user, updateUser, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [logoutAllConfirmOpen, setLogoutAllConfirmOpen] = useState(false);
  const [loggingOutAll, setLoggingOutAll] = useState(false);

  async function handleChangePassword(e) {
    e.preventDefault();
    if (!isPasswordAcceptable(newPassword, user?.username)) {
      toast.error(t('pwPolicy.summary'));
      return;
    }
    setSaving(true);
    try {
      const res = await apiClient.post('/v2/auth/password/change', { currentPassword, newPassword });
      if (res.data?.token) apiClient.setToken(res.data.token);
      updateUser({ must_change_password: false });
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
      logout();
      window.location.href = '/login';
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
      setLoggingOutAll(false);
    }
  }

  return (
    <div>
      <PageHeader icon={ShieldAlert} title={t('security.title')} subtitle={t('security.subtitle')} />

      {user?.must_enroll_2fa && (
        <div role="alert" style={{ maxWidth: '720px', marginBottom: '20px', padding: '14px 16px', borderRadius: 'var(--radius-md)', background: 'var(--warning-bg)', color: 'var(--warning)', border: '1px solid var(--warning)', display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <ShieldAlert size={20} style={{ flexShrink: 0, marginTop: '2px' }} />
          <div style={{ flex: '1 1 260px' }}>
            <strong style={{ display: 'block', marginBottom: '4px' }}>{t('mfaGate.title')}</strong>
            <span style={{ fontSize: '13px' }}>{t('mfaGate.body')}</span>
          </div>
          <Button variant="secondary" onClick={logout}><LogOut size={14} style={{ marginRight: '6px', verticalAlign: '-2px' }} />{t('nav.logout')}</Button>
        </div>
      )}

      <TwoFactorCard />

      <Card style={{ padding: '24px', maxWidth: '480px', marginBottom: '20px' }}>
        <h3 style={{ marginTop: 0 }}>{t('security.changePassword')}</h3>
        <form onSubmit={handleChangePassword}>
          <label style={labelStyle}>{t('security.currentPassword')}</label>
          <input type="password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} style={inputStyle} />
          <label style={labelStyle}>{t('security.newPassword')}</label>
          <input type="password" required autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={inputStyle} />
          <PasswordStrength password={newPassword} username={user?.username} />
          <Button type="submit" disabled={saving} style={{ marginTop: '14px' }}>{saving ? t('common.saving') : t('security.changePassword')}</Button>
        </form>
      </Card>

      <SessionsCard onLogoutAll={() => setLogoutAllConfirmOpen(true)} />
      <LoginHistoryCard />

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
  const { refreshSecurityStatus } = useAuth();
  const { data: statusData, isLoading } = useTwoFactorStatus();
  const enabled = statusData?.data?.enabled;
  const required = statusData?.data?.required;
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
      refreshSecurityStatus(); // lifts the mandatory-2FA hold, if any
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
          {required
            ? <p style={{ color: 'var(--text-muted)', fontSize: '12px', fontStyle: 'italic' }}>{t('mfaGate.cannotDisable')}</p>
            : <Button variant="danger" onClick={() => setDisableOpen(true)}>{t('security.disable2fa')}</Button>}
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

function formatWhen(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

// Active sessions — every signed-in device, with a per-device sign-out.
function SessionsCard({ onLogoutAll }) {
  const toast = useToast();
  const { t } = useI18n();
  const { logout } = useAuth();
  const { data, isLoading } = useMySessions();
  const revoke = useRevokeSession();
  const sessions = data?.data || [];

  async function handleRevoke(s) {
    try {
      await revoke.mutateAsync(s.id);
      if (s.current) { logout(); return; } // RequireAuth then sends this device to /login
      toast.success(t('sessions.revoked'));
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Card style={{ padding: '24px', maxWidth: '720px', marginBottom: '20px' }}>
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '8px' }}><Monitor size={18} />{t('sessions.title')}</h3>
      {isLoading ? null : sessions.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{t('sessions.none')}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px', display: 'grid', gap: '8px' }}>
          {sessions.map((s) => (
            <li key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: '14px' }}>
                  {s.device}
                  {s.current && <span style={{ marginLeft: '8px', fontSize: '11px', fontWeight: 700, color: 'var(--success)' }}>{t('sessions.thisDevice')}</span>}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>
                  {s.ip || '—'} · {t('sessions.lastActive')} {formatWhen(s.last_seen_at)}
                </div>
              </div>
              <Button variant="secondary" disabled={revoke.isPending} onClick={() => handleRevoke(s)}>{t('sessions.revoke')}</Button>
            </li>
          ))}
        </ul>
      )}
      <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{t('security.logoutAllBody')}</p>
      <Button variant="danger" onClick={onLogoutAll}>{t('security.logoutAll')}</Button>
    </Card>
  );
}

const EVENT_KEYS = {
  login_success: 'history.event.login_success',
  login_failed: 'history.event.login_failed',
  locked: 'history.event.locked',
  '2fa_failed': 'history.event.2fa_failed',
  logout: 'history.event.logout',
  password_changed: 'history.event.password_changed',
};
const BAD_EVENTS = ['login_failed', 'locked', '2fa_failed'];

// Sign-in history — the account's last 50 security events.
function LoginHistoryCard() {
  const { t } = useI18n();
  const { data, isLoading } = useMyLoginHistory();
  const rows = data?.data || [];
  return (
    <Card style={{ padding: '24px', maxWidth: '720px', marginBottom: '20px' }}>
      <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '8px' }}><History size={18} />{t('history.title')}</h3>
      {isLoading ? null : rows.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{t('history.none')}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase' }}>
                <th style={cellStyle}>{t('history.when')}</th>
                <th style={cellStyle}>{t('history.event')}</th>
                <th style={cellStyle}>{t('history.device')}</th>
                <th style={cellStyle}>IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{formatWhen(r.created_at)}</td>
                  <td style={{ ...cellStyle, fontWeight: 600, color: BAD_EVENTS.includes(r.event) ? 'var(--danger)' : 'var(--text)' }}>{t(EVENT_KEYS[r.event] || r.event, r.event)}</td>
                  <td style={cellStyle}>{r.device}</td>
                  <td style={{ ...cellStyle, overflowWrap: 'anywhere' }}>{r.ip || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const cellStyle = { padding: '8px 8px 8px 0' };
const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginTop: '14px', marginBottom: '6px' };
const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '14px', boxSizing: 'border-box', fontFamily: 'inherit' };
