import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Phase 5 — Complaints. UI consumes the authoritative /v2/complaints API
// only — no lifecycle/eligibility/RBAC logic is duplicated here.

export function useComplaints(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'complaints', params], queryFn: () => apiClient.get(`/v2/complaints${query ? `?${query}` : ''}`) });
}
export function useComplaint(id) {
  return useQuery({ queryKey: ['v2', 'complaints', id], queryFn: () => apiClient.get(`/v2/complaints/${id}`), enabled: !!id });
}
export function useCreateComplaint() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/complaints', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'complaints'] }) });
}
export function useUpdateComplaintStatus(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status) => apiClient.put(`/v2/complaints/${id}/status`, { status }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['v2', 'complaints'] }); qc.invalidateQueries({ queryKey: ['v2', 'complaints', id] }); },
  });
}
export function useAssignComplaint(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (employeeId) => apiClient.put(`/v2/complaints/${id}/assign`, { employee_id: employeeId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['v2', 'complaints'] }); qc.invalidateQueries({ queryKey: ['v2', 'complaints', id] }); },
  });
}
export function useSetComplaintPriority(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (priority) => apiClient.put(`/v2/complaints/${id}/priority`, { priority }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['v2', 'complaints'] }); qc.invalidateQueries({ queryKey: ['v2', 'complaints', id] }); },
  });
}
export function useReplyToComplaint(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reply) => apiClient.put(`/v2/complaints/${id}/reply`, { reply }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'complaints', id] }),
  });
}
