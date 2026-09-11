import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import CompanyLogo from '../components/CompanyLogo.jsx';
import NotificationBell from '../components/notifications/NotificationBell.jsx';
import { ConfirmDialog } from '../components/ui/index.js';

// User-reported gap (Phase 10): AppShell's field-role branch (cashier —
// see FIELD_ROLES in AppShell.jsx; collector uses its own separate
// CollectorShell, which already had a top bar) rendered straight into
// MobileTabBar's content with no header at all — no logo, no way to
// tell who's signed in, and critically no logout: the desktop-only
// toggle button/Sidebar (which is where Settings > Account > Log out
// lives) is explicitly hidden for field roles (showToggleButton is
// `!isFieldRole && ...`). A cashier had no reachable logout control on
// this device at all. Mirrors CollectorShell.jsx's own top bar exactly
// (same logo/name/zone/logout shape) so both field-facing shells feel
// like the same app family, plus the same NotificationBell every
// desktop role already has via Sidebar.jsx — field roles never saw it
// either, an identical omission.
export default function FieldTopBar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const doLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <>
      <header style={{
        position: 'sticky', top: 0, zIndex: 40, display: 'flex', alignItems: 'center', gap: '10px',
        padding: '12px 16px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        margin: '-16px -16px 16px',
      }}>
        <CompanyLogo height={26} fallback={<span style={{ fontWeight: 900, fontSize: '15px', color: 'var(--brand)' }}>GURMAD</span>} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {user?.full_name || user?.username}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{user?.zone || user?.role}</div>
        </div>
        <NotificationBell />
        <button
          onClick={() => setConfirmOpen(true)}
          aria-label="Log out"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: '40px', height: '40px',
            borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)',
            color: 'var(--text-muted)', cursor: 'pointer',
          }}
        >
          <LogOut size={17} />
        </button>
      </header>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={doLogout}
        title="Log out"
        message="This will sign you out of GURMAD."
        confirmLabel="Log out"
        danger
      />
    </>
  );
}
