import React, { useState } from 'react';
import { HandCoins } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, StatCard, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useDebts, useSettleDebt } from '../../hooks/useFinancial.js';

const STATUS_MAP = { unpaid: 'danger', paid: 'success' };

export default function DebtsView() {
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [settleTarget, setSettleTarget] = useState(null);
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
      <PageHeader icon={HandCoins} title="Debts" subtitle="Outstanding amounts owed, traceable to their originating invoice where applicable." />

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
            <td style={cellStyle}>{d.invoice_id ? `#${d.invoice_id}` : <span style={{ color: 'var(--text-muted)' }}>Standalone</span>}</td>
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
    </div>
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
