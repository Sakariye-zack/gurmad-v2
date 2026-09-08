import React, { useState } from 'react';
import { CalendarCheck } from 'lucide-react';
import { PageHeader, DataTable, StatusBadge, FilterBar } from '../../components/ui/index.js';
import { useAttendance } from '../../hooks/useAttendance.js';

const STATUS_MAP = { present: 'success', absent: 'danger', late: 'warning', on_leave: 'info', half_day: 'warning' };

export default function AttendanceListPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const { data, isLoading, error, refetch } = useAttendance({ status: statusFilter || undefined });
  const records = data?.data || [];

  return (
    <div>
      <PageHeader icon={CalendarCheck} title="Attendance" subtitle="Daily attendance records. Informational only — never used to calculate payroll." />

      <FilterBar searchValue="" onSearchChange={() => {}} searchPlaceholder="">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          <option value="present">Present</option>
          <option value="absent">Absent</option>
          <option value="late">Late</option>
          <option value="on_leave">On Leave</option>
          <option value="half_day">Half Day</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && records.length === 0}
        emptyTitle="No attendance records"
        columns={[{ label: 'Employee' }, { label: 'Date' }, { label: 'Status' }, { label: 'Clock In' }, { label: 'Clock Out' }]}
      >
        {records.map((r) => (
          <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}>{r.employee_name}</td>
            <td style={cellStyle}>{new Date(r.attendance_date).toLocaleDateString()}</td>
            <td style={cellStyle}><StatusBadge status={r.status} map={STATUS_MAP} /></td>
            <td style={cellStyle}>{r.clock_in ? new Date(r.clock_in).toLocaleTimeString() : '—'}</td>
            <td style={cellStyle}>{r.clock_out ? new Date(r.clock_out).toLocaleTimeString() : '—'}</td>
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
