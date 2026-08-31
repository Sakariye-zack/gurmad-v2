import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Customer Master Data — Phase 3, Module 2. Talks to the V2 domain backend
// at /api/v2/customers (same backend/proxy as Zones).
export function useCustomers(params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.customer_type) qs.set('customer_type', params.customer_type);
  if (params.zone_id) qs.set('zone_id', params.zone_id);
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['v2', 'customers', params],
    queryFn: () => apiClient.get(`/v2/customers${query ? `?${query}` : ''}`),
  });
}

export function useCustomer(id) {
  return useQuery({
    queryKey: ['v2', 'customers', id],
    queryFn: () => apiClient.get(`/v2/customers/${id}`),
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
