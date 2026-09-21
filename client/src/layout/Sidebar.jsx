import React, { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Users2, MapPinned, Boxes, Truck, ClipboardList, Receipt, Wallet, HandCoins, Wallet2,
  BarChart3, MessageSquareWarning, ShieldCheck, ShieldAlert, History, Settings as SettingsIcon, LogOut,
  CalendarDays, Map, ChevronDown, Building2, DollarSign, Warehouse, ShoppingCart, FolderClosed, UserCircle2,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import RoleGate from '../components/RoleGate.jsx';
import CompanyLogo from '../components/CompanyLogo.jsx';
import { useCompanyName } from '../hooks/useSettings.js';
// ThemeToggle/NotificationBell moved to layout/TopBar.jsx (Phase 10,
// user-requested top bar redesign) — no longer rendered here, avoiding
// the same two controls appearing twice on screen.

// Information_Architecture.md §2: office-role navigation. Groups mirror the
// approved V2 IA; only foundation-relevant routes are wired to real pages —
// business modules are placeholders per the explicit "foundation only" scope.
// Sidebar / Navigation UX — Implementation Spec §9. Exported so
// MobileNavDrawer.jsx can reuse this exact array (and RoleGate below)
// rather than maintaining a second, parallel navigation list — the
// structural guarantee against desktop/mobile RBAC drift.
//
// `group` (user-requested redesign, Phase 10) — organizes what had grown
// into a single 30+ item flat list into collapsible modules. Purely a
// presentation grouping: adding/changing a `group` value never touches
// `to`/`roles`/`permission`, so MobileNavDrawer.jsx (which still renders
// this array flat, unchanged) and every RBAC boundary already established
// per item are completely unaffected by this field's presence.
export const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, group: null },

  // ---- Operations ----
  { to: '/customers', label: 'Customers', icon: Users, group: 'Operations' },
  { to: '/zones', label: 'Zones', icon: MapPinned, group: 'Operations' },
  { to: '/groups', label: 'Groups', icon: Boxes, group: 'Operations' },
  { to: '/collection-cycles', label: 'Collection Cycles', icon: ClipboardList, permission: 'collection_cycles.view', group: 'Operations' },
  { to: '/collection-cycles/batches', label: 'Batches', icon: Boxes, permission: 'batches.view', group: 'Operations' },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, permission: 'calendar.view', group: 'Operations' },
  { to: '/map', label: 'Map', icon: Map, permission: 'map.view', group: 'Operations' },

  // ---- Financial ----
  { to: '/billing', label: 'Billing', icon: Wallet, permission: 'billing.view', group: 'Financial' },
  { to: '/financial/invoices', label: 'Invoices', icon: Receipt, permission: 'invoices.view', group: 'Financial' },
  { to: '/financial/debts', label: 'Debts', icon: HandCoins, permission: 'debts.view', group: 'Financial' },
  { to: '/financial/cashouts', label: 'Cashout', icon: Wallet2, permission: 'cashouts.view', group: 'Financial' },
  // Added (Phase 10 Billing audit) — the backend (GET/POST
  // /v2/exchange-rates) and frontend hooks already existed; this was the
  // one missing nav entry to actually reach the page. Same VIEW_ROLES as
  // the backend route itself (admin, cashier) — setting a new rate is
  // admin-only, enforced inside the page via RoleGate, same pattern as
  // every other Financial item here.
  { to: '/financial/exchange-rate', label: 'Exchange Rate', icon: DollarSign, permission: 'exchange_rate.view', group: 'Financial' },

  // ---- HR & Payroll ----
  { to: '/employees', label: 'Employees', icon: Users2, permission: 'employees.view', group: 'HR & Payroll' },
  { to: '/hr/attendance', label: 'Attendance', icon: ClipboardList, permission: 'attendance.view', group: 'HR & Payroll' },
  { to: '/hr/leave-requests', label: 'Leave Requests', icon: CalendarDays, permission: 'leave_requests.view', group: 'HR & Payroll' },
  { to: '/hr/leave-types', label: 'Leave Types', icon: SettingsIcon, permission: 'leave_types.view', group: 'HR & Payroll' },
  { to: '/payroll/periods', label: 'Payroll', icon: Wallet2, permission: 'payroll.view', group: 'HR & Payroll' },
  { to: '/payroll/history', label: 'Payroll History', icon: History, permission: 'payroll_history.view', group: 'HR & Payroll' },
  // HR Reports — gap-audit sweep (Phase 10, continuation): GET
  // /v2/hr-reports/headcount, /attendance-summary, /leave-summary were
  // fully built server-side, zone-scoped for gudoomiye/zone_accountant,
  // but had zero UI callers — same OPERATIONAL_ROLES set the backend
  // routes themselves require (server/routes/hrReports.js).
  { to: '/hr/reports', label: 'HR Reports', icon: BarChart3, permission: 'hr_reports.view', group: 'HR & Payroll' },

  // ---- Fleet ----
  { to: '/trucks', label: 'Trucks', icon: Truck, group: 'Fleet' },
  { to: '/fleet/maintenance', label: 'Fleet Maintenance', icon: Truck, permission: 'fleet_maintenance.view', group: 'Fleet' },
  { to: '/fleet/fuel', label: 'Fuel Records', icon: Truck, permission: 'fleet_fuel.view', group: 'Fleet' },
  { to: '/fleet/expiry', label: 'Document Expiry', icon: History, permission: 'fleet_expiry.view', group: 'Fleet' },

  // ---- Procurement ----
  { to: '/procurement/suppliers', label: 'Suppliers', icon: Boxes, permission: 'procurement_suppliers.view', group: 'Procurement' },
  { to: '/procurement/requests', label: 'Procurement Requests', icon: ClipboardList, permission: 'procurement_requests.view', group: 'Procurement' },
  { to: '/procurement/purchase-orders', label: 'Purchase Orders', icon: Receipt, permission: 'purchase_orders.view', group: 'Procurement' },

  // ---- Inventory ----
  { to: '/inventory/items', label: 'Inventory Items', icon: Boxes, permission: 'inventory_items.view', group: 'Inventory' },
  { to: '/inventory/stores', label: 'Inventory Stores', icon: Boxes, permission: 'inventory_stores.view', group: 'Inventory' },
  { to: '/inventory/movements', label: 'Stock Movements', icon: Boxes, permission: 'inventory_movements.view', group: 'Inventory' },
  { to: '/inventory/adjustments', label: 'Inventory Adjustments', icon: ShieldAlert, permission: 'inventory_adjustments.view', group: 'Inventory' },
  { to: '/inventory/assets', label: 'Assets', icon: Boxes, permission: 'inventory_assets.view', group: 'Inventory' },

  // ---- Reports & Complaints ----
  { to: '/reports', label: 'Reports', icon: BarChart3, permission: 'reports.view', group: 'Reports & Complaints' },
  // Collection History — user-requested ('customers kii loo shaqeeyay
  // history-goodi... waa in aan sidebar-ka ka heli karaa'): the report
  // itself already existed as one tab buried inside Reports (with its
  // own status breakdown/filter/CSV export, added earlier this phase),
  // but reaching it meant Reports -> click the History tab every time —
  // no direct path from the sidebar. Deep-links straight to that tab via
  // the ?tab= param ReportsPage.jsx now reads.
  { to: '/reports?tab=history', label: 'Collection History', icon: History, permission: 'collection_history.view', group: 'Reports & Complaints' },
  { to: '/complaints', label: 'Complaints', icon: MessageSquareWarning, permission: 'complaints.view', group: 'Reports & Complaints' },

  // ---- Documents & Data ----
  { to: '/documents', label: 'Documents', icon: ClipboardList, permission: 'documents.view', group: 'Documents & Data' },
  { to: '/master-data/import', label: 'Data Import', icon: ClipboardList, permission: 'master_data_import.view', group: 'Documents & Data' },
  { to: '/master-data/export', label: 'Data Export', icon: ClipboardList, permission: 'master_data_export.view', group: 'Documents & Data' },

  // ---- Administration ----
  { to: '/users', label: 'Users & Access', icon: ShieldCheck, permission: 'users.view', group: 'Administration' },
  // Dynamic Roles & Permissions (user-requested) — admin-only management
  // page for the new roles/permissions data model. roles: kept alongside
  // permission: (unlike every other migrated item here) since this is a
  // brand-new item with no pre-existing role array to preserve fidelity
  // against — a plain roles:['admin'] gate is simplest and correct.
  { to: '/roles', label: 'Roles & Permissions', icon: ShieldCheck, roles: ['admin'], group: 'Administration' },
  { to: '/audit', label: 'Audit & Security', icon: History, permission: 'audit.view', group: 'Administration' },
  { to: '/settings', label: 'System Settings', icon: SettingsIcon, permission: 'settings.view', group: 'Administration' },

  // Account Security is self-service — every authenticated staff member
  // manages their own password/sessions, so this item is intentionally
  // ungated (no `roles`), matching the backend's own /v2/auth/* routes,
  // which only require authenticateToken, never requireRole. Kept
  // ungrouped, same as Dashboard — always visible, never collapsed away.
  { to: '/account/security', label: 'Account Security', icon: ShieldAlert, group: null },
  // My HR — new self-service page (Phase 10 gap-audit sweep). Same
  // ungated pattern as Account Security above: the backend's own
  // GET/POST /v2/attendance/me and /v2/leave-requests/me self-scope by
  // the caller's own linked employee record, no role restriction at
  // all — every staff login should be able to reach this, not just
  // admin/gudoomiye.
  { to: '/account/my-hr', label: 'My HR', icon: UserCircle2, group: null },
];

const GROUP_ICONS = {
  'Operations': Building2,
  'Financial': DollarSign,
  'HR & Payroll': Users2,
  'Fleet': Truck,
  'Procurement': ShoppingCart,
  'Inventory': Warehouse,
  'Reports & Complaints': BarChart3,
  'Documents & Data': FolderClosed,
  'Administration': ShieldCheck,
};
// Fixed display order — Object grouping below preserves first-seen order
// from NAV already, but this is the single source of truth if that ever
// drifts (e.g. an item inserted out of its group's own block by mistake).
const GROUP_ORDER = ['Operations', 'Financial', 'HR & Payroll', 'Fleet', 'Procurement', 'Inventory', 'Reports & Complaints', 'Documents & Data', 'Administration'];

function groupNavItems() {
  const ungrouped = [];
  const byGroup = {};
  for (const item of NAV) {
    if (!item.group) { ungrouped.push(item); continue; }
    (byGroup[item.group] ||= []).push(item);
  }
  return { ungrouped, byGroup };
}

function NavItemLink({ item, onClick }) {
  const link = (
    <NavLink
      to={item.to}
      onClick={onClick}
      style={({ isActive }) => ({
        display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px',
        borderRadius: 'var(--radius-sm)', textDecoration: 'none', fontWeight: 700, fontSize: '13px',
        color: isActive ? 'var(--brand)' : 'var(--text-muted)',
        background: isActive ? 'var(--success-bg)' : 'transparent',
      })}
    >
      <item.icon size={16} />
      {item.label}
    </NavLink>
  );
  if (item.roles || item.permission) {
    return <RoleGate roles={item.roles} permission={item.permission}>{link}</RoleGate>;
  }
  return link;
}

// One collapsible module section — a button header (icon + name + chevron)
// toggling a list of NavItemLinks. Starts expanded when the currently-
// active route lives inside it (so navigating here never hides where you
// are), collapsed otherwise — every module visible-but-tidy on first load
// rather than either "everything expanded" (the original wall of 30+
// items this replaces) or "everything collapsed" (hides where you already are).
function NavGroup({ name, items, currentPath }) {
  const containsActive = items.some((i) => currentPath === i.to || currentPath.startsWith(i.to + '/'));
  const [open, setOpen] = useState(containsActive);
  const Icon = GROUP_ICONS[name] || Boxes;

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 12px',
          background: 'none', border: 'none', cursor: 'pointer', borderRadius: 'var(--radius-sm)',
          fontWeight: 700, fontSize: '11px', letterSpacing: '0.04em', textTransform: 'uppercase',
          color: 'var(--text-muted)',
        }}
      >
        <Icon size={15} />
        <span style={{ flex: 1, textAlign: 'left' }}>{name}</span>
        <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }} />
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', paddingLeft: '14px', marginTop: '1px', marginBottom: '4px' }}>
          {items.map((item) => <NavItemLink key={item.to} item={item} />)}
        </div>
      )}
    </div>
  );
}

export default function Sidebar() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const { ungrouped, byGroup } = groupNavItems();
  // System name — user-requested ('systemka magaciisa waan badalay...
  // meel kasta oo magaca system ku ka soo muuqanayo waa in aan markan
  // update gareeyo uu is badalaaa'): was a hardcoded 'GURMAD V2' string
  // here (and the browser tab title, set below), neither of which ever
  // reflected a Settings > Company Information name change. Falls back
  // to the same literal 'GURMAD V2' when no company name is set yet —
  // never a blank header.
  const { data: companyNameData } = useCompanyName();
  const companyName = companyNameData?.data?.company_name || 'GURMAD V2';
  useEffect(() => {
    document.title = companyName;
  }, [companyName]);
  // Dashboard first, then every group in GROUP_ORDER, then any remaining
  // ungrouped item (Account Security) pinned last — same visual position
  // it always occupied.
  const dashboardItem = ungrouped.find((i) => i.to === '/dashboard');
  const trailingUngrouped = ungrouped.filter((i) => i.to !== '/dashboard');

  return (
    <aside id="app-sidebar" style={{ width: '240px', flexShrink: 0, background: 'var(--surface)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', height: '100vh', position: 'sticky', top: 0 }}>
      {/* Scoped scrollbar restyle (user-requested) — the default browser
          scrollbar (a wide, opaque, always-visible bar) reads as a UI
          defect against this panel's dark surface. Scoped to .gv2-sidebar-
          nav only, not global, so no other scrollable region in the app
          is affected by this. Both engines: -webkit-scrollbar for Chrome/
          Edge/Safari, scrollbar-width/scrollbar-color for Firefox. */}
      <style>{`
        .gv2-sidebar-nav { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
        .gv2-sidebar-nav::-webkit-scrollbar { width: 6px; }
        .gv2-sidebar-nav::-webkit-scrollbar-track { background: transparent; }
        .gv2-sidebar-nav::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
        .gv2-sidebar-nav::-webkit-scrollbar-thumb:hover { background: var(--text-muted); }
      `}</style>

      {/* User-requested ('magaca systemkana halkaa ka soo muuji... logadana
          iga qurxi'): CompanyLogo only ever rendered the wordmark TEXT as
          a fallback for when the logo image itself fails to load — once a
          real logo image is set (Settings > Company Information), the
          system's name never appeared anywhere next to it. Text is now
          always shown alongside the mark, not conditionally on failure. */}
      <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', minWidth: 0 }}>
          <CompanyLogo fallback={<span style={{ fontWeight: 900, fontSize: '17px', color: 'var(--brand)' }}>{companyName}</span>} height={26} style={{ flexShrink: 0 }} />
          <span style={{ fontWeight: 800, fontSize: '15px', letterSpacing: '-0.01em', color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {companyName}
          </span>
        </div>
      </div>

      {/* Sidebar / Navigation UX — Hardening. overflowY:auto + minHeight:0
          so the full nav scrolls within its own flex region instead of
          overflowing the aside's fixed 100vh height and pushing the
          user-info/logout footer below the viewport. flex:1 alone does
          not shrink a flex item below its content height without an
          explicit minHeight:0 — same family of fix as AppShell's own
          minWidth:0 guard on <main>. */}
      <nav className="gv2-sidebar-nav" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {dashboardItem && <NavItemLink item={dashboardItem} />}
        {GROUP_ORDER.filter((g) => byGroup[g]?.length).map((g) => (
          <NavGroup key={g} name={g} items={byGroup[g]} currentPath={location.pathname} />
        ))}
        {trailingUngrouped.map((item) => <NavItemLink key={item.to} item={item} />)}
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
