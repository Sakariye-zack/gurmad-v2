import React, { useState } from 'react';
import { BarChart3, Printer, Download } from 'lucide-react';
import { PageHeader, Button, Card, DataTable, StatusBadge, StatCard, LoadingState, ErrorState, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import {
  useExecutiveSummary, useCollectorPerformance, useZonePerformance, useTruckPerformance,
  useCollectionHistory, useRevenue, useInvoicesSummary, usePaymentsSummary, useDebtsSummary,
  useCashoutSummary, downloadReportCsv,
} from '../../hooks/useReports.js';

// Module 8 — Reports. One page, internal tabs (per instruction: tabs/
// subsections rather than unnecessary separate pages). UI consumes
// authoritative, already-computed API results only — no total is ever
// recalculated here. Financial/Cashout tabs are RoleGate-hidden for
// Collector (the tab itself, not just its content) — matching the
// server's own 403-before-any-query enforcement, never relying on this
// hiding as the real boundary.
const PERIOD_OPTIONS = [
  { value: 'today', label: 'Today' }, { value: 'this_week', label: 'This Week' },
  { value: 'this_month', label: 'This Month' }, { value: 'quarterly', label: 'Quarterly' },
  { value: 'custom', label: 'Custom Range' },
];

const TABS = [
  { key: 'overview', label: 'Overview', financial: false },
  { key: 'collector', label: 'Collector', financial: false, group: 'Collection Performance' },
  { key: 'zone', label: 'Zone', financial: false, group: 'Collection Performance' },
  { key: 'truck', label: 'Truck', financial: false, group: 'Collection Performance' },
  { key: 'history', label: 'Collection History', financial: false },
  { key: 'revenue', label: 'Revenue', financial: true, group: 'Financial' },
  { key: 'invoices', label: 'Invoices', financial: true, group: 'Financial' },
  { key: 'payments', label: 'Payments', financial: true, group: 'Financial' },
  { key: 'debts', label: 'Debts', financial: true, group: 'Financial' },
  { key: 'cashout', label: 'Cashout', financial: true },
];

export default function ReportsPage() {
  const { user } = useAuth();
  const isCollector = (user?.role || '').toLowerCase() === 'collector';
  const [tab, setTab] = useState(isCollector ? 'collector' : 'overview');
  const [period, setPeriod] = useState('today');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const toast = useToast();

  async function handleExport(category, extra = {}) {
    try {
      await downloadReportCsv(category, period, customStart, customEnd, extra);
      toast.success('CSV downloaded.');
    } catch (err) {
      toast.error(err.message || 'Failed to export.');
    }
  }

  const visibleTabs = TABS.filter((t) => !t.financial || !isCollector);

  return (
    <div>
      <PageHeader icon={BarChart3} title="Reports" subtitle="Collection performance and financial reporting across V2." />

      <Card style={{ padding: '12px 16px', marginBottom: '20px', display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }} className="no-print">
        <select value={period} onChange={(e) => setPeriod(e.target.value)} style={selectStyle}>
          {PERIOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {period === 'custom' && (
          <>
            <input type="date" value={customStart} onChange={(e) => setCustomStart(e.target.value)} style={selectStyle} />
            <input type="date" value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} style={selectStyle} />
          </>
        )}
        <Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print / Download PDF</Button>
      </Card>

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '20px', borderBottom: '1px solid var(--border)', paddingBottom: '10px' }} className="no-print">
        {visibleTabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} style={tabButtonStyle(tab === t.key)}>{t.label}</button>
        ))}
      </div>

      <style>{`@media print { .no-print { display: none !important; } }`}</style>

      {tab === 'overview' && <OverviewTab period={period} customStart={customStart} customEnd={customEnd} />}
      {tab === 'collector' && <CollectorTab period={period} customStart={customStart} customEnd={customEnd} onExport={() => handleExport('collector-performance')} isCollector={isCollector} />}
      {tab === 'zone' && <ZoneTab period={period} customStart={customStart} customEnd={customEnd} onExport={() => handleExport('zone-performance')} />}
      {tab === 'truck' && <TruckTab period={period} customStart={customStart} customEnd={customEnd} />}
      {tab === 'history' && <HistoryTab period={period} customStart={customStart} customEnd={customEnd} onExport={(extra) => handleExport('collection-history', extra)} />}
      {tab === 'revenue' && (
        <RoleGate roles={['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier']}>
          <RevenueTab period={period} customStart={customStart} customEnd={customEnd} />
        </RoleGate>
      )}
      {tab === 'invoices' && (
        <RoleGate roles={['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier']}>
          <InvoicesTab period={period} customStart={customStart} customEnd={customEnd} onExport={() => handleExport('invoices-summary')} />
        </RoleGate>
      )}
      {tab === 'payments' && (
        <RoleGate roles={['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier']}>
          <PaymentsTab period={period} customStart={customStart} customEnd={customEnd} onExport={() => handleExport('payments-summary')} />
        </RoleGate>
      )}
      {tab === 'debts' && (
        <RoleGate roles={['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier']}>
          <DebtsTab period={period} customStart={customStart} customEnd={customEnd} onExport={() => handleExport('debts-summary')} />
        </RoleGate>
      )}
      {tab === 'cashout' && (
        <RoleGate roles={['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier']}>
          <CashoutTab period={period} customStart={customStart} customEnd={customEnd} />
        </RoleGate>
      )}
    </div>
  );
}

function OverviewTab({ period, customStart, customEnd }) {
  const { data, isLoading, error, refetch } = useExecutiveSummary(period, customStart, customEnd);
  if (isLoading) return <LoadingState label="Loading overview…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const s = data?.data;
  if (!s) return null;
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <StatCard label="Total Customers" value={s.totalCustomers} />
        <StatCard label="Active Cycles" value={s.activeCollectionCycles} />
        <StatCard label="Active Batches" value={s.activeBatches} />
        <StatCard label="Completion Rate" value={s.completionRate != null ? `${s.completionRate}%` : '—'} accent="var(--success)" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <StatCard label="Serviced" value={s.serviced} accent="var(--success)" />
        <StatCard label="Missed" value={s.missed} accent="var(--danger)" />
        <StatCard label="Skipped" value={s.skipped} accent="var(--warning)" />
        <StatCard label="Rescheduled" value={s.rescheduled} accent="var(--info)" />
        <StatCard label="Outstanding" value={s.pending} />
      </div>
      {s.revenue && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px' }}>
          <StatCard label="Revenue Collected" value={`$${s.revenue.collected.toFixed(2)}`} accent="var(--success)" />
          <StatCard label="Outstanding Balance" value={`$${s.revenue.outstanding.toFixed(2)}`} accent="var(--warning)" />
          <StatCard label="Debt" value={`$${s.revenue.debt.toFixed(2)}`} accent="var(--danger)" />
        </div>
      )}
    </div>
  );
}

function CollectorTab({ period, customStart, customEnd, onExport, isCollector }) {
  const { data, isLoading, error, refetch } = useCollectorPerformance(period, customStart, customEnd);
  if (isLoading) return <LoadingState label="Loading collector performance…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const rows = data?.data || [];
  return (
    <div>
      {!isCollector && <div className="no-print" style={{ marginBottom: '10px' }}><Button variant="secondary" icon={Download} onClick={onExport}>Export CSV</Button></div>}
      <DataTable
        isEmpty={rows.length === 0}
        emptyTitle="No collector activity in this period"
        columns={[{ label: 'Collector' }, { label: 'Zone' }, { label: 'Assigned' }, { label: 'Serviced' }, { label: 'Missed' }, { label: 'Skipped' }, { label: 'Rescheduled' }, { label: 'Completion %' }]}
      >
        {rows.map((r) => (
          <tr key={r.employee_id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{r.collector_name || `#${r.employee_id}`}</td>
            <td style={cellStyle}>{r.zone_name || '—'}</td>
            <td style={cellStyle} className="tabular-nums">{r.assigned}</td>
            <td style={cellStyle} className="tabular-nums">{r.serviced}</td>
            <td style={cellStyle} className="tabular-nums">{r.missed}</td>
            <td style={cellStyle} className="tabular-nums">{r.skipped}</td>
            <td style={cellStyle} className="tabular-nums">{r.rescheduled}</td>
            <td style={cellStyle} className="tabular-nums">{r.completionRate != null ? `${r.completionRate}%` : '—'}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

function ZoneTab({ period, customStart, customEnd, onExport }) {
  const { data, isLoading, error, refetch } = useZonePerformance(period, customStart, customEnd);
  if (isLoading) return <LoadingState label="Loading zone performance…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const rows = data?.data || [];
  return (
    <div>
      <div className="no-print" style={{ marginBottom: '10px' }}><Button variant="secondary" icon={Download} onClick={onExport}>Export CSV</Button></div>
      <DataTable
        isEmpty={rows.length === 0}
        emptyTitle="No zone activity in this period"
        columns={[{ label: 'Zone' }, { label: 'Batches' }, { label: 'Assigned' }, { label: 'Serviced' }, { label: 'Missed' }, { label: 'Skipped' }, { label: 'Rescheduled' }, { label: 'Completion %' }, { label: 'Revenue' }]}
      >
        {rows.map((r) => (
          <tr key={r.zone_id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}><strong>{r.zone_name}</strong></td>
            <td style={cellStyle} className="tabular-nums">{r.batches}</td>
            <td style={cellStyle} className="tabular-nums">{r.assigned_customers}</td>
            <td style={cellStyle} className="tabular-nums">{r.serviced}</td>
            <td style={cellStyle} className="tabular-nums">{r.missed}</td>
            <td style={cellStyle} className="tabular-nums">{r.skipped}</td>
            <td style={cellStyle} className="tabular-nums">{r.rescheduled}</td>
            <td style={cellStyle} className="tabular-nums">{r.completionRate != null ? `${r.completionRate}%` : '—'}</td>
            <td style={cellStyle} className="tabular-nums">{r.revenue ? `$${r.revenue.collected.toFixed(2)}` : '—'}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

function TruckTab({ period, customStart, customEnd }) {
  const { data, isLoading, error, refetch } = useTruckPerformance(period, customStart, customEnd);
  if (isLoading) return <LoadingState label="Loading truck performance…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const rows = data?.data || [];
  return (
    <DataTable
      isEmpty={rows.length === 0}
      emptyTitle="No truck activity in this period"
      columns={[{ label: 'Truck' }, { label: 'Zone' }, { label: 'Assigned Workload' }, { label: 'Serviced Workload' }, { label: 'Utilization' }]}
    >
      {rows.map((r) => (
        <tr key={r.truck_id} style={{ borderBottom: '1px solid var(--border)' }}>
          <td style={cellStyle}>{r.plate_number || `#${r.truck_id}`}</td>
          <td style={cellStyle}>{r.zone_name || '—'}</td>
          <td style={cellStyle} className="tabular-nums">{r.assigned_workload}</td>
          <td style={cellStyle} className="tabular-nums">{r.serviced_workload}</td>
          <td style={cellStyle} className="tabular-nums">{r.utilizationPercent != null ? `${r.utilizationPercent}%` : 'Capacity not set'}</td>
        </tr>
      ))}
    </DataTable>
  );
}

// User-reported gap ('customers kii loo shaqeeyay sidaan ku ogaan
// karaa... kuwii loo shaqeeyay iyo kuwii aan loshaqayn iyo kuwii laga
// tagay... si isla xisaabtanku u hagaago' — how do I know which
// customers were worked, which weren't, and which were left behind,
// so the accounting itself reconciles): this was the one report tab
// with no status breakdown, no status filter, and no Export CSV — a
// flat unfiltered list only. The backend's own GET /collection-history
// already accepted a ?status= filter; nothing in the UI ever exposed
// it, and the export endpoint didn't exist for this category at all.
function HistoryTab({ period, customStart, customEnd, onExport }) {
  const [statusFilter, setStatusFilter] = useState('');
  const { data, isLoading, error, refetch } = useCollectionHistory(period, customStart, customEnd, { status: statusFilter || undefined });
  if (isLoading) return <LoadingState label="Loading collection history…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const rows = data?.data || [];
  // Counts reflect the CURRENT filter — client-side tally of the same
  // already-fetched rows, never a second backend call (same precedent
  // as the Collector Mobile App's own daily-progress chips).
  const counts = { serviced: 0, missed: 0, skipped: 0, pending: 0, rescheduled: 0 };
  for (const r of rows) { if (counts[r.status] !== undefined) counts[r.status] += 1; }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px', marginBottom: '16px' }} className="no-print">
        <StatCard label="Serviced" value={counts.serviced} accent="var(--success)" />
        <StatCard label="Missed" value={counts.missed} accent="var(--danger)" />
        <StatCard label="Skipped" value={counts.skipped} accent="var(--info)" />
        <StatCard label="Pending" value={counts.pending} accent="var(--warning)" />
        <StatCard label="Rescheduled" value={counts.rescheduled} />
      </div>
      <div className="no-print" style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          <option value="serviced">Serviced</option>
          <option value="missed">Missed</option>
          <option value="skipped">Skipped</option>
          <option value="pending">Pending</option>
          <option value="rescheduled">Rescheduled</option>
        </select>
        <Button variant="secondary" icon={Download} onClick={() => onExport({ status: statusFilter || undefined })}>Export CSV</Button>
      </div>
      <DataTable
        isEmpty={rows.length === 0}
        emptyTitle="No collection events in this period"
        columns={[{ label: 'Customer' }, { label: 'Batch' }, { label: 'Zone' }, { label: 'Status' }, { label: 'Date' }]}
      >
        {rows.map((r) => (
          <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{r.customer_name} ({r.customer_number})</td>
            <td style={cellStyle}>{r.batch_code}</td>
            <td style={cellStyle}>{r.zone_name || '—'}</td>
            <td style={cellStyle}><StatusBadge status={r.status} /></td>
            <td style={cellStyle}>{r.status_at ? new Date(r.status_at).toLocaleString() : '—'}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

function RevenueTab({ period, customStart, customEnd }) {
  const { data, isLoading, error, refetch } = useRevenue(period, customStart, customEnd);
  if (isLoading) return <LoadingState label="Loading revenue…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const r = data?.data;
  if (!r) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px' }}>
      <StatCard label="Collected Revenue" value={`$${r.collected.toFixed(2)}`} accent="var(--success)" />
      <StatCard label="Payments" value={r.paymentCount} />
      <StatCard label="Outstanding" value={`$${r.outstanding.toFixed(2)}`} accent="var(--warning)" />
      <StatCard label="Debt" value={`$${r.debt.toFixed(2)}`} accent="var(--danger)" />
    </div>
  );
}

function InvoicesTab({ period, customStart, customEnd, onExport }) {
  const { data, isLoading, error, refetch } = useInvoicesSummary(period, customStart, customEnd);
  if (isLoading) return <LoadingState label="Loading invoices…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const rows = data?.data || [];
  return (
    <div>
      <div className="no-print" style={{ marginBottom: '10px' }}><Button variant="secondary" icon={Download} onClick={onExport}>Export CSV</Button></div>
      <DataTable isEmpty={rows.length === 0} emptyTitle="No invoices in this period" columns={[{ label: 'Invoice' }, { label: 'Customer' }, { label: 'Total' }, { label: 'Status' }, { label: 'Date' }]}>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{r.invoice_number}</td>
            <td style={cellStyle}>{r.customer_name}</td>
            <td style={cellStyle} className="tabular-nums">${parseFloat(r.invoice_total).toFixed(2)}</td>
            <td style={cellStyle}><StatusBadge status={r.status} map={{ unpaid: 'danger', partial: 'warning', paid: 'success', voided: 'info' }} /></td>
            <td style={cellStyle}>{new Date(r.created_at).toLocaleDateString()}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

function PaymentsTab({ period, customStart, customEnd, onExport }) {
  const { data, isLoading, error, refetch } = usePaymentsSummary(period, customStart, customEnd);
  if (isLoading) return <LoadingState label="Loading payments…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const rows = data?.data || [];
  return (
    <div>
      <div className="no-print" style={{ marginBottom: '10px' }}><Button variant="secondary" icon={Download} onClick={onExport}>Export CSV</Button></div>
      <DataTable isEmpty={rows.length === 0} emptyTitle="No payments in this period" columns={[{ label: 'Invoice' }, { label: 'Customer' }, { label: 'Amount' }, { label: 'Method' }, { label: 'USD Value' }, { label: 'Status' }, { label: 'Date' }]}>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{r.invoice_number}</td>
            <td style={cellStyle}>{r.customer_name}</td>
            <td style={cellStyle} className="tabular-nums">{r.currency} {parseFloat(r.amount).toFixed(2)}</td>
            <td style={{ ...cellStyle, textTransform: 'capitalize' }}>{r.method}</td>
            <td style={cellStyle} className="tabular-nums">${parseFloat(r.amount_usd).toFixed(2)}</td>
            <td style={cellStyle}><StatusBadge status={r.status} map={{ recorded: 'success', reversed: 'danger' }} /></td>
            <td style={cellStyle}>{new Date(r.created_at).toLocaleDateString()}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

function DebtsTab({ period, customStart, customEnd, onExport }) {
  const { data, isLoading, error, refetch } = useDebtsSummary(period, customStart, customEnd);
  if (isLoading) return <LoadingState label="Loading debts…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const rows = data?.data || [];
  return (
    <div>
      <div className="no-print" style={{ marginBottom: '10px' }}><Button variant="secondary" icon={Download} onClick={onExport}>Export CSV</Button></div>
      <DataTable isEmpty={rows.length === 0} emptyTitle="No debts in this period" columns={[{ label: 'Customer' }, { label: 'Amount' }, { label: 'Status' }, { label: 'Date' }]}>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{r.customer_name || '—'}</td>
            <td style={cellStyle} className="tabular-nums">${parseFloat(r.amount).toFixed(2)}</td>
            <td style={cellStyle}><StatusBadge status={r.status} map={{ unpaid: 'danger', paid: 'success' }} /></td>
            <td style={cellStyle}>{new Date(r.created_at).toLocaleDateString()}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

function CashoutTab({ period, customStart, customEnd }) {
  const { data, isLoading, error, refetch } = useCashoutSummary(period, customStart, customEnd);
  if (isLoading) return <LoadingState label="Loading cashout summary…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const { rows = [], totals = {} } = data?.data || {};
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <StatCard label="Expected" value={`$${(totals.expected || 0).toFixed(2)}`} />
        <StatCard label="Actual" value={`$${(totals.actual || 0).toFixed(2)}`} />
        <StatCard label="Shortage" value={`$${(totals.shortage || 0).toFixed(2)}`} accent="var(--danger)" />
        <StatCard label="Surplus" value={`$${(totals.surplus || 0).toFixed(2)}`} accent="var(--info)" />
      </div>
      <DataTable isEmpty={rows.length === 0} emptyTitle="No cashouts in this period" columns={[{ label: 'Cashout' }, { label: 'Zone' }, { label: 'Expected' }, { label: 'Actual' }, { label: 'Shortage' }, { label: 'Status' }]}>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{r.cashout_number}</td>
            <td style={cellStyle}>{r.zone_name}</td>
            <td style={cellStyle} className="tabular-nums">${parseFloat(r.expected_amount).toFixed(2)}</td>
            <td style={cellStyle} className="tabular-nums">${parseFloat(r.actual_amount).toFixed(2)}</td>
            <td style={cellStyle} className="tabular-nums">{parseFloat(r.shortage) > 0 ? `$${parseFloat(r.shortage).toFixed(2)}` : '—'}</td>
            <td style={cellStyle}><StatusBadge status={r.status} map={{ pending: 'warning', approved: 'success', rejected: 'danger', voided: 'info' }} /></td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
function tabButtonStyle(active) {
  return {
    padding: '8px 14px', borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
    fontWeight: 700, fontSize: '13px', background: active ? 'var(--brand)' : 'transparent',
    color: active ? '#fff' : 'var(--text-muted)',
  };
}
