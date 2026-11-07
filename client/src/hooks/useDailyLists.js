import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Daily lists ("Today's list") — /api/v2/daily-lists.
export function useDailyLists(date) {
  return useQuery({
    queryKey: ['v2', 'daily-lists', date || 'today'],
    queryFn: () => apiClient.get(`/v2/daily-lists${date ? `?date=${date}` : ''}`),
  });
}
export function useDailyListWarnings() {
  return useQuery({ queryKey: ['v2', 'daily-lists', 'warnings'], queryFn: () => apiClient.get('/v2/daily-lists/warnings') });
}
export function useDailyListOptions(zoneId, enabled = true) {
  return useQuery({
    queryKey: ['v2', 'daily-lists', 'options', zoneId || 'all'],
    queryFn: () => apiClient.get(`/v2/daily-lists/options${zoneId ? `?zone_id=${zoneId}` : ''}`),
    enabled,
  });
}
function invalidate(qc) {
  qc.invalidateQueries({ queryKey: ['v2', 'daily-lists'] });
  qc.invalidateQueries({ queryKey: ['v2', 'batches'] });
}
export function useRunDailyLists() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (date) => apiClient.post('/v2/daily-lists/run', date ? { date } : {}), onSuccess: () => invalidate(qc) });
}
export function useAddDailyListCustomer() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ batchId, customerId }) => apiClient.post(`/v2/daily-lists/${batchId}/customers`, { customer_id: customerId }), onSuccess: () => invalidate(qc) });
}
export function useRemoveDailyListCustomer() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ batchId, customerId }) => apiClient.del(`/v2/daily-lists/${batchId}/customers/${customerId}`), onSuccess: () => invalidate(qc) });
}
export function useReassignDailyList() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ batchId, ...body }) => apiClient.put(`/v2/daily-lists/${batchId}/assignment`, body), onSuccess: () => invalidate(qc) });
}
