import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// User & Access Administration — admin-only user management.
export function useUsers() {
  return useQuery({
    queryKey: ['v2', 'users'],
    queryFn: () => apiClient.get('/v2/users'),
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

export function useRevokeUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => apiClient.put(`/v2/users/${id}/revoke`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'users'] }),
  });
}
