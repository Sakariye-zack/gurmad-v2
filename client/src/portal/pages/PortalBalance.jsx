import React, { useEffect, useState } from 'react';
import { DataTable, StatusBadge, EmptyState, StatCard } from '../../components/ui/index.js';
import { Wallet, AlertTriangle } from 'lucide-react';
import PortalPageHeader from '../components/PortalPageHeader.jsx';
import { portalApiClient } from '../apiClient.js';

// Gap-audit sweep (Phase 10, continuation): GET /v2/customer-portal/balance
// was fully built server-side (outstanding invoice balance + the itemized
// list of individual debts — id, amount, currency, description, status,
// created_at) but no portal page ever called it. The Dashboard's own
// "Outstanding Debt" stat card only ever showed the aggregate sum
// (from /summary) with no way to see WHAT those debts actually are — a
// customer could see they owed money but not why. Reached via a click on
// that stat card / banner (not a 7th top-level nav tab — the existing
// 6-item PortalShell nav is already tight at mobile widths).
const DEBT_STATUS_MAP = { unpaid: 'danger', paid: 'success', waived: 'info' };

export default function PortalBalance() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    portalApiClient.get('/balance')
      .then((res) => setData(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  const debts = data?.debts || [];

  return (
    <div>
      <PortalPageHeader title="My Balance" subtitle="Your outstanding invoice balance and any debts on your account." />

      {data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px', marginBottom: '16px' }}>
          <StatCard label="Outstanding Invoice Balance" value={`$${data.outstandingInvoiceBalance.toFixed(2)}`} icon={Wallet} accent="#2563EB" />
          <StatCard
            label="Outstanding Debt"
            value={`$${debts.filter((d) => d.status === 'unpaid').reduce((sum, d) => sum + parseFloat(d.amount), 0).toFixed(2)}`}
            icon={AlertTriangle}
            accent="#DC2626"
          />
        </div>
      )}

      <h3 style={{ margin: '0 0 10px', fontSize: '14px' }}>Debt Details</h3>
      <DataTable
        loading={loading}
        error={error}
        onRetry={load}
        columns={[{ label: 'Description' }, { label: 'Amount', align: 'right' }, { label: 'Status' }, { label: 'Date' }]}
        isEmpty={debts.length === 0}
      >
        {debts.length === 0 ? (
          <tr><td colSpan={4}><EmptyState title="No debts on your account" /></td></tr>
        ) : debts.map((d) => (
          <tr key={d.id} style={{ borderTop: '1px solid var(--border)' }}>
            <td style={tdStyle}>{d.description || '—'}</td>
            <td className="tabular-nums" style={{ ...tdStyle, textAlign: 'right' }}>{d.currency} {parseFloat(d.amount).toFixed(2)}</td>
            <td style={tdStyle}><StatusBadge status={d.status} map={DEBT_STATUS_MAP} /></td>
            <td style={tdStyle}>{new Date(d.created_at).toLocaleDateString()}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

const tdStyle = { padding: '10px 14px' };
