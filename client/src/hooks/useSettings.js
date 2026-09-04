import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// System Settings — Phase 1 (Company Settings). Admin-only.
export function useCompanySettings() {
  return useQuery({
    queryKey: ['v2', 'settings', 'company'],
    queryFn: () => apiClient.get('/v2/settings/company'),
  });
}

export function useUpdateCompanySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.put('/v2/settings/company', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'settings', 'company'] }),
  });
}

export function useUpdateCompanyLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file) => {
      const formData = new FormData();
      formData.append('logo', file);
      return apiClient.uploadFile('/v2/settings/company/logo', formData);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'settings', 'company'] }),
  });
}
