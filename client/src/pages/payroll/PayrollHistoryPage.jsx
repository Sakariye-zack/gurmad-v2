import React from 'react';
import { useNavigate } from 'react-router-dom';
import { History } from 'lucide-react';
import { PageHeader, DataTable, StatusBadge, LoadingState, ErrorState } from '../../components/ui/index.js';
import { useMyPayrollRecords } from '../../hooks/usePayroll.js';

const STATUS_MAP = { open: 'info', processing: 'warning', finalized: 'success', paid: 'success', reversed: 'danger' };

// Collector/employee-facing "My Payroll" view — own-record only, resolved
// server-side from employees.user_id. Reuses PayrollRecordDetailPage.jsx
// for the payslip detail (own-record mode).
export default function PayrollHistoryPage() {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useMyPayrollRecords();
  const records = data?.data || [];

  if (isLoading) return <LoadingState label="Loading payroll history…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;

  return (
    <div>
      <PageHeader icon={History} title="My Payroll" subtitle="Your own payroll history and payslips." />

      <DataTable
        isEmpty={records.length === 0}
        emptyTitle="No payroll records yet"
        columns={[{ label: 'Period' }, { label: 'Net Salary' }, { label: 'Status' }]}
      >
        {records.map((r) => (
          <tr key={r.id} onClick={() => navigate(`/payroll/records/${r.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}>{r.period_label}</td>
            <td style={cellStyle} className="tabular-nums"><strong>{parseFloat(r.net_salary).toFixed(2)}</strong></td>
            <td style={cellStyle}><StatusBadge status={r.status} map={STATUS_MAP} /></td>
          </tr>
        ))}
      </DataTable>
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
