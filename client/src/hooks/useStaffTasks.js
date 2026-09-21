import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// General staff Todo/Task tracker (user-requested) — distinct from the
// Collection Cycles/Batches task-assignment already built into
// BatchDetailPage.jsx (useCreateTask/useAssignResource in useCollection.js),
// which schedules a collection-route stop, not a to-do item.

export function useMyTasks() {
  return useQuery({
    queryKey: ['v2', 'staff-tasks', 'my'],
    queryFn: () => apiClient.get('/v2/staff-tasks/my'),
  });
}

export function useUpdateMyTaskStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }) => apiClient.put(`/v2/staff-tasks/my/${id}/status`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['v2', 'staff-tasks', 'my'] });
      qc.invalidateQueries({ queryKey: ['v2', 'staff-tasks'] });
    },
  });
}

export function useStaffTasks(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return useQuery({
    queryKey: ['v2', 'staff-tasks', params],
    queryFn: () => apiClient.get(`/v2/staff-tasks${qs ? `?${qs}` : ''}`),
  });
}

export function useCreateStaffTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.post('/v2/staff-tasks', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'staff-tasks'] }),
  });
}

export function useUpdateStaffTask(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => apiClient.put(`/v2/staff-tasks/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'staff-tasks'] }),
  });
}

export function useDeleteStaffTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => apiClient.del(`/v2/staff-tasks/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'staff-tasks'] }),
  });
}
