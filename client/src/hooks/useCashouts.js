import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Module 7 — Cashout & Cash Reconciliation. UI consumes authoritative API
// results only — reconciliation/shortage/surplus are always server-computed,
// never recalculated here (non-negotiable per the approved spec).

export function useCashouts(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'cashouts', params], queryFn: () => apiClient.get(`/v2/cashouts${query ? `?${query}` : ''}`) });
}
export function useCashout(id) {
  return useQuery({ queryKey: ['v2', 'cashouts', id], queryFn: () => apiClient.get(`/v2/cashouts/${id}`), enabled: !!id });
}
export function useReconciliationPreview(cashierId, periodStart, periodEnd) {
  const enabled = !!cashierId && !!periodStart && !!periodEnd;
  const qs = new URLSearchParams({ cashier_id: cashierId || '', period_start: periodStart || '', period_end: periodEnd || '' });
  return useQuery({
    queryKey: ['v2', 'cashouts', 'reconciliation-preview', cashierId, periodStart, periodEnd],
    queryFn: () => apiClient.get(`/v2/cashouts/reconciliation-preview?${qs.toString()}`),
    enabled,
  });
}
export function useCreateCashout() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/cashouts', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'cashouts'] }) });
}
function invalidateCashout(qc, id) {
  qc.invalidateQueries({ queryKey: ['v2', 'cashouts'] });
  qc.invalidateQueries({ queryKey: ['v2', 'cashouts', id] });
}
export function useApproveCashout(id) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiClient.put(`/v2/cashouts/${id}/approve`, {}), onSuccess: () => invalidateCashout(qc, id) });
}
export function useRejectCashout(id) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (reason) => apiClient.put(`/v2/cashouts/${id}/reject`, { reason }), onSuccess: () => invalidateCashout(qc, id) });
}
export function useVoidCashout(id) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (reason) => apiClient.put(`/v2/cashouts/${id}/void`, { reason }), onSuccess: () => invalidateCashout(qc, id) });
}
export function useUploadAttachment(cashoutId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, documentType }) => {
      const form = new FormData();
      form.append('file', file);
      form.append('document_type', documentType);
      return apiClient.uploadFile(`/v2/cashouts/${cashoutId}/attachments`, form);
    },
    onSuccess: () => invalidateCashout(qc, cashoutId),
  });
}
export function useVoidAttachment(cashoutId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ attachmentId, reason }) => apiClient.del(`/v2/cashouts/${cashoutId}/attachments/${attachmentId}`, { reason }),
    onSuccess: () => invalidateCashout(qc, cashoutId),
  });
}
// Cashout Shortage — cashier accountability/reconciliation liability,
// explicitly NOT a Module 6 Debt (architecture decision). Manual,
// audited resolution only — no automatic recovery mechanism.
export function useResolveShortage(cashoutId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ resolved_amount, resolution_notes }) => apiClient.put(`/v2/cashouts/${cashoutId}/shortage/resolve`, { resolved_amount, resolution_notes }),
    onSuccess: () => invalidateCashout(qc, cashoutId),
  });
}
