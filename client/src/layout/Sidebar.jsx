import React from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Users, Users2, MapPinned, Truck, ClipboardList, Receipt, Wallet, HandCoins, Wallet2, LogOut } from 'lucide-react';
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
  // OD-3: unlike Zones/Customers, Employees is genuinely role-restricted —
  // cashier/collector must not see the staff directory at all, not even the
  // nav entry (matches the backend's requireRole on every employees route).
  { to: '/employees', label: 'Employees', icon: Users2, roles: ['admin', 'gudoomiye', 'zone_accountant'] },
  // OD-4: broad operational view (not HR-sensitive like Employees) —
  // ungated, matches the backend's own broader VIEW_ROLES for /v2/trucks.
  { to: '/trucks', label: 'Trucks', icon: Truck },
  // Cycles/Batches view is admin/gudoomiye/zone_accountant/collector —
  // cashier has no role in collection operations at all (matches the
  // backend's VIEW_ROLES on /v2/cycles and /v2/batches).
  { to: '/collection-cycles', label: 'Collection Cycles', icon: ClipboardList, roles: ['admin', 'gudoomiye', 'zone_accountant', 'collector'] },
  // Financial — Phase 3 Module 6. Billing and Invoices are deliberately
  // separate pages (approved architecture), matching the RBAC matrix in
  // Phase3_Module06_FinancialBilling_Implementation_Spec.md §13: Collector
  // has no financial nav entry at all; Gudoomiye/Zone Accountant see all
  // three but are view-only within them (enforced by RoleGate inside each
  // page + backend requireRole, never by hiding the nav item alone).
  { to: '/billing', label: 'Billing', icon: Wallet, roles: ['admin', 'cashier', 'gudoomiye', 'zone_accountant'] },
  { to: '/financial/invoices', label: 'Invoices', icon: Receipt, roles: ['admin', 'cashier', 'gudoomiye', 'zone_accountant'] },
  { to: '/financial/debts', label: 'Debts', icon: HandCoins, roles: ['admin', 'cashier', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'] },
  // Module 7 — Cashout & Cash Reconciliation. Head of Cashiers manages it;
  // Gudoomiye approves (zone-scoped); Zone Accountant/Cashier view only;
  // Collector has no financial nav entry at all, matching every other
  // financial page's own boundary.
  { to: '/financial/cashouts', label: 'Cashout', icon: Wallet2, roles: ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'] },
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
