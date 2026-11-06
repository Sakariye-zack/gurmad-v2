import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Master Functional Completion Program — Phase 2: Fleet Management. UI
// consumes authoritative API results only — costs/totals/needs_review/
// efficiency/flags are never computed client-side.

function qsOf(params, keys) {
  const qs = new URLSearchParams();
  for (const k of keys) {
    const v = params[k];
    if (v !== undefined && v !== null && v !== '' && v !== false) qs.set(k, v === true ? 'true' : v);
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

const invalidateFleet = (qc) => {
  qc.invalidateQueries({ queryKey: ['v2', 'fleet'] });
  qc.invalidateQueries({ queryKey: ['v2', 'trucks'] });
};

export function useMaintenanceRecords(params = {}) {
  const query = qsOf(params, ['truck_id', 'date_from', 'date_to', 'upcoming_service', 'q', 'status', 'due']);
  return useQuery({ queryKey: ['v2', 'fleet', 'maintenance', params], queryFn: () => apiClient.get(`/v2/fleet/maintenance${query}`) });
}
export function useCreateMaintenanceRecord() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/fleet/maintenance', data), onSuccess: () => invalidateFleet(qc) });
}
export function useUpdateMaintenanceStatus() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, ...body }) => apiClient.put(`/v2/fleet/maintenance/${id}/status`, body), onSuccess: () => invalidateFleet(qc) });
}

export const FUEL_FILTER_KEYS = ['truck_id', 'month', 'date_from', 'date_to', 'needs_review', 'flagged', 'q'];
export function fuelQueryString(params = {}) { return qsOf(params, FUEL_FILTER_KEYS); }
export function useFuelRecords(params = {}) {
  const query = fuelQueryString(params);
  return useQuery({ queryKey: ['v2', 'fleet', 'fuel', params], queryFn: () => apiClient.get(`/v2/fleet/fuel${query}`) });
}
export function useCreateFuelRecord() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/fleet/fuel', data), onSuccess: () => invalidateFleet(qc) });
}

// Admin/gudoomiye: edit a fuel record (reason required); history is kept server-side.
export function useUpdateFuelRecord() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, ...body }) => apiClient.put(`/v2/fleet/fuel/${id}`, body), onSuccess: () => invalidateFleet(qc) });
}
export function useFuelRevisions(id, enabled = true) {
  return useQuery({ queryKey: ['v2', 'fleet', 'fuel-revisions', id], enabled: !!id && enabled, queryFn: () => apiClient.get(`/v2/fleet/fuel/${id}/revisions`) });
}

// Admin-only, one-time: confirm the currency of a legacy fuel row.
export function useConfirmFuelCurrency() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, currency }) => apiClient.put(`/v2/fleet/fuel/${id}/currency`, { currency }), onSuccess: () => invalidateFleet(qc) });
}

// kind: 'fuel' | 'maintenance'
export function useUploadReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, id, file }) => {
      const fd = new FormData();
      fd.append('file', file);
      return apiClient.uploadFile(`/v2/fleet/${kind}/${id}/receipt`, fd);
    },
    onSuccess: () => invalidateFleet(qc),
  });
}

export function useFleetExpiry(params = {}) {
  const query = qsOf(params, ['status']);
  return useQuery({ queryKey: ['v2', 'fleet', 'expiry', params], queryFn: () => apiClient.get(`/v2/fleet/expiry${query}`) });
}

export function useFleetOverview() {
  return useQuery({ queryKey: ['v2', 'fleet', 'overview'], queryFn: () => apiClient.get('/v2/fleet/overview'), refetchInterval: 60000 });
}

export function useRenewDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ truckId, document, new_expiry }) => apiClient.put(`/v2/trucks/${truckId}/renew`, { document, new_expiry }),
    onSuccess: () => invalidateFleet(qc),
  });
}

export function useTruckSummary(id) {
  return useQuery({ queryKey: ['v2', 'fleet', 'truck-summary', id], queryFn: () => apiClient.get(`/v2/trucks/${id}/summary`), enabled: !!id });
}
export function useTruckTrips(id, days = 30) {
  return useQuery({ queryKey: ['v2', 'fleet', 'truck-trips', id, days], queryFn: () => apiClient.get(`/v2/trucks/${id}/trips?days=${days}`), enabled: !!id });
}
export function useTruckAssignments(id) {
  return useQuery({ queryKey: ['v2', 'fleet', 'truck-assignments', id], queryFn: () => apiClient.get(`/v2/trucks/${id}/assignments`), enabled: !!id });
}
export function useUploadTruckPhoto(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file) => {
      const fd = new FormData();
      fd.append('file', file);
      return apiClient.uploadFile(`/v2/trucks/${id}/photo`, fd);
    },
    onSuccess: () => invalidateFleet(qc),
  });
}
