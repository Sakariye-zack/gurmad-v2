import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Master Functional Completion Program — Phase 2: Fleet Management. UI
// consumes authoritative API results only — costs/totals/needs_review
// are never computed client-side.

export function useMaintenanceRecords(params = {}) {
  const qs = new URLSearchParams();
  if (params.truck_id) qs.set('truck_id', params.truck_id);
  if (params.date_from) qs.set('date_from', params.date_from);
  if (params.date_to) qs.set('date_to', params.date_to);
  if (params.upcoming_service) qs.set('upcoming_service', 'true');
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'fleet', 'maintenance', params], queryFn: () => apiClient.get(`/v2/fleet/maintenance${query ? `?${query}` : ''}`) });
}
export function useCreateMaintenanceRecord() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/fleet/maintenance', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'fleet', 'maintenance'] }) });
}

export function useFuelRecords(params = {}) {
  const qs = new URLSearchParams();
  if (params.truck_id) qs.set('truck_id', params.truck_id);
  if (params.date_from) qs.set('date_from', params.date_from);
  if (params.date_to) qs.set('date_to', params.date_to);
  if (params.needs_review !== undefined) qs.set('needs_review', params.needs_review);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'fleet', 'fuel', params], queryFn: () => apiClient.get(`/v2/fleet/fuel${query ? `?${query}` : ''}`) });
}
export function useCreateFuelRecord() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/fleet/fuel', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'fleet', 'fuel'] }) });
}

export function useFleetExpiry(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'fleet', 'expiry', params], queryFn: () => apiClient.get(`/v2/fleet/expiry${query ? `?${query}` : ''}`) });
}
