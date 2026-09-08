import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Collection Operations — Phase 3, Module 5 (Cycles / Batches / Tasks).
export function useCycles(params = {}) {
  const qs = new URLSearchParams();
  if (params.zone_id) qs.set('zone_id', params.zone_id);
  if (params.is_active !== undefined) qs.set('is_active', params.is_active);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'cycles', params], queryFn: () => apiClient.get(`/v2/cycles${query ? `?${query}` : ''}`) });
}
export function useCreateCycle() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/cycles', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'cycles'] }) });
}
export function useCloseCycle(id) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiClient.put(`/v2/cycles/${id}/close`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'cycles'] }) });
}

export function useBatches(params = {}) {
  const qs = new URLSearchParams();
  if (params.zone_id) qs.set('zone_id', params.zone_id);
  if (params.status) qs.set('status', params.status);
  if (params.cycle_id) qs.set('cycle_id', params.cycle_id);
  if (params.search) qs.set('q', params.search);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'batches', params], queryFn: () => apiClient.get(`/v2/batches${query ? `?${query}` : ''}`) });
}
export function useBatch(id) {
  return useQuery({ queryKey: ['v2', 'batches', id], queryFn: () => apiClient.get(`/v2/batches/${id}`), enabled: !!id });
}
export function useBatchCustomers(id) {
  return useQuery({ queryKey: ['v2', 'batches', id, 'customers'], queryFn: () => apiClient.get(`/v2/batches/${id}/customers`), enabled: !!id });
}
export function useCreateBatch() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/batches', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'batches'] }) });
}
function invalidateBatch(qc, id) {
  qc.invalidateQueries({ queryKey: ['v2', 'batches'] });
  qc.invalidateQueries({ queryKey: ['v2', 'batches', id] });
}
export function useStartBatch(id) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiClient.put(`/v2/batches/${id}/start`, {}), onSuccess: () => invalidateBatch(qc, id) });
}
export function useCloseCycleOnBatch(id) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiClient.put(`/v2/batches/${id}/close-cycle`, {}), onSuccess: () => invalidateBatch(qc, id) });
}
export function useCancelBatch(id) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (reason) => apiClient.put(`/v2/batches/${id}/cancel`, { reason }), onSuccess: () => invalidateBatch(qc, id) });
}
export function useCreateTask(batchId) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post(`/v2/batches/${batchId}/tasks`, data), onSuccess: () => invalidateBatch(qc, batchId) });
}
export function useAssignResource(batchId, taskId) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post(`/v2/batches/${batchId}/tasks/${taskId}/resources`, data), onSuccess: () => invalidateBatch(qc, batchId) });
}
export function useRemoveResource(batchId, taskId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ resourceType, resourceId, reason }) => apiClient.del(`/v2/batches/${batchId}/tasks/${taskId}/resources/${resourceType}/${resourceId}`, { reason }),
    onSuccess: () => invalidateBatch(qc, batchId),
  });
}
export function useTaskStatus(batchId, taskId) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (status) => apiClient.put(`/v2/batches/${batchId}/tasks/${taskId}/status`, { status }), onSuccess: () => invalidateBatch(qc, batchId) });
}
export function useMarkCustomerStatus(batchId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, ...data }) => apiClient.put(`/v2/batches/${batchId}/customers/${customerId}/status`, data),
    onSuccess: () => invalidateBatch(qc, batchId),
  });
}
export function useRescheduleCustomer(batchId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, ...data }) => apiClient.post(`/v2/batches/${batchId}/customers/${customerId}/reschedule`, data),
    onSuccess: () => invalidateBatch(qc, batchId),
  });
}
