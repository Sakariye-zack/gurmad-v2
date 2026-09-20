import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Phase 1 HR & Payroll reporting. Server-side aggregation only — every
// number shown comes straight from the backend.

export function usePayrollHistory(employeeId, params = {}) {
  const qs = new URLSearchParams();
  qs.set('employee_id', employeeId);
  if (params.limit) qs.set('limit', params.limit);
  if (params.offset) qs.set('offset', params.offset);
  return useQuery({
    queryKey: ['v2', 'hr-reports', 'payroll-history', employeeId, params],
    queryFn: () => apiClient.get(`/v2/hr-reports/payroll-history?${qs.toString()}`),
    enabled: !!employeeId,
  });
}
export function usePayrollSummary(payrollPeriodId) {
  return useQuery({
    queryKey: ['v2', 'hr-reports', 'payroll-summary', payrollPeriodId],
    queryFn: () => apiClient.get(`/v2/hr-reports/payroll-summary?payroll_period_id=${payrollPeriodId}`),
    enabled: !!payrollPeriodId,
  });
}

// Gap-audit sweep (Phase 10, continuation): these three endpoints
// (GET /v2/hr-reports/headcount, /attendance-summary, /leave-summary)
// were fully built and zone-scoped server-side but had no hook and no
// page anywhere — company-wide HR reporting was entirely unreachable
// from the UI. Wired into the new HrReportsPage.
export function useHeadcountSummary() {
  return useQuery({
    queryKey: ['v2', 'hr-reports', 'headcount'],
    queryFn: () => apiClient.get('/v2/hr-reports/headcount'),
  });
}
export function useAttendanceSummary(periodStart, periodEnd) {
  return useQuery({
    queryKey: ['v2', 'hr-reports', 'attendance-summary', periodStart, periodEnd],
    queryFn: () => apiClient.get(`/v2/hr-reports/attendance-summary?period_start=${periodStart}&period_end=${periodEnd}`),
    enabled: !!periodStart && !!periodEnd,
  });
}
export function useLeaveSummary(periodStart, periodEnd) {
  return useQuery({
    queryKey: ['v2', 'hr-reports', 'leave-summary', periodStart, periodEnd],
    queryFn: () => apiClient.get(`/v2/hr-reports/leave-summary?period_start=${periodStart}&period_end=${periodEnd}`),
    enabled: !!periodStart && !!periodEnd,
  });
}

// GET /v2/hr-reports/payroll-by-zone — admin-only, always tied to a
// specific payroll period, so it's wired into PayrollPeriodDetailPage.jsx
// (where a period is already selected) rather than this general page.
export function usePayrollByZone(payrollPeriodId) {
  return useQuery({
    queryKey: ['v2', 'hr-reports', 'payroll-by-zone', payrollPeriodId],
    queryFn: () => apiClient.get(`/v2/hr-reports/payroll-by-zone?payroll_period_id=${payrollPeriodId}`),
    enabled: !!payrollPeriodId,
  });
}
