import React from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Truck, FileText, Wallet, ShieldCheck, MessageSquareWarning } from 'lucide-react';

// Customer Portal Mobile App — Implementation Spec §1/§3. A customer-facing
// sibling of the staff layout/MobileTabBar.jsx — same fixed-bottom,
// safe-area-inset pattern, DIFFERENT tab set (customer screens, not
// collector/cashier ones). Notifications lives in the header bell
// (PortalShell.jsx, unchanged), Service Information/Documents/Outstanding
// Balance are sub-views of an existing primary tab, and Settings resolves
// to Account (OD-M3) rather than consuming a slot. "Complaints" added here
// per Phase 5 Complaints Implementation Spec §15 — Complaints' own new
// page choosing how to surface itself now that a real backend exists,
// not a reopening of the Mobile App's own frozen decisions; each tab's
// hit area (flex:1, minHeight:44px) stays within the 44x44px touch-target
// requirement with 6 tabs at every previously-tested width.
const TABS = [
  { to: '/portal', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/portal/collections', label: 'Collections', icon: Truck },
  { to: '/portal/invoices', label: 'Invoices', icon: FileText },
  { to: '/portal/payments', label: 'Payments', icon: Wallet },
  { to: '/portal/complaints', label: 'Complaints', icon: MessageSquareWarning },
  { to: '/portal/account/profile', label: 'Account', icon: ShieldCheck },
];

export default function PortalMobileTabBar() {
  return (
    <nav style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, display: 'flex',
      background: 'var(--surface)', borderTop: '1px solid var(--border)',
      padding: '8px 4px calc(8px + env(safe-area-inset-bottom, 0px))', zIndex: 50,
    }}>
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          aria-label={t.label}
          style={({ isActive }) => ({
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
            textDecoration: 'none', padding: '6px', minHeight: '44px', justifyContent: 'center',
            color: isActive ? 'var(--brand)' : 'var(--text-muted)',
          })}
        >
          <t.icon size={20} />
          <span style={{ fontSize: '11px', fontWeight: 700 }}>{t.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
