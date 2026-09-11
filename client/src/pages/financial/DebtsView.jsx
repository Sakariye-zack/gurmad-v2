import React, { useState } from 'react';
import { HandCoins, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, StatCard, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useDebts, useSettleDebt, useCreateDebt } from '../../hooks/useFinancial.js';
import { useCustomers } from '../../hooks/useCustomers.js';

const STATUS_MAP = { unpaid: 'danger', paid: 'success' };

export default function DebtsView() {
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
      toast.success('Debt settled.');
      setSettleTarget(null);
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    }
  }

  return (
    <div>
      <PageHeader
        icon={HandCoins}
        title="Debts"
        subtitle="Outstanding amounts owed, traceable to their originating invoice where applicable."
        actions={
          <RoleGate roles={['admin', 'cashier', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setCreateOpen(true)}>Create Debt</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Total Debts" value={error ? '—' : debts.length} icon={HandCoins} />
        <StatCard label="Unpaid" value={error ? '—' : unpaidCount} icon={HandCoins} accent="var(--danger)" />
      </div>

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder="Search by customer name or number…">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          <option value="unpaid">Unpaid</option>
          <option value="paid">Paid</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && debts.length === 0}
        emptyTitle="No debts recorded"
        columns={[{ label: 'Customer' }, { label: 'Amount' }, { label: 'Linked Invoice' }, { label: 'Status' }, { label: 'Actions' }]}
      >
        {debts.map((d) => (
          <tr key={d.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{d.customer_name} <span style={{ color: 'var(--text-muted)' }}>({d.customer_number})</span></td>
            <td style={cellStyle} className="tabular-nums">{d.currency} {parseFloat(d.amount).toFixed(2)}</td>
            <td style={cellStyle}>{d.invoice_id ? (d.invoice_number || `#${d.invoice_id}`) : <span style={{ color: 'var(--text-muted)' }}>Standalone</span>}</td>
            <td style={cellStyle}><StatusBadge status={d.status} map={STATUS_MAP} /></td>
            <td style={cellStyle}>
              {d.status === 'unpaid' && (
                <RoleGate roles={['admin', 'cashier']}>
                  <Button variant="secondary" onClick={() => setSettleTarget(d)}>Settle</Button>
                </RoleGate>
              )}
            </td>
          </tr>
        ))}
      </DataTable>

      <Modal
        open={!!settleTarget}
        onClose={() => setSettleTarget(null)}
        title="Settle Debt"
        footer={<>
          <Button variant="secondary" onClick={() => setSettleTarget(null)}>Cancel</Button>
          <Button onClick={() => handleSettle(document.getElementById('override-reason')?.value)} disabled={settleDebt.isPending}>Settle</Button>
        </>}
      >
        <p style={{ margin: '0 0 10px', fontSize: '13px', color: 'var(--text-muted)' }}>
          If this debt is linked to an invoice that still has an outstanding balance, a reason is required to settle it anyway.
        </p>
        <input id="override-reason" placeholder="Override reason (only needed if the linked invoice is still outstanding)" style={inputStyle} />
      </Modal>

      <CreateDebtModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateDebtModal({ open, onClose }) {
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
    if (!customerId) { setError('Select a customer.'); return; }
    if (isNaN(amt) || amt <= 0) { setError('Enter a valid amount.'); return; }
    try {
      await createDebt.mutateAsync({ customer_id: parseInt(customerId, 10), amount: amt, currency, description: description || undefined });
      toast.success('Debt recorded.');
      onClose();
      setCustomerId(''); setAmount(''); setCurrency('USD'); setDescription('');
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={createDebt.isPending ? () => {} : onClose}
      title="Create Debt"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={createDebt.isPending}>Cancel</Button>
        <Button type="submit" form="debt-form" disabled={createDebt.isPending}>{createDebt.isPending ? 'Saving…' : 'Create Debt'}</Button>
      </>}
    >
      <form id="debt-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
          For an amount a customer owes that isn't tied to an existing invoice
          (e.g. a verbal agreement, a carried-over balance). To record a debt
          against a specific invoice's shortfall instead, use that invoice's
          own detail page.
        </p>
        <label style={fieldStyle}>
          <span style={labelStyle}>Customer</span>
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} style={inputStyle}>
            <option value="">Select a customer…</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_number} — {c.business_name || c.name}</option>)}
          </select>
        </label>
        <div style={{ display: 'flex', gap: '10px' }}>
          <label style={{ ...fieldStyle, flex: 1 }}>
            <span style={labelStyle}>Amount</span>
            <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={inputStyle} />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>Currency</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle}>
              <option value="USD">USD</option>
              <option value="SLSH">SLSH</option>
            </select>
          </label>
        </div>
        <label style={fieldStyle}>
          <span style={labelStyle}>Description (optional)</span>
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
