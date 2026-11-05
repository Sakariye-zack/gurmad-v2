import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Zone level between Group and Sub Zone — talks to /api/v2/group-zones.
export function useGroupZones(groupId) {
  return useQuery({
    queryKey: ['v2', 'group-zones', { group_id: groupId }],
    queryFn: () => apiClient.get(`/v2/group-zones?group_id=${groupId}`),
    enabled: !!groupId,
  });
}

export function useGroupZone(id) {
  return useQuery({
    queryKey: ['v2', 'group-zones', id],
    queryFn: () => apiClient.get(`/v2/group-zones/${id}`),
    enabled: !!id,
  });
}

export function useCreateGroupZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.post('/v2/group-zones', data),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['v2', 'group-zones'] });
      qc.invalidateQueries({ queryKey: ['v2', 'groups', vars.group_id] });
    },
  });
}

export function useUpdateGroupZone(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.put(`/v2/group-zones/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['v2', 'group-zones'] });
      qc.invalidateQueries({ queryKey: ['v2', 'groups'] });
    },
  });
}
