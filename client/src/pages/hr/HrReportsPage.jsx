import React, { useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { PageHeader, Card, StatCard, DataTable, LoadingState, ErrorState } from '../../components/ui/index.js';
import { useHeadcountSummary, useAttendanceSummary, useLeaveSummary } from '../../hooks/useHrReports.js';

// Gap-audit sweep (Phase 10, continuation): GET /v2/hr-reports/headcount,
// /attendance-summary and /leave-summary were fully built and zone-scoped
// server-side (a gudoomiye/zone_accountant automatically gets their own
// zone's numbers, admin sees company-wide) but had no hook and no page —
// company-wide HR reporting was entirely unreachable from the UI. Mirrors
// the existing financial ReportsPage's tab structure (Module 8) rather
// than inventing a new pattern.
const TABS = [
  { key: 'headcount', label: 'Headcount' },
  { key: 'attendance', label: 'Attendance Summary' },
  { key: 'leave', label: 'Leave Summary' },
];

function defaultRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const toStr = (d) => d.toISOString().slice(0, 10);
  return { start: toStr(start), end: toStr(now) };
}

const HEADCOUNT_LABELS = { active: 'Active', inactive: 'Inactive', terminated: 'Terminated', on_leave: 'On Leave' };
const ATTENDANCE_LABELS = { present: 'Present', absent: 'Absent', late: 'Late', on_leave: 'On Leave', half_day: 'Half Day' };

export default function HrReportsPage() {
  const [tab, setTab] = useState('headcount');
  const { start, end } = defaultRange();
  const [periodStart, setPeriodStart] = useState(start);
  const [periodEnd, setPeriodEnd] = useState(end);

  return (
    <div>
      <PageHeader icon={BarChart3} title="HR Reports" subtitle="Company-wide headcount, attendance and leave reporting." />

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '20px', borderBottom: '1px solid var(--border)', paddingBottom: '10px' }}>
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} style={tabButtonStyle(tab === t.key)}>{t.label}</button>
        ))}
      </div>

      {tab !== 'headcount' && (
        <Card style={{ padding: '12px 16px', marginBottom: '20px', display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={labelStyle}>From <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} style={inputStyle} /></label>
          <label style={labelStyle}>To <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} style={inputStyle} /></label>
        </Card>
      )}

      {tab === 'headcount' && <HeadcountTab />}
      {tab === 'attendance' && <AttendanceSummaryTab periodStart={periodStart} periodEnd={periodEnd} />}
      {tab === 'leave' && <LeaveSummaryTab periodStart={periodStart} periodEnd={periodEnd} />}
    </div>
  );
}

function HeadcountTab() {
  const { data, isLoading, error, refetch } = useHeadcountSummary();
  if (isLoading) return <LoadingState label="Loading headcount…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const rows = data?.data || [];
  const total = rows.reduce((sum, r) => sum + parseInt(r.count, 10), 0);
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <StatCard label="Total Employees" value={total} />
        {rows.map((r) => (
          <StatCard key={r.status} label={HEADCOUNT_LABELS[r.status] || r.status} value={r.count} />
        ))}
      </div>
      <DataTable isEmpty={rows.length === 0} emptyTitle="No employees recorded" columns={[{ label: 'Status' }, { label: 'Count', align: 'right' }]}>
        {rows.map((r) => (
          <tr key={r.status} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{HEADCOUNT_LABELS[r.status] || r.status}</td>
            <td className="tabular-nums" style={{ ...cellStyle, textAlign: 'right' }}>{r.count}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

function AttendanceSummaryTab({ periodStart, periodEnd }) {
  const { data, isLoading, error, refetch } = useAttendanceSummary(periodStart, periodEnd);
  if (isLoading) return <LoadingState label="Loading attendance summary…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const rows = data?.data || [];
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '12px', marginBottom: '20px' }}>
        {rows.map((r) => (
          <StatCard key={r.status} label={ATTENDANCE_LABELS[r.status] || r.status} value={r.count} />
        ))}
      </div>
      <DataTable isEmpty={rows.length === 0} emptyTitle="No attendance records in this period" columns={[{ label: 'Status' }, { label: 'Count', align: 'right' }]}>
        {rows.map((r) => (
          <tr key={r.status} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{ATTENDANCE_LABELS[r.status] || r.status}</td>
            <td className="tabular-nums" style={{ ...cellStyle, textAlign: 'right' }}>{r.count}</td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

function LeaveSummaryTab({ periodStart, periodEnd }) {
  const { data, isLoading, error, refetch } = useLeaveSummary(periodStart, periodEnd);
  if (isLoading) return <LoadingState label="Loading leave summary…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const rows = data?.data || [];
  return (
    <DataTable
      isEmpty={rows.length === 0}
      emptyTitle="No leave requests overlapping this period"
      columns={[{ label: 'Leave Type' }, { label: 'Status' }, { label: 'Count', align: 'right' }]}
    >
      {rows.map((r, i) => (
        <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
          <td style={cellStyle}>{r.leave_type}</td>
          <td style={{ ...cellStyle, textTransform: 'capitalize' }}>{r.status}</td>
          <td className="tabular-nums" style={{ ...cellStyle, textAlign: 'right' }}>{r.count}</td>
        </tr>
      ))}
    </DataTable>
  );
}

const cellStyle = { padding: '12px 14px' };
const labelStyle = { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 700, color: 'var(--text-muted)' };
const inputStyle = {
  padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
function tabButtonStyle(active) {
  return {
    padding: '8px 14px', borderRadius: 'var(--radius-sm)', border: 'none', cursor: 'pointer',
    fontWeight: 700, fontSize: '13px', background: active ? 'var(--brand)' : 'transparent',
    color: active ? '#fff' : 'var(--text-muted)',
  };
}
