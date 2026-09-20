import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Employee Master Data — Phase 3, Module 3.
export function useEmployees(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.employee_type) qs.set('employee_type', params.employee_type);
  if (params.zone_id) qs.set('zone_id', params.zone_id);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['v2', 'employees', params],
    queryFn: () => apiClient.get(`/v2/employees${query ? `?${query}` : ''}`),
  });
}

export function useEmployee(id) {
  return useQuery({
    queryKey: ['v2', 'employees', id],
    queryFn: () => apiClient.get(`/v2/employees/${id}`),
    enabled: !!id,
  });
}

// Self-service — Phase 10 gap-audit sweep: resolves the caller's own
// numeric employee_id (GET /v2/employees/me), needed to then call
// useEmployeeEffectiveStatus() (useLeave.js) for a self-service page.
export function useMyEmployeeId() {
  return useQuery({
    queryKey: ['v2', 'employees', 'me'],
    queryFn: () => apiClient.get('/v2/employees/me'),
    retry: false,
  });
}

export function useCreateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.post('/v2/employees', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'employees'] }),
  });
}

export function useUpdateEmployee(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.put(`/v2/employees/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'employees'] }),
  });
}

export function useUpdateEmployeeStatus(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status) => apiClient.put(`/v2/employees/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'employees'] }),
  });
}
