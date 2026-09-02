import React from 'react';
import { useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, ClipboardList, Wallet, Plus, TrendingUp, Wallet2 } from 'lucide-react';
import { PageHeader, StatCard, Button, DataTable, LoadingState, ErrorState } from '../components/ui/index.js';
import RoleGate from '../components/RoleGate.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { useCurrentZone } from '../hooks/useCurrentZone.js';
import { useDashboardSummary } from '../hooks/useDashboard.js';

// Module 9 — Dashboard. Composition + presentation ONLY: every figure
// here comes from the already-computed /v2/dashboard/summary response,
// which itself only ever calls Module 8's own frozen calculation
// functions — this page never recalculates a total client-side.
export default function Dashboard() {
  const { user } = useAuth();
  const { zone, isZoneScoped } = useCurrentZone();
  const role = (user?.role || '').toLowerCase();
  const { data, isLoading, error, refetch } = useDashboardSummary('today');
  const navigate = useNavigate();

  return (
    <div>
      <PageHeader
        icon={LayoutDashboard}
        title="Dashboard"
        subtitle={isZoneScoped ? `Zone-scoped view — ${zone}` : 'All-zone view'}
        actions={
          <RoleGate roles={['admin']}>
            <Button icon={Plus} onClick={() => navigate('/zones')}>Manage Zones</Button>
          </RoleGate>
        }
      />

      {isLoading && <LoadingState label="Loading dashboard…" />}
      {error && <ErrorState message={error.message} onRetry={refetch} />}
      {data?.data && <DashboardContent summary={data.data} role={role} />}
    </div>
  );
}

function DashboardContent({ summary, role }) {
  if (role === 'collector') return <CollectorDashboard summary={summary} />;
  if (role === 'head_of_cashiers' || role === 'cashier') return <FinancialOnlyDashboard summary={summary} />;
  return <FullDashboard summary={summary} />;
}

function CollectorDashboard({ summary }) {
  const rows = summary.collectorPerformance || [];
  const mine = rows[0];
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Assigned Today" value={mine?.assigned ?? 0} icon={ClipboardList} />
        <StatCard label="Serviced" value={mine?.serviced ?? 0} accent="var(--success)" />
        <StatCard label="Missed" value={mine?.missed ?? 0} accent="var(--danger)" />
        <StatCard label="Completion Rate" value={mine?.completionRate != null ? `${mine.completionRate}%` : '—'} accent="var(--info)" />
      </div>
      <div style={{ padding: '16px', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)', color: 'var(--text-muted)', fontSize: '13px' }}>
        Your own collection performance for today. See <strong>Reports → Collector</strong> for other periods.
      </div>
    </div>
  );
}

function FinancialOnlyDashboard({ summary }) {
  const r = summary.revenue || {};
  const c = summary.cashout?.totals || {};
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Revenue Collected" value={`$${(r.collected || 0).toFixed(2)}`} icon={Wallet} accent="var(--success)" />
        <StatCard label="Payments" value={r.paymentCount || 0} />
        <StatCard label="Outstanding" value={`$${(r.outstanding || 0).toFixed(2)}`} accent="var(--warning)" />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px' }}>
        <StatCard label="Cashout Expected" value={`$${(c.expected || 0).toFixed(2)}`} icon={Wallet2} />
        <StatCard label="Cashout Actual" value={`$${(c.actual || 0).toFixed(2)}`} />
        <StatCard label="Shortage" value={`$${(c.shortage || 0).toFixed(2)}`} accent="var(--danger)" />
      </div>
    </div>
  );
}

function FullDashboard({ summary }) {
  const e = summary.executive || {};
  const rev = e.revenue || {};
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <StatCard label="Active Batches" value={e.activeBatches ?? '—'} icon={ClipboardList} />
        <StatCard label="Customers" value={e.totalCustomers ?? '—'} icon={Users} accent="var(--info)" />
        <StatCard label="Completion Rate" value={e.completionRate != null ? `${e.completionRate}%` : '—'} accent="var(--success)" />
        <StatCard label="Revenue Today" value={`$${(rev.collected || 0).toFixed(2)}`} icon={Wallet} accent="var(--success)" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Serviced" value={e.serviced ?? 0} accent="var(--success)" />
        <StatCard label="Missed" value={e.missed ?? 0} accent="var(--danger)" />
        <StatCard label="Skipped" value={e.skipped ?? 0} accent="var(--warning)" />
        <StatCard label="Rescheduled" value={e.rescheduled ?? 0} accent="var(--info)" />
        <StatCard label="Outstanding Balance" value={`$${(rev.outstanding || 0).toFixed(2)}`} accent="var(--warning)" />
      </div>

      <span style={sectionLabelStyle}>Zone Performance</span>
      <div style={{ marginBottom: '24px' }}>
        <DataTable
          isEmpty={(summary.zonePerformance || []).length === 0}
          emptyTitle="No zone activity today"
          columns={[{ label: 'Zone' }, { label: 'Batches' }, { label: 'Serviced' }, { label: 'Completion %' }, { label: 'Revenue' }]}
        >
          {(summary.zonePerformance || []).map((z) => (
            <tr key={z.zone_id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={cellStyle}><strong>{z.zone_name}</strong></td>
              <td style={cellStyle} className="tabular-nums">{z.batches}</td>
              <td style={cellStyle} className="tabular-nums">{z.serviced}</td>
              <td style={cellStyle} className="tabular-nums">{z.completionRate != null ? `${z.completionRate}%` : '—'}</td>
              <td style={cellStyle} className="tabular-nums">${(z.revenue?.collected || 0).toFixed(2)}</td>
            </tr>
          ))}
        </DataTable>
      </div>

      <span style={sectionLabelStyle}>Top Collectors Today</span>
      <div style={{ marginBottom: '24px' }}>
        <DataTable
          isEmpty={(summary.collectorPerformance || []).length === 0}
          emptyTitle="No collector activity today"
          columns={[{ label: 'Collector' }, { label: 'Zone' }, { label: 'Serviced' }, { label: 'Completion %' }]}
        >
          {(summary.collectorPerformance || []).map((c) => (
            <tr key={c.employee_id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={cellStyle}>{c.collector_name || `#${c.employee_id}`}</td>
              <td style={cellStyle}>{c.zone_name || '—'}</td>
              <td style={cellStyle} className="tabular-nums">{c.serviced}</td>
              <td style={cellStyle} className="tabular-nums">{c.completionRate != null ? `${c.completionRate}%` : '—'}</td>
            </tr>
          ))}
        </DataTable>
      </div>

      <span style={sectionLabelStyle}>Cashout Snapshot</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px' }}>
        <StatCard label="Expected" value={`$${(summary.cashout?.totals?.expected || 0).toFixed(2)}`} icon={Wallet2} />
        <StatCard label="Actual" value={`$${(summary.cashout?.totals?.actual || 0).toFixed(2)}`} />
        <StatCard label="Shortage" value={`$${(summary.cashout?.totals?.shortage || 0).toFixed(2)}`} accent="var(--danger)" />
        <StatCard label="Debt" value={`$${(rev.debt || 0).toFixed(2)}`} accent="var(--danger)" icon={TrendingUp} />
      </div>
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const sectionLabelStyle = {
  display: 'block', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--text-muted)', margin: '0 0 10px',
};
