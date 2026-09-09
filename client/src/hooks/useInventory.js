import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Master Functional Completion Program — Phase 4: Inventory & Assets.
// UI consumes authoritative API results only — balances/totals are
// never computed client-side.

// ---------- Items ----------
export function useInventoryItems(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'inventory', 'items', params], queryFn: () => apiClient.get(`/v2/inventory/items${query ? `?${query}` : ''}`) });
}
export function useInventoryItem(id) {
  return useQuery({ queryKey: ['v2', 'inventory', 'items', id], queryFn: () => apiClient.get(`/v2/inventory/items/${id}`), enabled: !!id });
}
export function useCreateInventoryItem() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/inventory/items', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'items'] }) });
}
export function useUpdateInventoryItem() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, ...data }) => apiClient.put(`/v2/inventory/items/${id}`, data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'items'] }) });
}
export function useSetInventoryItemStatus() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, status }) => apiClient.put(`/v2/inventory/items/${id}/status`, { status }), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'items'] }) });
}

// ---------- Stores ----------
export function useInventoryStores(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'inventory', 'stores', params], queryFn: () => apiClient.get(`/v2/inventory/stores${query ? `?${query}` : ''}`) });
}
export function useInventoryStore(id) {
  return useQuery({ queryKey: ['v2', 'inventory', 'stores', id], queryFn: () => apiClient.get(`/v2/inventory/stores/${id}`), enabled: !!id });
}
export function useCreateInventoryStore() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/inventory/stores', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'stores'] }) });
}
export function useSetInventoryStoreStatus() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, status }) => apiClient.put(`/v2/inventory/stores/${id}/status`, { status }), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'stores'] }) });
}

// ---------- Movements ----------
export function useInventoryMovements(params = {}) {
  const qs = new URLSearchParams();
  if (params.item_id) qs.set('item_id', params.item_id);
  if (params.store_id) qs.set('store_id', params.store_id);
  if (params.movement_type) qs.set('movement_type', params.movement_type);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'inventory', 'movements', params], queryFn: () => apiClient.get(`/v2/inventory/movements${query ? `?${query}` : ''}`) });
}
function useMovementAction(path) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.post(`/v2/inventory/movements/${path}`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'movements'] }); qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'items'] }); qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'stores'] }); },
  });
}
export function useIssueStock() { return useMovementAction('issue'); }
export function useReceiveStock() { return useMovementAction('receive'); }
export function useTransferStock() { return useMovementAction('transfer'); }
export function useReturnStock() { return useMovementAction('return'); }
export function useRecordOpeningBalance() { return useMovementAction('opening-balance'); }
export function useReceiveFromProcurement() { return useMovementAction('receive-from-procurement'); }

// ---------- Adjustments ----------
export function useAdjustmentRequests(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'inventory', 'adjustments', params], queryFn: () => apiClient.get(`/v2/inventory/adjustments${query ? `?${query}` : ''}`) });
}
export function useCreateAdjustmentRequest() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/inventory/adjustments', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'adjustments'] }) });
}
export function useSetAdjustmentStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => apiClient.put(`/v2/inventory/adjustments/${id}/status`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'adjustments'] }); qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'items'] }); },
  });
}

// ---------- Assets ----------
export function useAssets(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({ queryKey: ['v2', 'inventory', 'assets', params], queryFn: () => apiClient.get(`/v2/inventory/assets${query ? `?${query}` : ''}`) });
}
export function useAsset(id) {
  return useQuery({ queryKey: ['v2', 'inventory', 'assets', id], queryFn: () => apiClient.get(`/v2/inventory/assets/${id}`), enabled: !!id });
}
export function useAssetTransferHistory(id) {
  return useQuery({ queryKey: ['v2', 'inventory', 'assets', id, 'transfers'], queryFn: () => apiClient.get(`/v2/inventory/assets/${id}/transfers`), enabled: !!id });
}
export function useCreateAsset() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (data) => apiClient.post('/v2/inventory/assets', data), onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'assets'] }) });
}
export function useUpdateAsset() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, ...data }) => apiClient.put(`/v2/inventory/assets/${id}`, data), onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'assets'] }); qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'assets', vars.id] }); } });
}
export function useTransferAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => apiClient.put(`/v2/inventory/assets/${id}/transfer`, data),
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'assets'] }); qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'assets', vars.id] }); qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'assets', vars.id, 'transfers'] }); },
  });
}
export function useRetireAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => apiClient.put(`/v2/inventory/assets/${id}/retire`, data),
    onSuccess: (_r, vars) => { qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'assets'] }); qc.invalidateQueries({ queryKey: ['v2', 'inventory', 'assets', vars.id] }); },
  });
}
