import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Account security — own sessions and sign-in history.

export function useMySessions() {
  return useQuery({
    queryKey: ['v2', 'auth', 'sessions'],
    queryFn: () => apiClient.get('/v2/auth/sessions'),
  });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => apiClient.post(`/v2/auth/sessions/${encodeURIComponent(id)}/revoke`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'auth', 'sessions'] }),
  });
}

export function useMyLoginHistory() {
  return useQuery({
    queryKey: ['v2', 'auth', 'login-history'],
    queryFn: () => apiClient.get('/v2/auth/login-history'),
  });
}
