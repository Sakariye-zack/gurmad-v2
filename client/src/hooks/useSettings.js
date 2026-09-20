import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// System Settings — Phase 1 (Company Settings). Admin-only.
export function useCompanySettings() {
  return useQuery({
    queryKey: ['v2', 'settings', 'company'],
    queryFn: () => apiClient.get('/v2/settings/company'),
  });
}

// Company name — Phase 10, user-requested ('meel kasta oo magaca system
// ku ka soo muuqanayo waa in aan markan update gareeyo uu is badalaaa').
// Any authenticated role (unlike useCompanySettings() above, which is
// admin-only) — matches GET /v2/settings/company/name's own public-to-
// any-role exception, same rationale as the company logo. Used wherever
// the system's name is displayed, not just Settings itself.
export function useCompanyName() {
  return useQuery({
    queryKey: ['v2', 'settings', 'company-name'],
    queryFn: () => apiClient.get('/v2/settings/company/name'),
    staleTime: 5 * 60 * 1000,
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
