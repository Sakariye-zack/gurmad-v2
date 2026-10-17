import React from 'react';
import { Bell } from 'lucide-react';
import { PageHeader, Button, LoadingState, EmptyState, ErrorState, StatusBadge } from '../../components/ui/index.js';
import { useStaffNotifications, useMarkNotificationRead, useMarkAllNotificationsRead } from '../../hooks/useStaffNotifications.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

// Staff Notifications — Implementation Spec §18. The second (and last) of
// exactly 2 approved UI surfaces. No detail page — expanding/marking an
// item in place is sufficient at this minimal payload size (Spec §18).
export default function NotificationsListPage() {
  const { t } = useI18n();
  const { data, isLoading, isError, refetch } = useStaffNotifications();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  if (isLoading) return <LoadingState label={t('notif.loading')} />;
  if (isError) return <ErrorState message={t('notif.loadFailed')} onRetry={refetch} />;

  const notifications = data?.data || [];
  const hasUnread = notifications.some((n) => !n.is_read);

  return (
    <div>
      <PageHeader
        icon={Bell}
        title={t('portal.notifications')}
        actions={hasUnread ? (
          <Button variant="secondary" onClick={() => markAllRead.mutate()} disabled={markAllRead.isPending}>
            {t('portal.notif.markAll')}
          </Button>
        ) : undefined}
      />
      {notifications.length === 0 ? (
        <EmptyState icon={Bell} title={t('notif.empty')} subtitle={t('notif.emptyHint')} />
      ) : (
        notifications.map((n) => (
          <div
            key={n.id}
            onClick={() => !n.is_read && markRead.mutate(n.id)}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px',
              padding: '14px', marginBottom: '8px', borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border)', background: n.is_read ? 'var(--surface)' : 'var(--success-bg)',
              cursor: n.is_read ? 'default' : 'pointer',
            }}
          >
            <div>
              <div style={{ fontWeight: 700, fontSize: '14px' }}>{n.title}</div>
              {n.body && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>{n.body}</div>}
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                {new Date(n.created_at).toLocaleString()}
              </div>
            </div>
            {!n.is_read && <StatusBadge status="pending" map={{ pending: 'info' }} />}
          </div>
        ))
      )}
    </div>
  );
}
