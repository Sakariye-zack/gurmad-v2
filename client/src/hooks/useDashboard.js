import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Module 9 — Dashboard. Consumes the already-composed, already-computed
// /v2/dashboard/summary response only — no total is ever recalculated
// here (same non-negotiable rule as Module 8).
export function useDashboardSummary(period = 'today') {
  return useQuery({
    queryKey: ['v2', 'dashboard', 'summary', period],
    queryFn: () => apiClient.get(`/v2/dashboard/summary?period=${period}`),
  });
}
