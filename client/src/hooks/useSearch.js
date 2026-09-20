import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Global Search — Phase 10, user-requested ('search bar oo waliba global
// search ah'). One query hook, one endpoint (GET /v2/search) — the
// backend itself decides what categories/rows this role can see (mirrors
// each entity's own existing visibility rule), so this hook never filters
// or re-shapes anything client-side.
export function useGlobalSearch(q) {
  const query = (q || '').trim();
  return useQuery({
    queryKey: ['v2', 'search', query],
    queryFn: () => apiClient.get(`/v2/search?q=${encodeURIComponent(query)}`),
    enabled: query.length >= 2,
    staleTime: 10000,
  });
}
