import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Truck, FileText, Wallet, ShieldCheck, LogOut, Bell, MessageSquareWarning } from 'lucide-react';
import { usePortalAuth } from './PortalAuthContext.jsx';
import { portalApiClient } from './apiClient.js';
import PortalMobileTabBar from './PortalMobileTabBar.jsx';
import { useCompanyName } from '../hooks/useSettings.js';
import { useI18n } from '../i18n/I18nContext.jsx';
import LanguageToggle from '../components/LanguageToggle.jsx';

// Customer Portal Rebuild — Implementation Spec §3/§18/§20: a real
// navigation structure (primary tabs + an Account area + a notification
// entry point) replacing the flat 5-item bar, still deliberately separate
// from the staff AppShell/Sidebar (no staff nav, no RoleGate — there is no
// staff-role hierarchy inside the portal, per OD-1).
const NAV_ITEMS = [
  { to: '/portal', labelKey: 'portal.nav.dashboard', icon: LayoutDashboard, end: true },
  { to: '/portal/collections', labelKey: 'portal.nav.collections', icon: Truck },
  { to: '/portal/invoices', labelKey: 'portal.nav.invoices', icon: FileText },
  { to: '/portal/payments', labelKey: 'portal.nav.payments', icon: Wallet },
  // "Complaints" — added now that Phase 5's real backend/service layer
  // exists (lib/complaintsService.js, Implementation Spec §15) — the exact
  // condition the Rebuild's own comment here said would unblock this,
  // never shipped ahead of it.
  { to: '/portal/complaints', labelKey: 'portal.nav.complaints', icon: MessageSquareWarning },
  { to: '/portal/account/profile', labelKey: 'portal.nav.account', icon: ShieldCheck },
];

// Mobile App Implementation Spec §1: the identical viewport-detection
// pattern layout/AppShell.jsx already uses for the staff app
// (window.innerWidth < 768, updated on resize) — no new breakpoint
// concept, the same one Design_System.md §14 already specifies.
const MOBILE_BREAKPOINT = 768;

export default function PortalShell() {
  const { customer, logout } = usePortalAuth();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [unreadCount, setUnreadCount] = useState(0);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT);
  // System name — user-requested ('meel kasta oo magaca system ku ka soo
  // muuqanayo waa in aan markan update gareeyo'). GET /v2/settings/company/name
  // is now fully public (no auth) specifically so this portal session —
  // a completely separate customer_portal_accounts JWT the staff-only
  // authenticateToken middleware can't verify — can still read it.
  const { data: companyNameData } = useCompanyName();
  const companyName = companyNameData?.data?.company_name || 'GURMAD';

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
          {isMobile ? companyName : `${companyName} — ${t('portal.myAccount')}`}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '8px' : '14px', flexShrink: 0 }}>
          <LanguageToggle />
          <button
            aria-label={t('portal.notifications')}
            onClick={() => { navigate('/portal/notifications'); refreshUnreadCount(); }}
            // Hardening — Accessibility: the icon alone renders at ~25x25px,
            // below the 44x44px minimum touch target (Design_System.md §9)
            // required on mobile. Desktop keeps the original compact
            // footprint unchanged (a mouse pointer has no such minimum).
            style={isMobile ? { ...bellBtnStyle, minWidth: '44px', minHeight: '44px' } : bellBtnStyle}
          >
            <Bell size={17} />
            {unreadCount > 0 && <span style={badgeStyle}>{unreadCount > 99 ? '99+' : unreadCount}</span>}
          </button>
          {/* Customer name hidden on mobile — the header's own width budget
              is tight at 375px with the bell + logout controls already
              present; the name remains visible everywhere on Account/Profile. */}
          {!isMobile && <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{customer?.name}</span>}
          <button
            aria-label={t('collector.logout')}
            onClick={logout}
            style={isMobile ? { ...logoutBtnStyle, minWidth: '44px', minHeight: '44px', justifyContent: 'center' } : logoutBtnStyle}
          >
            <LogOut size={14} /> {!isMobile && t('collector.logout')}
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
              <item.icon size={15} /> {t(item.labelKey)}
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
