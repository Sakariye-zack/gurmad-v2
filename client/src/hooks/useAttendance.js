import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Phase 1 HR & Payroll. UI consumes authoritative API results only.

export function useAttendance(params = {}) {
  const qs = new URLSearchParams();
  if (params.employee_id) qs.set('employee_id', params.employee_id);
  if (params.status) qs.set('status', params.status);
  if (params.date_from) qs.set('date_from', params.date_from);
  if (params.date_to) qs.set('date_to', params.date_to);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'attendance', params], queryFn: () => apiClient.get(`/v2/attendance${query ? `?${query}` : ''}`) });
}
export function useMyAttendance() {
  return useQuery({ queryKey: ['v2', 'attendance', 'me'], queryFn: () => apiClient.get('/v2/attendance/me') });
}
export function useMarkAttendance() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/attendance', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'attendance'] }) });
}
export function useCorrectAttendance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => apiClient.post(`/v2/attendance/${id}/correct`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'attendance'] }),
  });
}
