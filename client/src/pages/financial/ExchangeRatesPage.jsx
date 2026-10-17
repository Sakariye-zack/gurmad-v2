import React, { useState } from 'react';
import { DollarSign, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, Modal, StatCard, LoadingState, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useExchangeRates, useSetExchangeRate } from '../../hooks/useFinancial.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

// User-reported gap (Phase 10 Billing audit): the backend
// (GET/POST /v2/exchange-rates) and the frontend hooks
// (useExchangeRates/useSetExchangeRate) already existed, fully wired —
// there was simply no page to reach them. Without this, a SLSH payment
// would fail every time with 'No exchange rate is configured' and no
// admin had any way to set or even see the rate short of calling the
// API directly. Additive only — no route/hook logic changed.
export default function ExchangeRatesPage() {
  const { t } = useI18n();
  const { data, isLoading, error, refetch } = useExchangeRates();
  const setRate = useSetExchangeRate();
  const toast = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [rate, setRateInput] = useState('');
  const [formError, setFormError] = useState('');

  const rates = data?.data || [];
  const current = rates[0]; // append-only, ORDER BY effective_from DESC — index 0 is always current

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError('');
    const r = parseFloat(rate);
    if (isNaN(r) || r <= 0) { setFormError(t('fin.enter_a_valid_positive_rate')); return; }
    try {
      await setRate.mutateAsync(r);
      toast.success(t('fin.exchange_rate_updated'));
      setModalOpen(false);
      setRateInput('');
    } catch (err) {
      setFormError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <div>
      <PageHeader
        icon={DollarSign}
        title={t('nav.exchangeRate')}
        subtitle={t('fin.usd_to_slsh_required_for')}
        actions={
          <RoleGate roles={['admin']}>
            <Button icon={Plus} onClick={() => setModalOpen(true)}>{t('fin.set_new_rate')}</Button>
          </RoleGate>
        }
      />

      {isLoading && <LoadingState label={t('common.loading')} />}
      {error && <p style={{ color: 'var(--danger)', fontSize: '13px' }}>{error.message}</p>}

      {!isLoading && !error && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            <StatCard
              label={t('fin.current_rate')}
              value={current ? `1 USD = ${parseFloat(current.rate).toLocaleString()} SLSH` : 'Not set'}
              icon={DollarSign}
              accent={current ? 'var(--success)' : 'var(--danger)'}
            />
            <StatCard
              label={t('fin.effective_since')}
              value={current ? new Date(current.effective_from).toLocaleString() : '—'}
            />
          </div>

          {!current && (
            <p style={{ fontSize: '13px', color: 'var(--danger)', marginBottom: '16px' }}>
              {t('fin.no_exchange_rate_has_ever')}
            </p>
          )}

          <DataTable
            isEmpty={rates.length === 0}
            emptyTitle={t('fin.no_exchange_rate_history')}
            columns={[{ label: t('fin.rate_slsh_per_usd'), align: 'right' }, { label: t('fin.effective_from') }, { label: t('fin.set_by') }]}
          >
            {rates.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td className="tabular-nums" style={{ ...cellStyle, textAlign: 'right', fontWeight: r === current ? 700 : 400 }}>
                  {parseFloat(r.rate).toLocaleString()}
                </td>
                <td style={cellStyle}>{new Date(r.effective_from).toLocaleString()}</td>
                <td style={cellStyle}>{r.set_by ? t('fin.m.staffNum', undefined, { id: r.set_by }) : '—'}</td>
              </tr>
            ))}
          </DataTable>
        </>
      )}

      <Modal
        open={modalOpen}
        onClose={setRate.isPending ? () => {} : () => setModalOpen(false)}
        title={t('fin.set_new_exchange_rate')}
        footer={<>
          <Button variant="secondary" onClick={() => setModalOpen(false)} disabled={setRate.isPending}>{t('common.cancel')}</Button>
          <Button type="submit" form="rate-form" disabled={setRate.isPending}>{setRate.isPending ? t('common.saving') : t('fin.set_rate')}</Button>
        </>}
      >
        <form id="rate-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
            {t('fin.this_takes_effect_immediately_and')}
          </p>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('fin.1_usd_equals_how_many')}</span>
            <input type="number" min="0" step="0.01" autoFocus value={rate} onChange={(e) => setRateInput(e.target.value)} style={inputStyle} />
          </label>
          {formError && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{formError}</span>}
        </form>
      </Modal>
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
