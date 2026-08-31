import React from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Users, MapPinned, ClipboardList, Receipt, LogOut } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import RoleGate from '../components/RoleGate.jsx';

// Information_Architecture.md §2: office-role navigation. Groups mirror the
// approved V2 IA; only foundation-relevant routes are wired to real pages —
// business modules are placeholders per the explicit "foundation only" scope.
const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/customers', label: 'Customers', icon: Users },
  // View is available to any authenticated staff role that needs zone
  // context (Phase 3 Module 1 discovery: "no legitimate role is excluded
  // from viewing") — ungated. Create/Edit stays admin-only at the page level.
  { to: '/zones', label: 'Zones', icon: MapPinned },
  { to: '/collection-cycles', label: 'Collection Cycles', icon: ClipboardList },
  { to: '/billing', label: 'Billing & Invoices', icon: Receipt, permission: 'billing.view' },
];

export default function Sidebar() {
  const { user, logout } = useAuth();
  return (
    <aside style={{ width: '240px', flexShrink: 0, background: 'var(--surface)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', height: '100vh', position: 'sticky', top: 0 }}>
      <div style={{ padding: '20px', fontWeight: 900, fontSize: '18px', color: 'var(--brand)' }}>GURMAD V2</div>
      <nav style={{ flex: 1, padding: '8px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {NAV.map((item) => {
          const link = (
            <NavLink
              key={item.to}
              to={item.to}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
                borderRadius: 'var(--radius-sm)', textDecoration: 'none', fontWeight: 700, fontSize: '13px',
                color: isActive ? 'var(--brand)' : 'var(--text-muted)',
                background: isActive ? 'var(--success-bg)' : 'transparent',
              })}
            >
              <item.icon size={17} />
              {item.label}
            </NavLink>
          );
          if (item.roles || item.permission) {
            return <RoleGate key={item.to} roles={item.roles} permission={item.permission}>{link}</RoleGate>;
          }
          return link;
        })}
      </nav>
      <div style={{ padding: '14px', borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: '12px', fontWeight: 700 }}>{user?.full_name || user?.username}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>{user?.role}{user?.zone ? ` — ${user.zone}` : ''}</div>
        <button onClick={logout} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0 }}>
          <LogOut size={14} /> Log out
        </button>
      </div>
    </aside>
  );
}
