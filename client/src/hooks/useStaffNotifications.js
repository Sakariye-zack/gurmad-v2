import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Staff Notifications — Implementation Spec §17. Every call is implicitly
// scoped to the authenticated caller server-side (recipient_id = req.user.id)
// — no id/filter is ever passed here to select "whose" notifications.
export function useStaffNotifications(unreadOnly = false) {
  return useQuery({
    queryKey: ['v2', 'staff-notifications', { unreadOnly }],
    queryFn: () => apiClient.get(`/v2/staff-notifications${unreadOnly ? '?unread_only=true' : ''}`),
  });
}

export function useUnreadNotificationCount() {
  return useQuery({
    queryKey: ['v2', 'staff-notifications', 'unread-count'],
    queryFn: () => apiClient.get('/v2/staff-notifications/unread-count'),
    // No polling/WebSocket (Implementation Spec §19/§21, locked) — refetches
    // only on normal navigation/mount and on React Query's own default
    // window-refocus behavior, never on an interval timer.
  });
}

export function useMarkNotificationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => apiClient.put(`/v2/staff-notifications/${id}/read`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['v2', 'staff-notifications'] });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.put('/v2/staff-notifications/read-all'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['v2', 'staff-notifications'] });
    },
  });
}
