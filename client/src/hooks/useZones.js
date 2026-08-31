import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Zone Master Data — Phase 3, Module 1. Talks to the new V2 domain backend
// at /api/v2/zones (proxied to the standalone gurmad-v2/server), not the
// T2.8 reference backend.
export function useZones(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  const query = qs.toString();
  return useQuery({
    queryKey: ['v2', 'zones', params],
    queryFn: () => apiClient.get(`/v2/zones${query ? `?${query}` : ''}`),
  });
}

export function useZone(id) {
  return useQuery({
    queryKey: ['v2', 'zones', id],
    queryFn: () => apiClient.get(`/v2/zones/${id}`),
    enabled: !!id,
  });
}

export function useCreateZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.post('/v2/zones', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'zones'] }),
  });
}

export function useUpdateZone(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.put(`/v2/zones/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['v2', 'zones'] });
    },
  });
}
