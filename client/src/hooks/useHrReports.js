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
