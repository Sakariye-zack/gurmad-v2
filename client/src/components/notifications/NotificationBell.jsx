import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { useUnreadNotificationCount } from '../../hooks/useStaffNotifications.js';

// Staff Notifications — Implementation Spec §18. One of exactly 2 approved
// UI surfaces. Additive element in the shared Sidebar — no existing
// Sidebar nav-item logic is changed by this component's presence.
export default function NotificationBell() {
  const { data } = useUnreadNotificationCount();
  const navigate = useNavigate();
  const count = data?.data?.count || 0;
  return (
    <button
      onClick={() => navigate('/notifications')}
      aria-label="Notifications"
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
