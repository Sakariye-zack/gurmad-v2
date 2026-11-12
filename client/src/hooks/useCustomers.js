import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Customer Master Data — Phase 3, Module 2. Talks to the V2 domain backend
// at /api/v2/customers (same backend/proxy as Zones).
export function useCustomers(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.customer_type) qs.set('customer_type', params.customer_type);
  if (params.zone_id) qs.set('zone_id', params.zone_id);
  // Group & Group-Based Collection — Change Request, Spec §9/§16. Reused by
  // the Group-based batch-creation UI.
  if (params.group_id) qs.set('group_id', params.group_id);
  if (params.group_zone_id) qs.set('group_zone_id', params.group_zone_id);
  if (params.route_id) qs.set('route_id', params.route_id);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['v2', 'customers', params],
    queryFn: () => apiClient.get(`/v2/customers${query ? `?${query}` : ''}`),
  });
}

// Customers list page: paginated / sorted / filtered list, its summary cards,
// CSV export and the bulk "Assign Sub Zone" action. `filters` keys map 1:1
// to the GET /v2/customers query params (empty values are dropped).
const LIST_PARAM_KEYS = [
  'q', 'status', 'customer_type', 'group_id', 'zone_id', 'group_zone_id', 'route_id', 'collector_id', 'billing_type',
  'owes', 'has_location', 'no_subzone', 'suspended_for_debt', 'portal',
];
export function customerListQuery(filters = {}, extra = {}) {
  const qs = new URLSearchParams();
  for (const k of LIST_PARAM_KEYS) {
    const v = filters[k];
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  return qs.toString();
}

export function useCustomersPage(filters, { page, pageSize, sort, dir, withBalance }) {
  const query = customerListQuery(filters, { page, page_size: pageSize, sort, dir, with_balance: withBalance ? 1 : undefined });
  return useQuery({
    queryKey: ['v2', 'customers', 'page', query],
    queryFn: () => apiClient.get(`/v2/customers?${query}`),
    placeholderData: (prev) => prev,
  });
}

export function useCustomersSummary(filters) {
  const query = customerListQuery(filters);
  return useQuery({
    queryKey: ['v2', 'customers', 'summary', query],
    queryFn: () => apiClient.get(`/v2/customers/summary${query ? `?${query}` : ''}`),
  });
}

export function exportCustomersCsv(filters, { sort, dir } = {}) {
  const query = customerListQuery(filters, { sort, dir });
  return apiClient.downloadAuthorizedFile(`/v2/customers/export.csv${query ? `?${query}` : ''}`, `customers-${new Date().toISOString().slice(0, 10)}.csv`);
}

export function useBulkAssignSubzone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customer_ids, route_id }) => apiClient.post('/v2/customers/bulk/assign-subzone', { customer_ids, route_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'customers'] }),
  });
}

export function useCustomer(id) {
  return useQuery({
    queryKey: ['v2', 'customers', id],
    queryFn: () => apiClient.get(`/v2/customers/${id}`),
    enabled: !!id,
  });
}

// P1 Functional Gaps — Customer Detail's Collection History section.
export function useCustomerCollectionHistory(id) {
  return useQuery({
    queryKey: ['v2', 'customers', id, 'collection-history'],
    queryFn: () => apiClient.get(`/v2/customers/${id}/collection-history`),
    enabled: !!id,
  });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.post('/v2/customers', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'customers'] }),
  });
}

export function useUpdateCustomer(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.put(`/v2/customers/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'customers'] }),
  });
}

export function useUpdateCustomerNumber(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (customer_number) => apiClient.put(`/v2/customers/${id}/customer-number`, { customer_number }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'customers'] }),
  });
}

export function useUpdateCustomerStatus(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status) => apiClient.put(`/v2/customers/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'customers'] }),
  });
}

export function useCheckDuplicate() {
  return useMutation({
    mutationFn: ({ phone, business_name, address_line, customer_type }) => {
      const qs = new URLSearchParams();
      if (phone) qs.set('phone', phone);
      if (business_name) qs.set('business_name', business_name);
      if (address_line) qs.set('address_line', address_line);
      if (customer_type) qs.set('customer_type', customer_type);
      return apiClient.get(`/v2/customers/check-duplicate?${qs.toString()}`);
    },
  });
}

export function useZonesList() {
  return useQuery({
    queryKey: ['v2', 'zones', { status: 'active' }],
    queryFn: () => apiClient.get('/v2/zones?status=active'),
  });
}

// Door / Customer # change requests (admin-approved).
export function useNumberRequests(params = {}) {
  const qs = new URLSearchParams();
  qs.set('status', params.status || 'pending');
  if (params.customer_id) qs.set('customer_id', params.customer_id);
  return useQuery({
    queryKey: ['v2', 'customers', 'number-requests', params],
    queryFn: () => apiClient.get(`/v2/customers/number-requests?${qs.toString()}`),
    enabled: params.enabled !== false,
  });
}

export function useDecideNumberRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }) => apiClient.post(`/v2/customers/number-requests/${id}/${action}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'customers'] }),
  });
}
