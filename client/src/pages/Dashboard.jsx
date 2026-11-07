import React from 'react';
import { useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, ClipboardList, Wallet, Plus, TrendingUp, Wallet2, RefreshCw, Clock, Receipt, ListChecks, MapPin, Truck, HardDrive, AlertTriangle } from 'lucide-react';
import { PageHeader, StatCard, Button, DataTable, LoadingState, ErrorState } from '../components/ui/index.js';
import RoleGate from '../components/RoleGate.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { useCurrentZone } from '../hooks/useCurrentZone.js';
import { useDashboardSummary, useOperationsToday } from '../hooks/useDashboard.js';
import { useI18n } from '../i18n/I18nContext.jsx';

// Module 9 — Dashboard. Composition + presentation ONLY: every figure
// here comes from the already-computed /v2/dashboard/summary response,
// which itself only ever calls Module 8's own frozen calculation
// functions — this page never recalculates a total client-side.
export default function Dashboard() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { zone, isZoneScoped } = useCurrentZone();
  const role = (user?.role || '').toLowerCase();
  const { data, isLoading, error, refetch } = useDashboardSummary('today');
  const navigate = useNavigate();

  return (
    <div>
      <PageHeader
        icon={LayoutDashboard}
        title={t('portal.nav.dashboard')}
        subtitle={isZoneScoped ? t('dash.m.zoneScoped', undefined, { zone }) : t('dash.all_zone_view')}
        actions={
          <RoleGate roles={['admin']}>
            <Button icon={Plus} onClick={() => navigate('/zones')}>{t('dash.manage_zones')}</Button>
          </RoleGate>
        }
      />

      {(role === 'admin' || role === 'gudoomiye') && <OperationsToday navigate={navigate} />}

      {isLoading && <LoadingState label={t('dash.loading_dashboard')} />}
      {error && <ErrorState message={error.message} onRetry={refetch} />}
      {data?.data && <DashboardContent summary={data.data} role={role} navigate={navigate} />}
    </div>
  );
}

// F7 — "Today" operations panel (admin company-wide, gudoomiye own
// district). Every figure comes from GET /v2/dashboard/operations-today;
// each card links to the page that owns it. The debt-suspension card only
// shows when the server reports a number (null = feature not installed),
// and the backup card only for admin (server sends null otherwise).
function OperationsToday({ navigate }) {
  const { t } = useI18n();
  const { data, error } = useOperationsToday();
  if (error) {
    return <div style={{ marginBottom: '20px', fontSize: '13px', color: 'var(--text-muted)' }}>{t('ops.loadFailed')}</div>;
  }
  const d = data?.data;
  if (!d) return null;
  const l = d.lists || {};
  const fa = d.fleet_alerts || {};
  const backupSub = d.backup && !d.backup.ok ? (d.backup.failed ? t('ops.backupFailed') : t('ops.backupOverdue')) : undefined;
  return (
    <div style={{ marginBottom: '24px' }}>
      <span style={sectionLabelStyle}>{t('ops.today')} · {d.date}</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px' }}>
        <StatCard label={t('ops.lists')} value={l.lists ?? 0} icon={ListChecks} onClick={() => navigate('/operations/today')} />
        <StatCard
          label={t('ops.progress')} value={`${l.serviced ?? 0} / ${l.total ?? 0}`}
          sub={t('ops.progressSub', undefined, { pending: l.pending ?? 0 })} accent="var(--success)"
          onClick={() => navigate('/operations/today')}
        />
        <StatCard label={t('ops.missed')} value={l.missed ?? 0} accent="var(--danger)" onClick={() => navigate('/operations/today')} />
        <StatCard label={t('ops.collectorsActive')} value={d.collectors_active ?? 0} sub={t('ops.collectorsActiveSub')} icon={MapPin} accent="var(--info)" onClick={() => navigate('/map')} />
        <StatCard label={t('ops.trucksLive')} value={d.trucks_live ?? 0} icon={Truck} accent="var(--info)" onClick={() => navigate('/map')} />
        {d.debt_candidates !== null && d.debt_candidates !== undefined && (
          <StatCard label={t('ops.debtCandidates')} value={d.debt_candidates} accent="var(--warning)" onClick={() => navigate('/admin/debt-suspensions')} />
        )}
        {d.backup && (
          <StatCard
            label={t('ops.backup')} value={d.backup.ok ? t('ops.backupOk') : t('ops.backupProblem')} sub={backupSub}
            icon={HardDrive} accent={d.backup.ok ? 'var(--success)' : 'var(--danger)'} onClick={() => navigate('/backups')}
          />
        )}
        <StatCard
          label={t('ops.fleetAlerts')} value={fa.total ?? 0}
          sub={t('ops.fleetAlertsSub', undefined, { docs: fa.documents ?? 0, due: fa.maintenance_due ?? 0 })}
          icon={AlertTriangle} accent={(fa.total ?? 0) > 0 ? 'var(--warning)' : 'var(--success)'} onClick={() => navigate('/fleet')}
        />
      </div>
    </div>
  );
}

function DashboardContent({ summary, role, navigate }) {
  if (role === 'collector') return <CollectorDashboard summary={summary} />;
  if (role === 'head_of_cashiers' || role === 'cashier') return <FinancialOnlyDashboard summary={summary} navigate={navigate} />;
  return <FullDashboard summary={summary} navigate={navigate} />;
}

function CollectorDashboard({ summary }) {
  const { t } = useI18n();
  const rows = summary.collectorPerformance || [];
  const mine = rows[0];
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label={t('dash.assigned_today')} value={mine?.assigned ?? 0} icon={ClipboardList} />
        <StatCard label={t('status.serviced')} value={mine?.serviced ?? 0} accent="var(--success)" />
        <StatCard label={t('status.missed')} value={mine?.missed ?? 0} accent="var(--danger)" />
        {/* Skipped/Rescheduled — user-reported gap-audit ('dashboardka
            maxaa iga dhiman features'): getCollectorPerformance() already
            computes both (same function Reports -> Collector tab uses),
            but this personal view only ever showed Assigned/Serviced/
            Missed/Completion — a collector had no way to see their own
            skipped/rescheduled counts without leaving the Dashboard. */}
        <StatCard label={t('status.skipped')} value={mine?.skipped ?? 0} accent="var(--warning)" />
        <StatCard label={t('status.rescheduled')} value={mine?.rescheduled ?? 0} accent="var(--info)" />
        <StatCard label={t('dash.completion_rate')} value={mine?.completionRate != null ? `${mine.completionRate}%` : '—'} accent="var(--info)" />
      </div>
      <div style={{ padding: '16px', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)', color: 'var(--text-muted)', fontSize: '13px' }}>
        {t('dash.m.ownPerformance')} <strong>{t('dash.reports_collector')}</strong> {t('dash.m.forOtherPeriods')}
      </div>
    </div>
  );
}

function FinancialOnlyDashboard({ summary, navigate }) {
  const { t } = useI18n();
  const r = summary.revenue || {};
  const c = summary.cashout?.totals || {};
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label={t('dash.revenue_collected')} value={`$${(r.collected || 0).toFixed(2)}`} icon={Wallet} accent="var(--success)" onClick={() => navigate('/reports?tab=revenue')} />
        <StatCard label={t('portal.nav.payments')} value={r.paymentCount || 0} icon={Receipt} onClick={() => navigate('/reports?tab=payments')} />
        <StatCard label={t('portal.invoice.outstanding')} value={`$${(r.outstanding || 0).toFixed(2)}`} accent="var(--warning)" onClick={() => navigate('/financial/invoices?status=unpaid')} />
        {/* Debt — user-reported gap-audit ('dashboardka maxaa iga dhiman
            features'): getRevenueForPeriod() already returns r.debt (the
            same field the Admin FullDashboard's own Cashout Snapshot
            shows), but this cashier/head-of-cashiers view never did. */}
        <StatCard label={t('dash.debt')} value={`$${(r.debt || 0).toFixed(2)}`} accent="var(--danger)" icon={TrendingUp} onClick={() => navigate('/financial/debts')} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px' }}>
        <StatCard label={t('dash.cashout_expected')} value={`$${(c.expected || 0).toFixed(2)}`} icon={Wallet2} onClick={() => navigate('/financial/cashouts')} />
        <StatCard label={t('dash.cashout_actual')} value={`$${(c.actual || 0).toFixed(2)}`} onClick={() => navigate('/financial/cashouts')} />
        <StatCard label={t('dash.shortage')} value={`$${(c.shortage || 0).toFixed(2)}`} accent="var(--danger)" onClick={() => navigate('/reports?tab=cashout')} />
        {/* Surplus — same gap: getCashoutSummary() already computes
            c.totals.surplus (Reports -> Cashout tab shows it), this view
            only ever showed Shortage. */}
        <StatCard label={t('dash.surplus')} value={`$${(c.surplus || 0).toFixed(2)}`} accent="var(--info)" onClick={() => navigate('/reports?tab=cashout')} />
      </div>
    </div>
  );
}

function FullDashboard({ summary, navigate }) {
  const { t } = useI18n();
  const e = summary.executive || {};
  const rev = e.revenue || {};
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <StatCard label={t('dash.active_batches')} value={e.activeBatches ?? '—'} icon={ClipboardList} onClick={() => navigate('/collection-cycles/batches')} />
        <StatCard label={t('nav.customers')} value={e.totalCustomers ?? '—'} icon={Users} accent="var(--info)" onClick={() => navigate('/customers')} />
        {/* Active Collection Cycles / Payments — user-reported gap-audit
            ('dashboardka maxaa iga dhiman features'): getExecutiveSummary()
            already returns activeCollectionCycles (Reports -> Overview
            shows it) and getRevenueForPeriod() already returns
            paymentCount (the Financial-only dashboard above already
            shows it) — this view never surfaced either. */}
        <StatCard label={t('dash.active_cycles')} value={e.activeCollectionCycles ?? '—'} icon={RefreshCw} onClick={() => navigate('/collection-cycles')} />
        <StatCard label={t('portal.nav.payments')} value={rev.paymentCount ?? 0} icon={Receipt} onClick={() => navigate('/reports?tab=payments')} />
        <StatCard label={t('dash.completion_rate')} value={e.completionRate != null ? `${e.completionRate}%` : '—'} accent="var(--success)" onClick={() => navigate('/reports?tab=overview')} />
        <StatCard label={t('dash.revenue_today')} value={`$${(rev.collected || 0).toFixed(2)}`} icon={Wallet} accent="var(--success)" onClick={() => navigate('/reports?tab=revenue')} />
      </div>

      {/* Every card below — user-requested ('dashboardka adminka mid
          kasta hadan ku dhufto waa in details ku ii soo baxaan'): each
          stat now navigates to the Reports page/tab that shows its full
          detail, most landing on the History tab pre-filtered to that
          exact status via the ?status= deep link added to ReportsPage.jsx. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label={t('status.serviced')} value={e.serviced ?? 0} accent="var(--success)" onClick={() => navigate('/reports?tab=history&status=serviced')} />
        <StatCard label={t('status.missed')} value={e.missed ?? 0} accent="var(--danger)" onClick={() => navigate('/reports?tab=history&status=missed')} />
        <StatCard label={t('status.skipped')} value={e.skipped ?? 0} accent="var(--warning)" onClick={() => navigate('/reports?tab=history&status=skipped')} />
        <StatCard label={t('status.rescheduled')} value={e.rescheduled ?? 0} accent="var(--info)" onClick={() => navigate('/reports?tab=history&status=rescheduled')} />
        {/* Pending — same gap: getExecutiveSummary() already returns
            e.pending (collection events not yet resolved today), a
            different, equally useful metric from the $ Outstanding
            Balance already shown next to it. */}
        <StatCard label={t('status.pending')} value={e.pending ?? 0} icon={Clock} onClick={() => navigate('/reports?tab=history&status=pending')} />
        <StatCard label={t('dash.outstanding_balance')} value={`$${(rev.outstanding || 0).toFixed(2)}`} accent="var(--warning)" onClick={() => navigate('/financial/invoices?status=unpaid')} />
      </div>

      <span style={sectionLabelStyle}>{t('dash.zone_performance')}</span>
      <div style={{ marginBottom: '24px' }}>
        <DataTable
          isEmpty={(summary.zonePerformance || []).length === 0}
          emptyTitle={t('dash.no_zone_activity_today')}
          columns={[
            { label: t('common.zone') }, { label: t('nav.batches') }, { label: t('status.serviced') },
            // Missed/Skipped/Rescheduled — same gap: getZonePerformance()
            // already computes all three per zone (Reports -> Zone tab
            // shows them), this table only ever showed Serviced.
            { label: t('status.missed') }, { label: t('status.skipped') }, { label: t('status.rescheduled') },
            { label: t('dash.completion') }, { label: t('dash.revenue') },
          ]}
        >
          {(summary.zonePerformance || []).map((z) => (
            <tr key={z.zone_id} onClick={() => navigate(`/zones/${z.zone_id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
              <td style={cellStyle}><strong>{z.zone_name}</strong></td>
              <td style={cellStyle} className="tabular-nums">{z.batches}</td>
              <td style={cellStyle} className="tabular-nums">{z.serviced}</td>
              <td style={cellStyle} className="tabular-nums">{z.missed}</td>
              <td style={cellStyle} className="tabular-nums">{z.skipped}</td>
              <td style={cellStyle} className="tabular-nums">{z.rescheduled}</td>
              <td style={cellStyle} className="tabular-nums">{z.completionRate != null ? `${z.completionRate}%` : '—'}</td>
              <td style={cellStyle} className="tabular-nums">${(z.revenue?.collected || 0).toFixed(2)}</td>
            </tr>
          ))}
        </DataTable>
      </div>

      <span style={sectionLabelStyle}>{t('dash.top_collectors_today')}</span>
      <div style={{ marginBottom: '24px' }}>
        <DataTable
          isEmpty={(summary.collectorPerformance || []).length === 0}
          emptyTitle={t('dash.no_collector_activity_today')}
          columns={[{ label: t('collector.role') }, { label: t('common.zone') }, { label: t('status.serviced') }, { label: t('dash.completion') }]}
        >
          {(summary.collectorPerformance || []).map((c) => (
            <tr key={c.employee_id} onClick={() => navigate(`/employees/${c.employee_id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
              <td style={cellStyle}>{c.collector_name || `#${c.employee_id}`}</td>
              <td style={cellStyle}>{c.zone_name || '—'}</td>
              <td style={cellStyle} className="tabular-nums">{c.serviced}</td>
              <td style={cellStyle} className="tabular-nums">{c.completionRate != null ? `${c.completionRate}%` : '—'}</td>
            </tr>
          ))}
        </DataTable>
      </div>

      <span style={sectionLabelStyle}>{t('dash.cashout_snapshot')}</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px' }}>
        <StatCard label={t('dash.expected')} value={`$${(summary.cashout?.totals?.expected || 0).toFixed(2)}`} icon={Wallet2} onClick={() => navigate('/financial/cashouts')} />
        <StatCard label={t('dash.actual')} value={`$${(summary.cashout?.totals?.actual || 0).toFixed(2)}`} onClick={() => navigate('/financial/cashouts')} />
        <StatCard label={t('dash.shortage')} value={`$${(summary.cashout?.totals?.shortage || 0).toFixed(2)}`} accent="var(--danger)" onClick={() => navigate('/reports?tab=cashout')} />
        {/* Surplus — same gap: getCashoutSummary() already computes
            totals.surplus (Reports -> Cashout tab shows it alongside
            Shortage), this snapshot only ever showed Shortage. */}
        <StatCard label={t('dash.surplus')} value={`$${(summary.cashout?.totals?.surplus || 0).toFixed(2)}`} accent="var(--info)" onClick={() => navigate('/reports?tab=cashout')} />
        <StatCard label={t('dash.debt')} value={`$${(rev.debt || 0).toFixed(2)}`} accent="var(--danger)" icon={TrendingUp} onClick={() => navigate('/financial/debts')} />
      </div>
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const sectionLabelStyle = {
  display: 'block', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--text-muted)', margin: '0 0 10px',
};
