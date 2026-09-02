import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, Truck, FileText, Wallet, User, LogOut } from 'lucide-react';
import { usePortalAuth } from './PortalAuthContext.jsx';

// Phase 4 — Customer Portal — its own minimal shell, deliberately separate
// from the staff AppShell/Sidebar (no staff nav, no RoleGate — there is no
// staff-role hierarchy inside the portal, per OD-1/Implementation Spec §14).
const NAV_ITEMS = [
  { to: '/portal', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/portal/collections', label: 'Collections', icon: Truck },
  { to: '/portal/invoices', label: 'Invoices', icon: FileText },
  { to: '/portal/payments', label: 'Payments', icon: Wallet },
  { to: '/portal/profile', label: 'Profile', icon: User },
];

export default function PortalShell() {
  const { customer, logout } = usePortalAuth();

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '14px 20px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ fontWeight: 800, fontSize: '15px' }}>GURMAD — My Account</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{customer?.name}</span>
          <button onClick={logout} style={logoutBtnStyle}>
            <LogOut size={14} /> Log out
          </button>
        </div>
      </header>

      <nav style={{ display: 'flex', gap: '4px', padding: '0 20px', background: 'var(--surface)', borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
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

      <main style={{ maxWidth: '960px', margin: '0 auto', padding: '20px' }}>
        <Outlet />
      </main>
    </div>
  );
}

const logoutBtnStyle = {
  display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)', padding: '6px 10px', fontSize: '12px', fontWeight: 700,
  color: 'var(--text-muted)', cursor: 'pointer',
};
