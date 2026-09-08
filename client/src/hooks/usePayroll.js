import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Phase 1 HR & Payroll. Net salary, totals, and every figure shown come
// straight from the backend — never recalculated client-side.

export function usePayrollPeriods(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'payroll-periods', params], queryFn: () => apiClient.get(`/v2/payroll-periods${query ? `?${query}` : ''}`) });
}
export function usePayrollPeriod(id) {
  return useQuery({ queryKey: ['v2', 'payroll-periods', id], queryFn: () => apiClient.get(`/v2/payroll-periods/${id}`), enabled: !!id });
}
export function useCreatePayrollPeriod() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/payroll-periods', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'payroll-periods'] }) });
}
export function useSetPayrollPeriodStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }) => apiClient.put(`/v2/payroll-periods/${id}/status`, { status }),
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'payroll-periods'] }); qc.invalidateQueries({ queryKey: ['v2', 'payroll-records'] }); },
  });
}
export function useGeneratePayroll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (periodId) => apiClient.post(`/v2/payroll-periods/${periodId}/generate`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'payroll-records'] }),
  });
}

export function usePayrollRecords(params = {}) {
  const qs = new URLSearchParams();
  if (params.payroll_period_id) qs.set('payroll_period_id', params.payroll_period_id);
  if (params.employee_id) qs.set('employee_id', params.employee_id);
  if (params.status) qs.set('status', params.status);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'payroll-records', params], queryFn: () => apiClient.get(`/v2/payroll-records${query ? `?${query}` : ''}`) });
}
export function usePayrollRecord(id) {
  return useQuery({ queryKey: ['v2', 'payroll-records', id], queryFn: () => apiClient.get(`/v2/payroll-records/${id}`), enabled: !!id });
}
export function useMyPayrollRecords() {
  return useQuery({ queryKey: ['v2', 'payroll-records', 'me'], queryFn: () => apiClient.get('/v2/payroll-records/me') });
}
export function useAddPayrollItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => apiClient.post(`/v2/payroll-records/${id}/items`, data),
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'payroll-records', vars.id] }); qc.invalidateQueries({ queryKey: ['v2', 'payroll-records'] }); },
  });
}
export function useDeletePayrollItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, itemId }) => apiClient.del(`/v2/payroll-records/${id}/items/${itemId}`),
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'payroll-records', vars.id] }); },
  });
}
export function useSettlePayrollRecord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => apiClient.post(`/v2/payroll-records/${id}/settle`, data),
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'payroll-records', vars.id] }); qc.invalidateQueries({ queryKey: ['v2', 'payroll-records'] }); },
  });
}
export function useReversePayrollRecord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }) => apiClient.post(`/v2/payroll-records/${id}/reverse`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'payroll-records'] }),
  });
}
