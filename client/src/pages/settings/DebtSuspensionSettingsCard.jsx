import React, { useState } from 'react';
import { Card, Button, useToast } from '../../components/ui/index.js';
import { useCompanySettings, useUpdateCompanySettings } from '../../hooks/useSettings.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

// F3 debt suspension: days of unpaid debt before a customer is listed on the
// Debt suspensions page. 0 turns the list off. Admin only (Settings page).
export default function DebtSuspensionSettingsCard() {
  const { data } = useCompanySettings();
  const current = data?.data?.debt_suspend_days ?? 90;
  // Keyed on the saved value so the input resets when it changes.
  return <DaysForm key={current} current={current} />;
}

function DaysForm({ current }) {
  const { t } = useI18n();
  const toast = useToast();
  const update = useUpdateCompanySettings();
  const [days, setDays] = useState(String(current));
  const [error, setError] = useState('');

  async function save(e) {
    e.preventDefault();
    const n = Number(days);
    if (!/^\d+$/.test(days) || n > 3650) { setError(t('debtSusp.settings.invalid')); return; }
    setError('');
    try {
      await update.mutateAsync({ debt_suspend_days: n });
      toast.success(t('debtSusp.settings.saved'));
    } catch (err) {
      toast.error(err.message);
    }
  }

  return (
    <Card style={{ padding: '20px', marginTop: '16px' }}>
      <span style={{ display: 'block', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
        {t('debtSusp.settings.title')}
      </span>
      <form onSubmit={save} style={{ display: 'flex', alignItems: 'flex-end', gap: '12px', flexWrap: 'wrap', marginTop: '12px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '0 1 220px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('debtSusp.settings.days')}</span>
          <input
            inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.trim())}
            style={{ padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', boxSizing: 'border-box' }}
          />
        </label>
        <Button type="submit" disabled={update.isPending}>{t('common.save', 'Save')}</Button>
      </form>
      <span style={{ fontSize: '11px', color: error ? 'var(--danger)' : 'var(--text-muted)', marginTop: '6px', display: 'block' }}>
        {error || t('debtSusp.settings.hint')}
      </span>
    </Card>
  );
}
