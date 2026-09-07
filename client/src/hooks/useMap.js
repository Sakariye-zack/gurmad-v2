import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Route & GIS / Map — Implementation Spec §16. One query hook, one
// endpoint (GET /v2/map/customers), server-side filtered (zone/group/
// route) — no client-side re-filtering or pagination layered on top.
export function useMapCustomers({ zoneId, groupId, routeId }) {
  const params = new URLSearchParams();
  if (zoneId) params.set('zone_id', String(zoneId));
  if (groupId) params.set('group_id', String(groupId));
  if (routeId) params.set('route_id', String(routeId));
  const qs = params.toString();

  return useQuery({
    queryKey: ['v2', 'map', 'customers', { zoneId, groupId, routeId }],
    queryFn: () => apiClient.get(`/v2/map/customers${qs ? `?${qs}` : ''}`),
  });
}
