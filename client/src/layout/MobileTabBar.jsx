import React from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, ClipboardList, Wallet } from 'lucide-react';

// Design_System.md §9: field roles get a bottom tab bar, not the sidebar —
// same component library, a different navigation shell matched to real
// single-task-on-a-phone usage context (carries forward the current
// StaffPortalApp pattern, confirmed solid in the 2026-08-31 audit).
const TABS = [
  { to: '/dashboard', label: 'Home', icon: LayoutDashboard },
  { to: '/collection-cycles', label: 'My Batch', icon: ClipboardList },
  { to: '/billing', label: 'Collect', icon: Wallet },
];

export default function MobileTabBar() {
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
          style={({ isActive }) => ({
            flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
            textDecoration: 'none', padding: '6px', color: isActive ? 'var(--brand)' : 'var(--text-muted)',
          })}
        >
          <t.icon size={20} />
          <span style={{ fontSize: '11px', fontWeight: 700 }}>{t.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
