import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';
import { useAuth } from '../auth/AuthContext.jsx';

// Generalizes the current system's already-proven GET /api/auth/my-permissions
// mechanism (previously used only by StaffPortalApp's "More" menu) into the
// single source of truth every RoleGate in V2 reads from. Fetched once per
// session and cached via react-query — Frontend_Architecture.md §2.
export function usePermissions() {
  const { isAuthenticated } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['my-permissions'],
    queryFn: () => apiClient.get('/v2/auth/my-permissions'),
    enabled: isAuthenticated,
    staleTime: 5 * 60_000,
  });
  return { permissions: data || [], loading: isAuthenticated && isLoading };
}
