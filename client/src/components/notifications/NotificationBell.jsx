import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { useUnreadNotificationCount } from '../../hooks/useStaffNotifications.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

// Staff Notifications — Implementation Spec §18. One of exactly 2 approved
// UI surfaces. Additive element in the shared Sidebar — no existing
// Sidebar nav-item logic is changed by this component's presence.
//
// `to` — added (Phase 10) when this same bell was reused in the field
// shells (FieldTopBar.jsx for cashier, CollectorShell.jsx for
// collector), which live under their own route subtrees rather than
// the desktop app's top-level '/notifications' — defaults to the
// original desktop path so Sidebar.jsx's existing call is unaffected.
export default function NotificationBell({ to = '/notifications' }) {
  const { data } = useUnreadNotificationCount();
  const navigate = useNavigate();
  const { t } = useI18n();
  const count = data?.data?.count || 0;
  return (
    <button
      onClick={() => navigate(to)}
      aria-label={t('portal.notifications')}
      style={{
        position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
        width: '36px', height: '36px', borderRadius: 'var(--radius-sm)',
      }}
    >
      <Bell size={18} />
      {count > 0 && (
        <span style={{
          position: 'absolute', top: '2px', right: '2px', background: 'var(--danger)', color: '#fff',
          borderRadius: '10px', fontSize: '10px', fontWeight: 800, minWidth: '16px', height: '16px',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px',
        }}>{count > 99 ? '99+' : count}</span>
      )}
    </button>
  );
}
