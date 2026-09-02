import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Truck, FileText, Wallet, ShieldCheck, LogOut, Bell } from 'lucide-react';
import { usePortalAuth } from './PortalAuthContext.jsx';
import { portalApiClient } from './apiClient.js';
import PortalMobileTabBar from './PortalMobileTabBar.jsx';

// Customer Portal Rebuild — Implementation Spec §3/§18/§20: a real
// navigation structure (primary tabs + an Account area + a notification
// entry point) replacing the flat 5-item bar, still deliberately separate
// from the staff AppShell/Sidebar (no staff nav, no RoleGate — there is no
// staff-role hierarchy inside the portal, per OD-1).
const NAV_ITEMS = [
  { to: '/portal', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/portal/collections', label: 'Collections', icon: Truck },
  { to: '/portal/invoices', label: 'Invoices', icon: FileText },
  { to: '/portal/payments', label: 'Payments', icon: Wallet },
  // No "Complaints" nav item yet — intentionally, per the Implementation
  // Spec/approval: Complaints-facing Portal pages are sequenced BEHIND
  // Phase 5's real backend, not built ahead of it (never ship UI with
  // nothing real behind it, per Phase 4's own original OD-3 precedent).
  { to: '/portal/account/profile', label: 'Account', icon: ShieldCheck },
];

// Mobile App Implementation Spec §1: the identical viewport-detection
// pattern layout/AppShell.jsx already uses for the staff app
// (window.innerWidth < 768, updated on resize) — no new breakpoint
// concept, the same one Design_System.md §14 already specifies.
const MOBILE_BREAKPOINT = 768;

export default function PortalShell() {
  const { customer, logout } = usePortalAuth();
  const navigate = useNavigate();
  const [unreadCount, setUnreadCount] = useState(0);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function refreshUnreadCount() {
    portalApiClient.get('/notifications/unread-count')
      .then((res) => setUnreadCount(res.data.count))
      .catch(() => { /* non-critical — bell just shows 0 on failure */ });
  }

  // Refetched on mount and on every route change (via the nav click below)
  // rather than a websocket — matches the app's existing polling-based
  // patterns elsewhere, no new real-time infrastructure (Rebuild Spec §26).
  useEffect(refreshUnreadCount, []);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: isMobile ? '14px 16px' : '14px 20px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        minWidth: 0,
      }}>
        <div style={{ fontWeight: 800, fontSize: '15px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {isMobile ? 'GURMAD' : 'GURMAD — My Account'}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '8px' : '14px', flexShrink: 0 }}>
          <button
            aria-label="Notifications"
            onClick={() => { navigate('/portal/notifications'); refreshUnreadCount(); }}
            style={bellBtnStyle}
          >
            <Bell size={17} />
            {unreadCount > 0 && <span style={badgeStyle}>{unreadCount > 99 ? '99+' : unreadCount}</span>}
          </button>
          {/* Customer name hidden on mobile — the header's own width budget
              is tight at 375px with the bell + logout controls already
              present; the name remains visible everywhere on Account/Profile. */}
          {!isMobile && <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{customer?.name}</span>}
          <button aria-label="Log out" onClick={logout} style={logoutBtnStyle}>
            <LogOut size={14} /> {!isMobile && 'Log out'}
          </button>
        </div>
      </header>

      {/* Desktop/tablet (>=768px): the existing horizontal nav, unchanged.
          Mobile (<768px): PortalMobileTabBar renders fixed-bottom instead —
          this branch is the entire mobile-shell change; the rest of the
          page is untouched from the already-Hardened Web Portal. */}
      {!isMobile && (
        <nav style={{ display: 'flex', gap: '4px', padding: '0 20px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={refreshUnreadCount}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 12px',
                fontSize: '13px', fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap',
                color: isActive ? 'var(--brand)' : 'var(--text-muted)',
                borderBottom: isActive ? '2px solid var(--brand)' : '2px solid transparent',
              })}
            >
              <item.icon size={15} /> {item.label}
            </NavLink>
          ))}
        </nav>
      )}

      <main style={{
        maxWidth: '960px', margin: '0 auto',
        padding: isMobile ? '16px' : '20px',
        // Reserve space for the fixed bottom tab bar — mirrors
        // AppShell.jsx's own paddingBottom: 80px mobile-shell value.
        paddingBottom: isMobile ? '84px' : '20px',
      }}>
        <Outlet />
      </main>

      {isMobile && <PortalMobileTabBar />}
    </div>
  );
}

const logoutBtnStyle = {
  display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)', padding: '6px 10px', fontSize: '12px', fontWeight: 700,
  color: 'var(--text-muted)', cursor: 'pointer',
};

const bellBtnStyle = {
  position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: '4px',
};

const badgeStyle = {
  position: 'absolute', top: '-4px', right: '-6px', background: 'var(--danger, #DC2626)', color: '#fff',
  fontSize: '10px', fontWeight: 800, borderRadius: '999px', padding: '1px 5px', lineHeight: '1.4',
  minWidth: '16px', textAlign: 'center',
};
