import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Phase 1 HR & Payroll.

export function useLeaveTypes() {
  return useQuery({ queryKey: ['v2', 'leave-types'], queryFn: () => apiClient.get('/v2/leave-types') });
}
export function useCreateLeaveType() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/leave-types', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'leave-types'] }) });
}
export function useSetLeaveTypeStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }) => apiClient.put(`/v2/leave-types/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'leave-types'] }),
  });
}

export function useLeaveRequests(params = {}) {
  const qs = new URLSearchParams();
  if (params.employee_id) qs.set('employee_id', params.employee_id);
  if (params.leave_type_id) qs.set('leave_type_id', params.leave_type_id);
  if (params.status) qs.set('status', params.status);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'leave-requests', params], queryFn: () => apiClient.get(`/v2/leave-requests${query ? `?${query}` : ''}`) });
}
export function useMyLeaveRequests() {
  return useQuery({ queryKey: ['v2', 'leave-requests', 'me'], queryFn: () => apiClient.get('/v2/leave-requests/me') });
}
export function useCreateLeaveRequest() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/leave-requests', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'leave-requests'] }) });
}
export function useFileMyLeaveRequest() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/leave-requests/me', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'leave-requests'] }) });
}
export function useSetLeaveRequestStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }) => apiClient.put(`/v2/leave-requests/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'leave-requests'] }),
  });
}
export function useCancelLeaveRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }) => apiClient.put(`/v2/leave-requests/${id}/cancel`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'leave-requests'] }),
  });
}
export function useEmployeeEffectiveStatus(employeeId) {
  return useQuery({
    queryKey: ['v2', 'employees', employeeId, 'effective-status'],
    queryFn: () => apiClient.get(`/v2/employees/${employeeId}/effective-status`),
    enabled: !!employeeId,
  });
}
