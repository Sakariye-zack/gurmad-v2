import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Group & Group-Based Collection — Change Request. Implementation Spec §16.
// Talks to /api/v2/groups on the same V2 domain backend as every other
// hook here (Zones, Customers, ...).
export function useGroups(params = {}) {
  const qs = new URLSearchParams();
  if (params.zone_id) qs.set('zone_id', params.zone_id);
  if (params.status) qs.set('status', params.status);
  if (params.search) qs.set('q', params.search);
  if (params.limit) qs.set('limit', params.limit);
  const query = qs.toString();
  return useQuery({
    queryKey: ['v2', 'groups', params],
    queryFn: () => apiClient.get(`/v2/groups${query ? `?${query}` : ''}`),
  });
}

export function useGroup(id) {
  return useQuery({
    queryKey: ['v2', 'groups', id],
    queryFn: () => apiClient.get(`/v2/groups/${id}`),
    enabled: !!id,
  });
}

export function useGroupCustomers(id, params = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.customer_type) qs.set('customer_type', params.customer_type);
  if (params.route_id) qs.set('route_id', params.route_id);
  const query = qs.toString();
  return useQuery({
    queryKey: ['v2', 'groups', id, 'customers', params],
    queryFn: () => apiClient.get(`/v2/groups/${id}/customers${query ? `?${query}` : ''}`),
    enabled: !!id,
  });
}

// Read-only preview (no side effects) — powers the Group-based batch
// creation Customer Type filter (Spec §9/§26-5).
export function useGroupEligibleCustomers(id, customerTypeFilter = 'all') {
  return useQuery({
    queryKey: ['v2', 'groups', id, 'eligible-customers', customerTypeFilter],
    queryFn: () => apiClient.get(`/v2/groups/${id}/eligible-customers?customer_type_filter=${customerTypeFilter}`),
    enabled: !!id,
  });
}

export function useGroupSummary(id) {
  return useQuery({
    queryKey: ['v2', 'reports', 'groups', id, 'summary'],
    queryFn: () => apiClient.get(`/v2/reports/groups/${id}/summary`),
    enabled: !!id,
  });
}

export function useGroupCollectorPerformance(id) {
  return useQuery({
    queryKey: ['v2', 'reports', 'groups', id, 'collector-performance'],
    queryFn: () => apiClient.get(`/v2/reports/groups/${id}/collector-performance`),
    enabled: !!id,
  });
}

export function useCreateGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.post('/v2/groups', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'groups'] }),
  });
}

export function useUpdateGroup(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.put(`/v2/groups/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'groups'] }),
  });
}

// ---------- Route (structural entity, nested under a Group) ----------

export function useRoutesForGroup(groupId) {
  return useQuery({
    queryKey: ['v2', 'routes', { group_id: groupId }],
    queryFn: () => apiClient.get(`/v2/routes?group_id=${groupId}`),
    enabled: !!groupId,
  });
}

export function useCreateRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.post('/v2/routes', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['v2', 'routes'] });
      qc.invalidateQueries({ queryKey: ['v2', 'groups'] });
    },
  });
}

export function useUpdateRoute(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.put(`/v2/routes/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['v2', 'routes'] });
      qc.invalidateQueries({ queryKey: ['v2', 'groups'] });
    },
  });
}

// Groups V2 — summary cards on the Groups list (same filters as the list).
export function useGroupsSummary(params = {}) {
  const qs = new URLSearchParams();
  if (params.zone_id) qs.set('zone_id', params.zone_id);
  if (params.status) qs.set('status', params.status);
  if (params.leader_user_id) qs.set('leader_user_id', params.leader_user_id);
  const query = qs.toString();
  return useQuery({
    queryKey: ['v2', 'groups', 'summary', params],
    queryFn: () => apiClient.get(`/v2/groups/summary${query ? `?${query}` : ''}`),
  });
}

// Every Sub Zone in the viewer's scope (district-scoped server-side), with
// group_code/group_name — the Customers list's always-on Sub Zone filter.
export function useAllRoutes(enabled = true) {
  return useQuery({
    queryKey: ['v2', 'routes', 'all'],
    queryFn: () => apiClient.get('/v2/routes'),
    enabled,
  });
}
