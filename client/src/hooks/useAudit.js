import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Audit & Security Center — Implementation Spec §13. Admin-only,
// company-wide, read-only. Talks to /api/v2/audit on the same V2 domain
// backend as every other hook here.
function buildQuery(params = {}) {
  const qs = new URLSearchParams();
  if (params.actor) qs.set('actor', params.actor);
  if (params.action) qs.set('action', params.action);
  if (params.entity_type) qs.set('entity_type', params.entity_type);
  if (params.entity_id) qs.set('entity_id', params.entity_id);
  if (params.category) qs.set('category', params.category);
  if (params.severity) qs.set('severity', params.severity);
  if (params.success !== undefined && params.success !== '') qs.set('success', params.success);
  if (params.date_from) qs.set('date_from', params.date_from);
  if (params.date_to) qs.set('date_to', params.date_to);
  if (params.q) qs.set('q', params.q);
  if (params.limit) qs.set('limit', params.limit);
  if (params.offset) qs.set('offset', params.offset);
  return qs.toString();
}

export function useAuditLog(params = {}) {
  const query = buildQuery(params);
  return useQuery({
    queryKey: ['v2', 'audit', params],
    queryFn: () => apiClient.get(`/v2/audit${query ? `?${query}` : ''}`),
  });
}

export function useAuditRecord(id) {
  return useQuery({
    queryKey: ['v2', 'audit', id],
    queryFn: () => apiClient.get(`/v2/audit/${id}`),
    enabled: !!id,
  });
}

// Export is a direct authorized download (same auth header, same
// query-builder as the list per the backend's own shared buildWhere()) —
// not a mutation, so no useMutation wrapper; the caller triggers it
// on-demand via apiClient.downloadAuthorizedFile, matching the existing
// pattern already used elsewhere in this codebase for authorized binary
// downloads.
export function exportAuditLogUrl(params = {}) {
  const query = buildQuery(params);
  return `/v2/audit/export${query ? `?${query}` : ''}`;
}
