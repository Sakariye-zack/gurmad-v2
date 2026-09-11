import React, { useState } from 'react';
import { DollarSign, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, Modal, StatCard, LoadingState, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useExchangeRates, useSetExchangeRate } from '../../hooks/useFinancial.js';

// User-reported gap (Phase 10 Billing audit): the backend
// (GET/POST /v2/exchange-rates) and the frontend hooks
// (useExchangeRates/useSetExchangeRate) already existed, fully wired —
// there was simply no page to reach them. Without this, a SLSH payment
// would fail every time with 'No exchange rate is configured' and no
// admin had any way to set or even see the rate short of calling the
// API directly. Additive only — no route/hook logic changed.
export default function ExchangeRatesPage() {
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
    if (isNaN(r) || r <= 0) { setFormError('Enter a valid positive rate.'); return; }
    try {
      await setRate.mutateAsync(r);
      toast.success('Exchange rate updated.');
      setModalOpen(false);
      setRateInput('');
    } catch (err) {
      setFormError(err.message || 'Something went wrong.');
    }
  }

  return (
    <div>
      <PageHeader
        icon={DollarSign}
        title="Exchange Rate"
        subtitle="USD to SLSH — required for any SLSH payment to be recorded."
        actions={
          <RoleGate roles={['admin']}>
            <Button icon={Plus} onClick={() => setModalOpen(true)}>Set New Rate</Button>
          </RoleGate>
        }
      />

      {isLoading && <LoadingState label="Loading…" />}
      {error && <p style={{ color: 'var(--danger)', fontSize: '13px' }}>{error.message}</p>}

      {!isLoading && !error && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '24px' }}>
            <StatCard
              label="Current Rate"
              value={current ? `1 USD = ${parseFloat(current.rate).toLocaleString()} SLSH` : 'Not set'}
              icon={DollarSign}
              accent={current ? 'var(--success)' : 'var(--danger)'}
            />
            <StatCard
              label="Effective Since"
              value={current ? new Date(current.effective_from).toLocaleString() : '—'}
            />
          </div>

          {!current && (
            <p style={{ fontSize: '13px', color: 'var(--danger)', marginBottom: '16px' }}>
              No exchange rate has ever been set — every SLSH payment attempt will fail until one is.
            </p>
          )}

          <DataTable
            isEmpty={rates.length === 0}
            emptyTitle="No exchange rate history"
            columns={[{ label: 'Rate (SLSH per USD)', align: 'right' }, { label: 'Effective From' }, { label: 'Set By' }]}
          >
            {rates.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td className="tabular-nums" style={{ ...cellStyle, textAlign: 'right', fontWeight: r === current ? 700 : 400 }}>
                  {parseFloat(r.rate).toLocaleString()}
                </td>
                <td style={cellStyle}>{new Date(r.effective_from).toLocaleString()}</td>
                <td style={cellStyle}>{r.set_by ? `Staff #${r.set_by}` : '—'}</td>
              </tr>
            ))}
          </DataTable>
        </>
      )}

      <Modal
        open={modalOpen}
        onClose={setRate.isPending ? () => {} : () => setModalOpen(false)}
        title="Set New Exchange Rate"
        footer={<>
          <Button variant="secondary" onClick={() => setModalOpen(false)} disabled={setRate.isPending}>Cancel</Button>
          <Button type="submit" form="rate-form" disabled={setRate.isPending}>{setRate.isPending ? 'Saving…' : 'Set Rate'}</Button>
        </>}
      >
        <form id="rate-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
            This takes effect immediately and applies to every SLSH payment recorded from now on.
            The rate history is permanent — a new rate is always added, never edited.
          </p>
          <label style={fieldStyle}>
            <span style={labelStyle}>1 USD equals how many SLSH?</span>
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
