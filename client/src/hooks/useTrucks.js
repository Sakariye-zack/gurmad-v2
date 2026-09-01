import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Trucks (Fleet Master Data) — Phase 3, Module 4.
export function useTrucks(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.zone_id) qs.set('zone_id', params.zone_id);
  if (params.driver_id) qs.set('driver_id', params.driver_id);
  if (params.collector_id) qs.set('collector_id', params.collector_id);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['v2', 'trucks', params],
    queryFn: () => apiClient.get(`/v2/trucks${query ? `?${query}` : ''}`),
  });
}

export function useTruck(id) {
  return useQuery({
    queryKey: ['v2', 'trucks', id],
    queryFn: () => apiClient.get(`/v2/trucks/${id}`),
    enabled: !!id,
  });
}

export function useCreateTruck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.post('/v2/trucks', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'trucks'] }),
  });
}

export function useUpdateTruck(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.put(`/v2/trucks/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'trucks'] }),
  });
}

export function useUpdateTruckStatus(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status) => apiClient.put(`/v2/trucks/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'trucks'] }),
  });
}

// Drivers/Collectors for the assignment dropdowns — filtered client-side
// from the Employees list by employee_type, same source of truth, no
// separate Drivers/Collectors endpoint (none exists, per instruction).
export function useDriverOptions() {
  return useQuery({
    queryKey: ['v2', 'employees', { employee_type: 'driver', forTruckAssignment: true }],
    queryFn: () => apiClient.get('/v2/employees?employee_type=driver&status=active&limit=200'),
  });
}
export function useCollectorOptions() {
  return useQuery({
    queryKey: ['v2', 'employees', { employee_type: 'collector', forTruckAssignment: true }],
    queryFn: () => apiClient.get('/v2/employees?employee_type=collector&status=active&limit=200'),
  });
}
