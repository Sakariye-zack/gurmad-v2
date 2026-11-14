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

// Billing workspace: open (unpaid/partial) invoices with the authoritative
// per-invoice balance attached by the server (?open=1&with_balance=1).
// Server-side filters + pagination; meta.summary covers every open invoice
// in scope (counts, still owed per currency).
export function useOpenInvoices({ q, status, currency, pageSize = 100 } = {}) {
  const qs = new URLSearchParams({ open: '1', with_balance: '1', page_size: String(pageSize) });
  if (q) qs.set('q', q);
  if (status) qs.set('status', status);
  if (currency) qs.set('currency', currency);
  return useQuery({
    queryKey: ['v2', 'invoices', 'open', q || '', status || '', currency || '', pageSize],
    queryFn: () => apiClient.get(`/v2/invoices?${qs.toString()}`),
    placeholderData: (prev) => prev,
  });
}

// Transactions page — read-only ledger listing / summary / CSV.
export function transactionsQuery(filters = {}) {
  const qs = new URLSearchParams();
  for (const k of ['date_from', 'date_to', 'method', 'currency', 'channel', 'status', 'target', 'q', 'page', 'page_size']) {
    if (filters[k] !== undefined && filters[k] !== null && filters[k] !== '') qs.set(k, String(filters[k]));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}
export function useTransactions(filters) {
  return useQuery({ queryKey: ['v2', 'payments', 'transactions', filters], queryFn: () => apiClient.get(`/v2/payments/transactions${transactionsQuery(filters)}`), placeholderData: (prev) => prev });
}
export function useTransactionsSummary(filters) {
  return useQuery({ queryKey: ['v2', 'payments', 'transactions-summary', filters], queryFn: () => apiClient.get(`/v2/payments/transactions/summary${transactionsQuery(filters)}`), placeholderData: (prev) => prev });
}
export function downloadTransactionsCsv(filters) {
  return apiClient.downloadAuthorizedFile(`/v2/payments/transactions.csv${transactionsQuery(filters)}`, `transactions-${new Date().toISOString().slice(0, 10)}.csv`);
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
      qc.invalidateQueries({ queryKey: ['v2', 'payments'] });
    },
  });
}
// ZAAD push payment — user-requested (Phase 10, ported from the user's
// own previous system): sends a real WAAFI/ZAAD payment request to the
// customer's phone; the request only resolves once the customer has
// approved or the gateway has declined it (POST /v2/payments/zaad-request
// itself is synchronous — see server/lib/zaadService.js).
export function useRequestZaadPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.post('/v2/payments/zaad-request', data),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['v2', 'invoices'] });
      qc.invalidateQueries({ queryKey: ['v2', 'invoices', vars.invoice_id] });
      qc.invalidateQueries({ queryKey: ['v2', 'payments'] });
      if (vars.debt_id) qc.invalidateQueries({ queryKey: ['v2', 'debts'] });
    },
  });
}
export function useReversePayment(invoiceId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }) => apiClient.put(`/v2/payments/${id}/reverse`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['v2', 'debts'] });
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
  if (params.page_size) qs.set('page_size', String(params.page_size));
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

// ---- Debts V2: register list / summary / detail, collect, write-off, edit, follow-ups ----
const DEBT_FILTER_KEYS = ['q', 'status', 'source', 'currency', 'age', 'promise', 'zone_id', 'group_id', 'group_zone_id', 'route_id', 'amount_min', 'amount_max', 'customer_id'];
export function debtsQuery(filters = {}, extra = {}) {
  const qs = new URLSearchParams();
  for (const k of DEBT_FILTER_KEYS) if (filters[k] !== undefined && filters[k] !== null && filters[k] !== '') qs.set(k, String(filters[k]));
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : '';
}
export function useDebtsPage(filters, { page = 1, pageSize = 25, sort, dir, view } = {}) {
  const query = debtsQuery(filters, { page, page_size: pageSize, sort, dir, view });
  return useQuery({ queryKey: ['v2', 'debts', 'page', query], queryFn: () => apiClient.get(`/v2/debts${query}`), placeholderData: (prev) => prev });
}
export function useDebtsSummary() {
  return useQuery({ queryKey: ['v2', 'debts', 'summary'], queryFn: () => apiClient.get('/v2/debts/summary') });
}
export function useDebt(id) {
  return useQuery({ queryKey: ['v2', 'debts', 'detail', id], queryFn: () => apiClient.get(`/v2/debts/${id}`), enabled: !!id });
}
export function exportDebtsCsv(filters, { sort, dir } = {}) {
  return apiClient.downloadAuthorizedFile(`/v2/debts/export.csv${debtsQuery(filters, { sort, dir })}`, `debts-${new Date().toISOString().slice(0, 10)}.csv`);
}
function invalidateMoney(qc) {
  qc.invalidateQueries({ queryKey: ['v2', 'debts'] });
  qc.invalidateQueries({ queryKey: ['v2', 'invoices'] });
  qc.invalidateQueries({ queryKey: ['v2', 'payments'] });
}
export function useCollectDebt() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, idempotencyKey, ...body }) => apiClient.post(`/v2/debts/${id}/collect`, body, idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined), onSuccess: () => invalidateMoney(qc) });
}
export function useWriteOffDebt() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, reason }) => apiClient.put(`/v2/debts/${id}/write-off`, { reason }), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'debts'] }) });
}
export function useUpdateDebt() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, description }) => apiClient.put(`/v2/debts/${id}`, { description }), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'debts'] }) });
}
export function useAddFollowup() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body) => apiClient.post('/v2/debts/followups', body), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'debts'] }) });
}

export function useExchangeRates() {
  return useQuery({ queryKey: ['v2', 'exchange-rates'], queryFn: () => apiClient.get('/v2/exchange-rates') });
}
export function useSetExchangeRate() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (rate) => apiClient.post('/v2/exchange-rates', { rate }), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'exchange-rates'] }) });
}

// Automatic invoicing: last runs + skipped customers, and the admin-only manual trigger.
export function useAutoBillingStatus(enabled = true) {
  return useQuery({ queryKey: ['v2', 'invoices', 'auto-billing-status'], queryFn: () => apiClient.get('/v2/invoices/auto-billing/status'), enabled });
}
export function useRunAutoBilling() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => apiClient.post('/v2/invoices/auto-billing/run', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'invoices'] }),
  });
}
