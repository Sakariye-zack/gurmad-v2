import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Dynamic Roles & Permissions (user-requested) — admin-only role/permission
// management, same hook shape as every other admin surface in this codebase
// (useUsers.js, useSettings.js).

export function useRoles() {
  return useQuery({
    queryKey: ['v2', 'roles'],
    queryFn: () => apiClient.get('/v2/roles'),
  });
}

export function usePermissionsCatalog() {
  return useQuery({
    queryKey: ['v2', 'permissions-catalog'],
    queryFn: () => apiClient.get('/v2/roles/permissions'),
    staleTime: 10 * 60_000,
  });
}

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.post('/v2/roles', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'roles'] }),
  });
}

export function useUpdateRolePermissions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, permission_keys }) => apiClient.put(`/v2/roles/${id}/permissions`, { permission_keys }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'roles'] }),
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => apiClient.del(`/v2/roles/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'roles'] }),
  });
}
