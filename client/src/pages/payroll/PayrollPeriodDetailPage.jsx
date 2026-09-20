import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Wallet, PlayCircle, CheckCircle2 } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, StatCard, LoadingState, ErrorState, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { usePayrollPeriod, useSetPayrollPeriodStatus, useGeneratePayroll, usePayrollRecords } from '../../hooks/usePayroll.js';
// User-requested gap-audit sweep ('sii wad qaybaha kale'): usePayrollSummary()
// already existed in useHrReports.js, fully wired to the backend (zone-
// scoped for gudoomiye/zone_accountant, company-wide for admin), but
// nothing here ever called it — this page listed every individual
// record with no company/zone-wide total anywhere.
// Same gap-audit sweep, continuation: GET /v2/hr-reports/payroll-by-zone
// (admin-only, always tied to one payroll period) had a hook nowhere and
// no caller — a company-wide period's zone-by-zone split was invisible.
import { usePayrollSummary, usePayrollByZone } from '../../hooks/useHrReports.js';

const PERIOD_STATUS_MAP = { open: 'info', processing: 'warning', finalized: 'success', paid: 'success' };
const RECORD_STATUS_MAP = { open: 'info', processing: 'warning', finalized: 'success', paid: 'success', reversed: 'danger' };

export default function PayrollPeriodDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = (user?.role || '').toLowerCase() === 'admin';
  const { data, isLoading, error, refetch } = usePayrollPeriod(id);
  const { data: recordsData, refetch: refetchRecords } = usePayrollRecords({ payroll_period_id: id });
  const { data: summaryData } = usePayrollSummary(id);
  const { data: byZoneData } = usePayrollByZone(isAdmin ? id : null);
  const setStatus = useSetPayrollPeriodStatus();
  const generate = useGeneratePayroll();
  const period = data?.data;
  const records = recordsData?.data || [];
  const summary = summaryData?.data;
  const byZone = byZoneData?.data || [];

  if (isLoading) return <LoadingState label="Loading payroll period…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!period) return null;

  async function handleProcess() {
    try {
      await setStatus.mutateAsync({ id: period.id, status: 'processing' });
      toast.success('Period is now processing.');
    } catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }
  async function handleGenerate() {
    try {
      const result = await generate.mutateAsync(period.id);
      toast.success(`Generated ${result.data.length} payroll record(s).`);
      if (result.needs_review?.length) toast.error(`${result.needs_review.length} employee(s) have no/zero salary — review before finalizing.`);
      refetchRecords();
    } catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }
  async function handleFinalize() {
    try {
      await setStatus.mutateAsync({ id: period.id, status: 'finalized' });
      toast.success('Period finalized. Records are now immutable.');
      refetchRecords();
    } catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }

  return (
    <div>
      <button onClick={() => navigate('/payroll/periods')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Payroll Periods
      </button>

      <PageHeader
        icon={Wallet}
        title={period.label}
        subtitle={`${new Date(period.start_date).toLocaleDateString()} – ${new Date(period.end_date).toLocaleDateString()} · `}
        actions={
          <RoleGate roles={['admin']}>
            <div style={{ display: 'flex', gap: '8px' }}>
              {period.status === 'open' && <Button icon={PlayCircle} onClick={handleProcess} disabled={setStatus.isPending}>Start Processing</Button>}
              {period.status === 'processing' && <Button variant="secondary" onClick={handleGenerate} disabled={generate.isPending}>{generate.isPending ? 'Generating…' : 'Generate Payroll'}</Button>}
              {period.status === 'processing' && <Button icon={CheckCircle2} onClick={handleFinalize} disabled={setStatus.isPending}>Finalize</Button>}
            </div>
          </RoleGate>
        }
      />

      <div style={{ marginBottom: '16px' }}><StatusBadge status={period.status} map={PERIOD_STATUS_MAP} /></div>

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px', marginBottom: '20px' }}>
          <StatCard label="Employees" value={summary.employee_count} />
          <StatCard label="Total Salary" value={`$${parseFloat(summary.total_salary).toFixed(2)}`} />
          <StatCard label="Total Earnings" value={`$${parseFloat(summary.total_earnings).toFixed(2)}`} accent="var(--success)" />
          <StatCard label="Total Deductions" value={`$${parseFloat(summary.total_deductions).toFixed(2)}`} accent="var(--danger)" />
          <StatCard label="Total Net" value={`$${parseFloat(summary.total_net).toFixed(2)}`} accent="var(--brand)" />
        </div>
      )}

      {isAdmin && byZone.length > 0 && (
        <div style={{ marginBottom: '20px' }}>
          <h3 style={{ margin: '0 0 10px', fontSize: '14px' }}>By Zone</h3>
          <DataTable columns={[{ label: 'Zone' }, { label: 'Employees', align: 'right' }, { label: 'Total Net', align: 'right' }]}>
            {byZone.map((z) => (
              <tr key={z.zone_snapshot_id ?? 'none'} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={cellStyle}>{z.zone_name || 'Unassigned'}</td>
                <td className="tabular-nums" style={{ ...cellStyle, textAlign: 'right' }}>{z.employee_count}</td>
                <td className="tabular-nums" style={{ ...cellStyle, textAlign: 'right' }}>${parseFloat(z.total_net).toFixed(2)}</td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}

      <DataTable
        isEmpty={records.length === 0}
        emptyTitle="No payroll records generated yet"
        columns={[{ label: 'Employee' }, { label: 'Salary' }, { label: 'Earnings' }, { label: 'Deductions' }, { label: 'Net' }, { label: 'Status' }]}
      >
        {records.map((r) => (
          <tr key={r.id} onClick={() => navigate(`/payroll/records/${r.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}>{r.employee_name}</td>
            <td style={cellStyle} className="tabular-nums">{parseFloat(r.salary_snapshot).toFixed(2)}</td>
            <td style={cellStyle} className="tabular-nums">{parseFloat(r.earnings_total).toFixed(2)}</td>
            <td style={cellStyle} className="tabular-nums">{parseFloat(r.deductions_total).toFixed(2)}</td>
            <td style={cellStyle} className="tabular-nums"><strong>{parseFloat(r.net_salary).toFixed(2)}</strong></td>
            <td style={cellStyle}><StatusBadge status={r.status} map={RECORD_STATUS_MAP} /></td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
