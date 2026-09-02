import React from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Truck, FileText, Wallet, ShieldCheck } from 'lucide-react';

// Customer Portal Mobile App — Implementation Spec §1/§3. A customer-facing
// sibling of the staff layout/MobileTabBar.jsx — same fixed-bottom,
// safe-area-inset pattern, DIFFERENT tab set (customer screens, not
// collector/cashier ones). 5 tabs cover all 16 approved screens per the
// Spec's own nav-budget resolution: Notifications lives in the header bell
// (PortalShell.jsx, unchanged), Service Information/Documents/Outstanding
// Balance are sub-views of an existing primary tab, and Settings resolves
// to Account (OD-M3) rather than consuming a 6th slot.
const TABS = [
  { to: '/portal', label: 'Home', icon: LayoutDashboard, end: true },
  { to: '/portal/collections', label: 'Collections', icon: Truck },
  { to: '/portal/invoices', label: 'Invoices', icon: FileText },
  { to: '/portal/payments', label: 'Payments', icon: Wallet },
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
