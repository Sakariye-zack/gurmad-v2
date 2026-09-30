import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Two-Factor Authentication (user-requested) — self-service enrollment,
// same hook-file pattern as every other feature in this codebase.

export function useTwoFactorStatus() {
  return useQuery({
    queryKey: ['v2', 'auth', '2fa-status'],
    queryFn: () => apiClient.get('/v2/auth/2fa/status'),
  });
}

export function useStartTwoFactorSetup() {
  return useMutation({
    mutationFn: () => apiClient.post('/v2/auth/2fa/setup', {}),
  });
}

export function useEnableTwoFactor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code) => apiClient.post('/v2/auth/2fa/enable', { code }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'auth', '2fa-status'] }),
  });
}

export function useDisableTwoFactor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password) => apiClient.post('/v2/auth/2fa/disable', { password }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'auth', '2fa-status'] }),
  });
}
