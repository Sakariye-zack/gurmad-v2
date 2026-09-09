import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Master Functional Completion Program — Phase 3: Procurement. UI
// consumes authoritative API results only — totals/statuses/
// needs_review are never computed client-side.

// ---------- Suppliers ----------
export function useSuppliers(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'procurement', 'suppliers', params], queryFn: () => apiClient.get(`/v2/procurement/suppliers${query ? `?${query}` : ''}`) });
}
export function useSupplier(id) {
  return useQuery({ queryKey: ['v2', 'procurement', 'suppliers', id], queryFn: () => apiClient.get(`/v2/procurement/suppliers/${id}`), enabled: !!id });
}
export function useCreateSupplier() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/procurement/suppliers', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'suppliers'] }) });
}
export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => apiClient.put(`/v2/procurement/suppliers/${id}`, data),
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'suppliers'] }); qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'suppliers', vars.id] }); },
  });
}
export function useSetSupplierStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }) => apiClient.put(`/v2/procurement/suppliers/${id}/status`, { status }),
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'suppliers'] }); qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'suppliers', vars.id] }); },
  });
}

// ---------- Requests ----------
export function useProcurementRequests(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.priority) qs.set('priority', params.priority);
  if (params.zone_id) qs.set('zone_id', params.zone_id);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'procurement', 'requests', params], queryFn: () => apiClient.get(`/v2/procurement/requests${query ? `?${query}` : ''}`) });
}
export function useProcurementRequest(id) {
  return useQuery({ queryKey: ['v2', 'procurement', 'requests', id], queryFn: () => apiClient.get(`/v2/procurement/requests/${id}`), enabled: !!id });
}
export function useCreateProcurementRequest() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/procurement/requests', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'requests'] }) });
}
export function useUpdateProcurementRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => apiClient.put(`/v2/procurement/requests/${id}`, data),
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'requests'] }); qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'requests', vars.id] }); },
  });
}
export function useSetRequestStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }) => apiClient.put(`/v2/procurement/requests/${id}/status`, { status }),
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'requests'] }); qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'requests', vars.id] }); },
  });
}
export function useCancelRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }) => apiClient.put(`/v2/procurement/requests/${id}/cancel`, { reason }),
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'requests'] }); qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'requests', vars.id] }); },
  });
}

// ---------- Purchase Orders ----------
export function usePurchaseOrders(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.supplier_id) qs.set('supplier_id', params.supplier_id);
  if (params.procurement_request_id) qs.set('procurement_request_id', params.procurement_request_id);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'procurement', 'purchase-orders', params], queryFn: () => apiClient.get(`/v2/procurement/purchase-orders${query ? `?${query}` : ''}`) });
}
export function usePurchaseOrder(id) {
  return useQuery({ queryKey: ['v2', 'procurement', 'purchase-orders', id], queryFn: () => apiClient.get(`/v2/procurement/purchase-orders/${id}`), enabled: !!id });
}
export function useCreatePurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/procurement/purchase-orders', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'purchase-orders'] }) });
}
export function useOrderPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => apiClient.put(`/v2/procurement/purchase-orders/${id}/order`, {}),
    onSuccess: (_r, id) => { qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'purchase-orders'] }); qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'purchase-orders', id] }); },
  });
}
export function useCancelPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }) => apiClient.put(`/v2/procurement/purchase-orders/${id}/cancel`, { reason }),
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'purchase-orders'] }); qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'purchase-orders', vars.id] }); },
  });
}

// ---------- Receiving ----------
export function usePurchaseOrderReceipts(poId) {
  return useQuery({ queryKey: ['v2', 'procurement', 'purchase-orders', poId, 'receipts'], queryFn: () => apiClient.get(`/v2/procurement/purchase-orders/${poId}/receipts`), enabled: !!poId });
}
export function useCreateReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => apiClient.post(`/v2/procurement/purchase-orders/${id}/receipts`, data),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'purchase-orders'] });
      qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'purchase-orders', vars.id] });
      qc.invalidateQueries({ queryKey: ['v2', 'procurement', 'purchase-orders', vars.id, 'receipts'] });
    },
  });
}
