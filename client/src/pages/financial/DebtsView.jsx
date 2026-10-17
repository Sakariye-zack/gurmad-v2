import React, { useState } from 'react';
import { HandCoins, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, StatCard, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useDebts, useSettleDebt, useCreateDebt } from '../../hooks/useFinancial.js';
import { useCustomers } from '../../hooks/useCustomers.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

const STATUS_MAP = { unpaid: 'danger', paid: 'success' };

export default function DebtsView() {
  const { t } = useI18n();
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [settleTarget, setSettleTarget] = useState(null);
  // User-reported gap (Phase 10 Billing audit): useCreateDebt() already
  // existed in useFinancial.js, fully wired to the backend, but nothing
  // in this file ever called it — a standalone debt (not linked to an
  // invoice) had no way to be created through the UI at all.
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, error, refetch } = useDebts({ status: statusFilter || undefined, q: search || undefined });
  const settleDebt = useSettleDebt();
  const toast = useToast();
  const debts = data?.data || [];
  const unpaidCount = debts.filter((d) => d.status === 'unpaid').length;

  async function handleSettle(overrideReason) {
    try {
      await settleDebt.mutateAsync({ id: settleTarget.id, settlement_override_reason: overrideReason || undefined });
      toast.success(t('fin.debt_settled'));
      setSettleTarget(null);
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <div>
      <PageHeader
        icon={HandCoins}
        title={t('nav.debts')}
        subtitle={t('fin.outstanding_amounts_owed_traceable_t')}
        actions={
          <RoleGate roles={['admin', 'cashier', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setCreateOpen(true)}>{t('fin.create_debt')}</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label={t('fin.total_debts')} value={error ? '—' : debts.length} icon={HandCoins} />
        <StatCard label={t('status.unpaid')} value={error ? '—' : unpaidCount} icon={HandCoins} accent="var(--danger)" />
      </div>

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder={t('fin.search_by_customer_name_or')}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">{t('cust.all_statuses')}</option>
          <option value="unpaid">{t('status.unpaid')}</option>
          <option value="paid">{t('status.paid')}</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && debts.length === 0}
        emptyTitle={t('fin.no_debts_recorded')}
        columns={[{ label: t('fin.customer') }, { label: t('common.amount') }, { label: t('fin.linked_invoice') }, { label: t('common.status') }, { label: t('fin.actions') }]}
      >
        {debts.map((d) => (
          <tr key={d.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{d.customer_name} <span style={{ color: 'var(--text-muted)' }}>({d.customer_number})</span></td>
            <td style={cellStyle} className="tabular-nums">{d.currency} {parseFloat(d.amount).toFixed(2)}</td>
            <td style={cellStyle}>
              {d.invoice_id ? (d.invoice_number || `#${d.invoice_id}`) : <span style={{ color: 'var(--text-muted)' }}>{t('cust.standalone')}</span>}
              {/* User-requested (Phase 10 — 'qaabkeebu partial iyo debt
                  ba u diiwaan galin karaa'): auto-tracked debts (kept in
                  sync by payments.js on every payment/reversal against
                  the invoice) are visually distinguished from ones a
                  person created by hand, so nobody mistakes a live,
                  system-maintained number for a fixed manual entry. */}
              {d.source === 'auto_invoice' && (
                <span style={{ marginLeft: '6px', fontSize: '10px', fontWeight: 700, color: 'var(--info)', textTransform: 'uppercase' }}>{t('fin.auto')}</span>
              )}
            </td>
            <td style={cellStyle}><StatusBadge status={d.status} map={STATUS_MAP} /></td>
            <td style={cellStyle}>
              {d.status === 'unpaid' && (
                <RoleGate roles={['admin', 'cashier']}>
                  <Button variant="secondary" onClick={() => setSettleTarget(d)}>{t('fin.settle')}</Button>
                </RoleGate>
              )}
            </td>
          </tr>
        ))}
      </DataTable>

      <Modal
        open={!!settleTarget}
        onClose={() => setSettleTarget(null)}
        title={t('fin.settle_debt')}
        footer={<>
          <Button variant="secondary" onClick={() => setSettleTarget(null)}>{t('common.cancel')}</Button>
          <Button onClick={() => handleSettle(document.getElementById('override-reason')?.value)} disabled={settleDebt.isPending}>{t('fin.settle')}</Button>
        </>}
      >
        <p style={{ margin: '0 0 10px', fontSize: '13px', color: 'var(--text-muted)' }}>
          {t('fin.if_this_debt_is_linked')}
        </p>
        <input id="override-reason" placeholder={t('fin.override_reason_only_needed_if')} style={inputStyle} />
      </Modal>

      <CreateDebtModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateDebtModal({ open, onClose }) {
  const { t } = useI18n();
  const [customerId, setCustomerId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const { data: customersData } = useCustomers({});
  const createDebt = useCreateDebt();
  const toast = useToast();
  const customers = customersData?.data || [];

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const amt = parseFloat(amount);
    if (!customerId) { setError(t('fin.select_a_customer')); return; }
    if (isNaN(amt) || amt <= 0) { setError(t('fin.enter_a_valid_amount')); return; }
    try {
      await createDebt.mutateAsync({ customer_id: parseInt(customerId, 10), amount: amt, currency, description: description || undefined });
      toast.success(t('fin.debt_recorded'));
      onClose();
      setCustomerId(''); setAmount(''); setCurrency('USD'); setDescription('');
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      onClose={createDebt.isPending ? () => {} : onClose}
      title={t('fin.create_debt')}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={createDebt.isPending}>{t('common.cancel')}</Button>
        <Button type="submit" form="debt-form" disabled={createDebt.isPending}>{createDebt.isPending ? t('common.saving') : t('fin.create_debt')}</Button>
      </>}
    >
      <form id="debt-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
          {t('fin.for_an_amount_a_customer')}
        </p>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('fin.customer')}</span>
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} style={inputStyle}>
            <option value="">{t('fin.select_a_customer_2')}</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_number} — {c.business_name || c.name}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', gap: '10px' }}>
          <label style={{ ...fieldStyle, flex: 1 }}>
            <span style={labelStyle}>{t('common.amount')}</span>
            <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={inputStyle} />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('fin.currency')}</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle}>
              <option value="USD">USD</option>
              <option value="SLSH">SLSH</option>
            </select>
          </label>
        </div>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('fin.description_optional')}</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} />
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

const cellStyle = { padding: '12px 14px' };
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
