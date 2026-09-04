import React from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Users, Users2, MapPinned, Boxes, Truck, ClipboardList, Receipt, Wallet, HandCoins, Wallet2, BarChart3, MessageSquareWarning, ShieldCheck, ShieldAlert, History, LogOut } from 'lucide-react';
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
  // Group & Group-Based Collection — Change Request. Same visibility rule
  // as Zones (no legitimate role is excluded from viewing); write access
  // is gated at the page/backend level (admin/gudoomiye, own zone).
  { to: '/groups', label: 'Groups', icon: Boxes },
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
  // Module 8 — Reports. Collector gets it too (their own Collector-
  // Performance tab only, server-enforced) — the nav item itself isn't
  // role-hidden from them, the financial sub-tabs inside the page are.
  { to: '/reports', label: 'Reports', icon: BarChart3, roles: ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier', 'collector'] },
  // Phase 5 — Complaints. Admin/Gudoomiye = full management (create/assign/
  // status/priority/reply). Zone Accountant/Head of Cashiers = read-only
  // (enforced server-side by requireRole on every write route, not just
  // hidden here). Cashier explicitly excluded — the original "own cashier-
  // scope" wording was superseded by the approved Decision Review: no
  // V2-native cashier-scope engine exists, none was built, Cashier = no
  // access. Collector: zero evidence anywhere supports any access.
  { to: '/complaints', label: 'Complaints', icon: MessageSquareWarning, roles: ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'] },
  // User & Access Administration — OD-2: admin-only, matches the
  // backend's own requireRole('admin') on every /v2/users route.
  { to: '/users', label: 'Users & Access', icon: ShieldCheck, roles: ['admin'] },
  // Audit & Security Center — Phase 1, D1: Admin-only, company-wide.
  { to: '/audit', label: 'Audit & Security', icon: History, roles: ['admin'] },
  // Account Security is self-service — every authenticated staff member
  // manages their own password/sessions, so this item is intentionally
  // ungated (no `roles`), matching the backend's own /v2/auth/* routes,
  // which only require authenticateToken, never requireRole.
  { to: '/account/security', label: 'Account Security', icon: ShieldAlert },
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
