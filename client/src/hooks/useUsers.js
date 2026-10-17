import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// User & Access Administration — admin-only user management.
// `enabled` (default true) — GET /v2/users is itself admin-only
// (routes/users.js), so a caller outside the Users & Access page
// (EmployeeFormModal.jsx's "Linked user account" picker, reachable by
// gudoomiye/zone_accountant too) must pass `enabled: isAdmin` to avoid
// firing a request that always 403s for a non-admin viewer.
export function useUsers(enabled = true) {
  return useQuery({
    queryKey: ['v2', 'users'],
    queryFn: () => apiClient.get('/v2/users'),
    enabled,
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.post('/v2/users', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'users'] }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => apiClient.put(`/v2/users/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'users'] }),
  });
}

export function useDisableUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => apiClient.put(`/v2/users/${id}/disable`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'users'] }),
  });
}

export function useEnableUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => apiClient.put(`/v2/users/${id}/enable`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'users'] }),
  });
}

export function useResetUserPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, password }) => apiClient.put(`/v2/users/${id}/password`, { password }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'users'] }),
  });
}

export function useRevokeUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => apiClient.put(`/v2/users/${id}/revoke`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'users'] }),
  });
}
