import React, { useEffect, useState } from 'react';
import { KeyRound, Ban, RotateCcw } from 'lucide-react';
import { Card, Button, Modal, StatusBadge, ConfirmDialog, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { apiClient } from '../../lib/apiClient.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

// Phase 4 — Customer Portal — OD-5: a minimal, additive UI integration
// into the CLOSED Module 2 Customer Detail page. This component only
// calls the new Customer Portal API (POST /v2/customer-portal/accounts,
// GET /v2/customer-portal/accounts/by-customer/:id) — it never touches
// Module 2's own customer routes/schema, and Module 2's own CRUD behavior
// is unchanged (this card is purely additive below the existing page
// content).
export default function CustomerPortalAccessCard({ customerId }) {
  const { t } = useI18n();
  const toast = useToast();
  const [account, setAccount] = useState(undefined); // undefined = loading, null = none
  const [modalOpen, setModalOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function load() {
    apiClient.get(`/v2/customer-portal/accounts/by-customer/${customerId}`)
      .then((res) => setAccount(res.data))
      .catch(() => setAccount(null));
  }

  useEffect(load, [customerId]);

  async function handleActivate(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await apiClient.post('/v2/customer-portal/accounts', { customer_id: Number(customerId), initial_password: password });
      toast.success(t('cust.portal_access_activated_share_the'));
      setModalOpen(false);
      setPassword('');
      load();
    } catch (err) {
      toast.error(err.message || t('cust.failed_to_activate_portal_access'));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleDisable() {
    setSaving(true);
    try {
      const action = account.status === 'active' ? 'disable' : 'enable';
      await apiClient.put(`/v2/customer-portal/accounts/${account.id}/${action}`);
      toast.success(action === 'disable' ? t('cust.portal_access_disabled') : t('cust.portal_access_re_enabled'));
      setConfirmOpen(false);
      load();
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <RoleGate roles={['admin']}>
      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: '0 0 4px', fontSize: '14px' }}>{t('cust.customer_portal_access')}</h3>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>
              {account === undefined
                ? t('common.loading')
                : account
                  ? <>Portal account <StatusBadge status={account.status} /> since {new Date(account.created_at).toLocaleDateString()}</>
                  : t('cust.this_customer_does_not_yet')}
            </p>
          </div>
          {account === null && (
            <Button variant="secondary" icon={KeyRound} onClick={() => setModalOpen(true)}>{t('cust.activate_portal_access')}</Button>
          )}
          {account && (
            <Button
              variant={account.status === 'active' ? 'danger' : 'primary'}
              icon={account.status === 'active' ? Ban : RotateCcw}
              onClick={() => setConfirmOpen(true)}
            >
              {account.status === 'active' ? t('cust.disable_access') : t('cust.re_enable_access')}
            </Button>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleToggleDisable}
        title={account?.status === 'active' ? t('cust.disable_portal_access') : t('cust.re_enable_portal_access')}
        message={account?.status === 'active'
          ? t('cust.this_customer_will_no_longer')
          : t('cust.this_customer_will_be_able')}
        confirmLabel={account?.status === 'active' ? t('cust.disable') : t('cust.re_enable')}
        danger={account?.status === 'active'}
        isLoading={saving}
      />

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={t('cust.activate_portal_access')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleActivate} disabled={saving || password.length < 8}>{saving ? t('cust.activating') : t('cust.activate')}</Button>
          </>
        }
      >
        <p style={{ marginTop: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
          {t('cust.set_an_initial_password_for')}
        </p>
        <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '6px' }}>
          {t('cust.initial_password')}
        </label>
        <input
          type="text"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '14px', boxSizing: 'border-box' }}
        />
      </Modal>
    </RoleGate>
  );
}
