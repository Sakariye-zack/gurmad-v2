import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Operational Calendar — Implementation Spec §17/§20. Read-only projection
// of batches.start_date/end_date. One query hook, one endpoint
// (GET /v2/calendar/batches), server-side filtered (zone/status/customer
// type) and server-side date-window bounded (<=42 days) — no client-side
// pagination or filtering layered on top.
export function useCalendarBatches({ from, to, zoneId, status, customerType }) {
  const params = new URLSearchParams({ from, to });
  if (zoneId) params.set('zone_id', String(zoneId));
  if (status) params.set('status', status);
  if (customerType) params.set('customer_type', customerType);

  return useQuery({
    queryKey: ['v2', 'calendar', 'batches', { from, to, zoneId, status, customerType }],
    queryFn: () => apiClient.get(`/v2/calendar/batches?${params.toString()}`),
    enabled: Boolean(from && to),
  });
}
