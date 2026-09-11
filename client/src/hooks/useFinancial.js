import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Financial Billing Foundation — Phase 3, Module 6. UI consumes authoritative
// API results only; no financial calculation (balance/status/derivation) is
// duplicated here — every number rendered comes straight from the backend.

export function useInvoices(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.customer_id) qs.set('customer_id', params.customer_id);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'invoices', params], queryFn: () => apiClient.get(`/v2/invoices${query ? `?${query}` : ''}`) });
}
export function useInvoice(id) {
  return useQuery({ queryKey: ['v2', 'invoices', id], queryFn: () => apiClient.get(`/v2/invoices/${id}`), enabled: !!id });
}
export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/invoices', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'invoices'] }) });
}
export function useBulkGenerateInvoices() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (batchId) => apiClient.post('/v2/invoices/bulk-generate', { batch_id: batchId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'invoices'] }),
  });
}
export function useVoidInvoice(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason) => apiClient.put(`/v2/invoices/${id}/void`, { reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['v2', 'invoices'] }); qc.invalidateQueries({ queryKey: ['v2', 'invoices', id] }); },
  });
}

export function usePayments(invoiceId) {
  return useQuery({ queryKey: ['v2', 'payments', invoiceId], queryFn: () => apiClient.get(`/v2/payments?invoice_id=${invoiceId}`), enabled: !!invoiceId });
}
export function useRecordPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.post('/v2/payments', data),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['v2', 'invoices'] });
      qc.invalidateQueries({ queryKey: ['v2', 'invoices', vars.invoice_id] });
      qc.invalidateQueries({ queryKey: ['v2', 'payments', vars.invoice_id] });
    },
  });
}
export function useReversePayment(invoiceId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }) => apiClient.put(`/v2/payments/${id}/reverse`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['v2', 'invoices'] });
      qc.invalidateQueries({ queryKey: ['v2', 'invoices', invoiceId] });
      qc.invalidateQueries({ queryKey: ['v2', 'payments', invoiceId] });
    },
  });
}

export function useDebts(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.customer_id) qs.set('customer_id', params.customer_id);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'debts', params], queryFn: () => apiClient.get(`/v2/debts${query ? `?${query}` : ''}`) });
}
export function useCreateDebt() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/debts', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'debts'] }) });
}
export function useSettleDebt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, settlement_override_reason }) => apiClient.put(`/v2/debts/${id}/status`, { status: 'paid', settlement_override_reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'debts'] }),
  });
}

export function useExchangeRates() {
  return useQuery({ queryKey: ['v2', 'exchange-rates'], queryFn: () => apiClient.get('/v2/exchange-rates') });
}
export function useSetExchangeRate() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (rate) => apiClient.post('/v2/exchange-rates', { rate }), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'exchange-rates'] }) });
}
