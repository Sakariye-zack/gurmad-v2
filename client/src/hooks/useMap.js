import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Route & GIS / Map — Implementation Spec §16. One query hook, one
// endpoint (GET /v2/map/customers), server-side filtered (zone/group/
// route) — no client-side re-filtering or pagination layered on top.
function filterQs({ zoneId, groupId, groupZoneId, routeId, today }) {
  const params = new URLSearchParams();
  if (zoneId) params.set('zone_id', String(zoneId));
  if (groupId) params.set('group_id', String(groupId));
  if (groupZoneId) params.set('group_zone_id', String(groupZoneId));
  if (routeId) params.set('route_id', String(routeId));
  if (today) params.set('today', '1');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function useMapCustomers(filters) {
  const qs = filterQs(filters);
  return useQuery({
    queryKey: ['v2', 'map', 'customers', filters],
    queryFn: () => apiClient.get(`/v2/map/customers${qs}`),
  });
}

// Active in-scope customers that cannot be plotted (no location yet).
export function useMapMissingLocation(filters) {
  const qs = filterQs(filters);
  return useQuery({
    queryKey: ['v2', 'map', 'missing-location', filters],
    queryFn: () => apiClient.get(`/v2/map/customers/missing-location${qs}`),
  });
}

// Live trucks. Polled every 15 s while the Map page is open; react-query
// pauses the interval while the tab is hidden (refetchIntervalInBackground
// false). The backend only returns positions from the last 10 minutes, so
// a stale result still ages out on its own.
export const TRUCKS_POLL_MS = 15000;
export function useMapTrucks({ zoneId } = {}) {
  const params = new URLSearchParams();
  if (zoneId) params.set('zone_id', String(zoneId));
  const qs = params.toString();

  return useQuery({
    queryKey: ['v2', 'map', 'trucks', { zoneId }],
    queryFn: () => apiClient.get(`/v2/map/trucks${qs ? `?${qs}` : ''}`),
    refetchInterval: TRUCKS_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

// Today's route (ping trail) for one collector; only fetched while shown.
export function useTruckTrail(employeeId) {
  return useQuery({
    queryKey: ['v2', 'map', 'trail', employeeId],
    queryFn: () => apiClient.get(`/v2/map/trucks/${encodeURIComponent(employeeId)}/trail?since=today`),
    enabled: !!employeeId,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });
}
