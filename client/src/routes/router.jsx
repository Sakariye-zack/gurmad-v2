import React, { lazy } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
const AppShell = lazy(() => import('../layout/AppShell.jsx'));
const Login = lazy(() => import('../pages/Login.jsx'));
const Dashboard = lazy(() => import('../pages/Dashboard.jsx'));
const ZonesListPage = lazy(() => import('../pages/zones/ZonesListPage.jsx'));
const ZoneDetailPage = lazy(() => import('../pages/zones/ZoneDetailPage.jsx'));
// Group & Group-Based Collection — Change Request.
const GroupsListPage = lazy(() => import('../pages/groups/GroupsListPage.jsx'));
const GroupDetailPage = lazy(() => import('../pages/groups/GroupDetailPage.jsx'));
// Audit & Security Center.
const AuditCenterListPage = lazy(() => import('../pages/audit/AuditCenterListPage.jsx'));
// System Settings.
const SettingsPage = lazy(() => import('../pages/settings/SettingsPage.jsx'));
// Staff Notifications — additive route, in-app only.
const NotificationsListPage = lazy(() => import('../pages/notifications/NotificationsListPage.jsx'));
// Operational Calendar — additive route, read-only projection of batches.
const CalendarPage = lazy(() => import('../pages/calendar/CalendarPage.jsx'));
// Route & GIS / Map — additive route, read-only projection of customer
// coordinates + Group/Route membership, rendered via Mapbox GL JS.
const MapPage = lazy(() => import('../pages/map/MapPage.jsx'));
// Master Functional Completion Program — Phase 1: HR & Payroll. Additive
// routes only — no Sidebar/MobileNavDrawer/AppShell/MobileTabBar change
// (CLOSED/FROZEN); nav entries are a documented future CR (Spec §18).
const AttendanceListPage = lazy(() => import('../pages/hr/AttendanceListPage.jsx'));
const HrReportsPage = lazy(() => import('../pages/hr/HrReportsPage.jsx'));
const LeaveTypesPage = lazy(() => import('../pages/hr/LeaveTypesPage.jsx'));
const LeaveRequestsListPage = lazy(() => import('../pages/hr/LeaveRequestsListPage.jsx'));
const PayrollPeriodsListPage = lazy(() => import('../pages/payroll/PayrollPeriodsListPage.jsx'));
const PayrollPeriodDetailPage = lazy(() => import('../pages/payroll/PayrollPeriodDetailPage.jsx'));
const PayrollRecordDetailPage = lazy(() => import('../pages/payroll/PayrollRecordDetailPage.jsx'));
const PayrollHistoryPage = lazy(() => import('../pages/payroll/PayrollHistoryPage.jsx'));
// Master Functional Completion Program — Phase 2: Fleet Management.
// Additive only — Trucks pages/Sidebar untouched (CLOSED/FROZEN); nav
// entries are a documented future CR.
const FleetMaintenanceListPage = lazy(() => import('../pages/fleet/FleetMaintenanceListPage.jsx'));
const FleetFuelListPage = lazy(() => import('../pages/fleet/FleetFuelListPage.jsx'));
const FleetExpiryPage = lazy(() => import('../pages/fleet/FleetExpiryPage.jsx'));
// Master Functional Completion Program — Phase 3: Procurement.
const SuppliersListPage = lazy(() => import('../pages/procurement/SuppliersListPage.jsx'));
const SupplierDetailPage = lazy(() => import('../pages/procurement/SupplierDetailPage.jsx'));
const ProcurementRequestsListPage = lazy(() => import('../pages/procurement/ProcurementRequestsListPage.jsx'));
const ProcurementRequestDetailPage = lazy(() => import('../pages/procurement/ProcurementRequestDetailPage.jsx'));
const PurchaseOrdersListPage = lazy(() => import('../pages/procurement/PurchaseOrdersListPage.jsx'));
const PurchaseOrderDetailPage = lazy(() => import('../pages/procurement/PurchaseOrderDetailPage.jsx'));
const InventoryItemsListPage = lazy(() => import('../pages/inventory/InventoryItemsListPage.jsx'));
const InventoryItemDetailPage = lazy(() => import('../pages/inventory/InventoryItemDetailPage.jsx'));
const InventoryStoresListPage = lazy(() => import('../pages/inventory/InventoryStoresListPage.jsx'));
const InventoryStoreDetailPage = lazy(() => import('../pages/inventory/InventoryStoreDetailPage.jsx'));
const InventoryMovementsPage = lazy(() => import('../pages/inventory/InventoryMovementsPage.jsx'));
const InventoryAdjustmentsPage = lazy(() => import('../pages/inventory/InventoryAdjustmentsPage.jsx'));
const AssetsListPage = lazy(() => import('../pages/inventory/AssetsListPage.jsx'));
const AssetDetailPage = lazy(() => import('../pages/inventory/AssetDetailPage.jsx'));
const DocumentsListPage = lazy(() => import('../pages/documents/DocumentsListPage.jsx'));
const DocumentDetailPage = lazy(() => import('../pages/documents/DocumentDetailPage.jsx'));
const MasterDataImportPage = lazy(() => import('../pages/masterData/MasterDataImportPage.jsx'));
const MasterDataExportPage = lazy(() => import('../pages/masterData/MasterDataExportPage.jsx'));
const CustomersListPage = lazy(() => import('../pages/customers/CustomersListPage.jsx'));
const CustomerDetailPage = lazy(() => import('../pages/customers/CustomerDetailPage.jsx'));
const EmployeesListPage = lazy(() => import('../pages/employees/EmployeesListPage.jsx'));
const EmployeeDetailPage = lazy(() => import('../pages/employees/EmployeeDetailPage.jsx'));
const TrucksListPage = lazy(() => import('../pages/trucks/TrucksListPage.jsx'));
const TruckDetailPage = lazy(() => import('../pages/trucks/TruckDetailPage.jsx'));
const CyclesListPage = lazy(() => import('../pages/collection/CyclesListPage.jsx'));
const BatchesListPage = lazy(() => import('../pages/collection/BatchesListPage.jsx'));
const BatchDetailPage = lazy(() => import('../pages/collection/BatchDetailPage.jsx'));
const InvoicesListPage = lazy(() => import('../pages/financial/InvoicesListPage.jsx'));
const InvoiceDetailPage = lazy(() => import('../pages/financial/InvoiceDetailPage.jsx'));
const BillingView = lazy(() => import('../pages/financial/BillingView.jsx'));
const DebtsView = lazy(() => import('../pages/financial/DebtsView.jsx'));
const CashoutsListPage = lazy(() => import('../pages/financial/CashoutsListPage.jsx'));
const ReportsPage = lazy(() => import('../pages/reports/ReportsPage.jsx'));
const CashoutDetailPage = lazy(() => import('../pages/financial/CashoutDetailPage.jsx'));
const ExchangeRatesPage = lazy(() => import('../pages/financial/ExchangeRatesPage.jsx'));
const ComplaintsListPage = lazy(() => import('../pages/complaints/ComplaintsListPage.jsx'));
const ComplaintDetailPage = lazy(() => import('../pages/complaints/ComplaintDetailPage.jsx'));
const UsersListPage = lazy(() => import('../pages/users/UsersListPage.jsx'));
const RolesPermissionsPage = lazy(() => import('../pages/roles/RolesPermissionsPage.jsx'));
const TasksPage = lazy(() => import('../pages/tasks/TasksPage.jsx'));
const AccountSecurity = lazy(() => import('../pages/account/AccountSecurity.jsx'));
const MyHrPage = lazy(() => import('../pages/account/MyHrPage.jsx'));
import RequireAuth from './RequireAuth.jsx';
const RequirePortalAuth = lazy(() => import('../portal/RequirePortalAuth.jsx'));
const PortalShell = lazy(() => import('../portal/PortalShell.jsx'));
const PortalLogin = lazy(() => import('../portal/pages/PortalLogin.jsx'));
const PortalForgotPassword = lazy(() => import('../portal/pages/PortalForgotPassword.jsx'));
const PortalResetPassword = lazy(() => import('../portal/pages/PortalResetPassword.jsx'));
const PortalDashboard = lazy(() => import('../portal/pages/PortalDashboard.jsx'));
const PortalCollections = lazy(() => import('../portal/pages/PortalCollections.jsx'));
const PortalCollectionDetail = lazy(() => import('../portal/pages/collections/PortalCollectionDetail.jsx'));
const PortalInvoices = lazy(() => import('../portal/pages/PortalInvoices.jsx'));
const PortalInvoiceDetail = lazy(() => import('../portal/pages/PortalInvoiceDetail.jsx'));
const PortalPayments = lazy(() => import('../portal/pages/PortalPayments.jsx'));
const PortalBalance = lazy(() => import('../portal/pages/PortalBalance.jsx'));
const PortalAccountProfile = lazy(() => import('../portal/pages/account/PortalAccountProfile.jsx'));
const PortalAccountSecurity = lazy(() => import('../portal/pages/account/PortalAccountSecurity.jsx'));
const PortalNotifications = lazy(() => import('../portal/pages/notifications/PortalNotifications.jsx'));
const PortalComplaints = lazy(() => import('../portal/pages/complaints/PortalComplaints.jsx'));
const PortalComplaintDetail = lazy(() => import('../portal/pages/complaints/PortalComplaintDetail.jsx'));
const PortalComplaintSubmit = lazy(() => import('../portal/pages/complaints/PortalComplaintSubmit.jsx'));
// Field Collector Mobile — a fully separate route tree, outside the staff
// desktop AppShell (its own mobile-first shell), reusing the existing
// staff AuthContext/JWT exactly as-is (NOT a new auth system, unlike the
// Customer Portal's own separate identity system above).
const CollectorApp = lazy(() => import('../collector/CollectorApp.jsx'));
import CollectorRequireAuth from '../collector/CollectorRequireAuth.jsx';
const CollectorShell = lazy(() => import('../collector/CollectorShell.jsx'));
const CollectorLoginScreen = lazy(() => import('../collector/screens/LoginScreen.jsx'));
const CollectorHomeScreen = lazy(() => import('../collector/screens/HomeScreen.jsx'));
const CollectorAssignmentsScreen = lazy(() => import('../collector/screens/AssignmentsScreen.jsx'));
const CollectorCustomerDetailScreen = lazy(() => import('../collector/screens/CustomerDetailScreen.jsx'));
const CollectorCollectionActionScreen = lazy(() => import('../collector/screens/CollectionActionScreen.jsx'));
const CollectorSyncCenterScreen = lazy(() => import('../collector/screens/SyncCenterScreen.jsx'));
// Note: NotificationsListPage is already imported above (desktop
// /notifications route) — reused as-is here too (Phase 10), plain
// content with no desktop-shell dependency, already self-scoped to the
// authenticated caller server-side.
const CollectorAccountScreen = lazy(() => import('../collector/screens/AccountScreen.jsx'));

// Real client-side routing — Information_Architecture.md §2: replaces the
// current system's activeTab-state pattern (no per-page URLs, no deep
// linking, no refresh-preserves-page). This is the single largest confirmed
// whole-app architectural gap found across the entire T2.8 program.
export const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: <RequireAuth><AppShell /></RequireAuth>,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'customers', element: <CustomersListPage /> },
      { path: 'customers/:id', element: <CustomerDetailPage /> },
      { path: 'zones', element: <ZonesListPage /> },
      { path: 'zones/:id', element: <ZoneDetailPage /> },
      { path: 'groups', element: <GroupsListPage /> },
      { path: 'groups/:id', element: <GroupDetailPage /> },
      { path: 'employees', element: <EmployeesListPage /> },
      { path: 'employees/:id', element: <EmployeeDetailPage /> },
      { path: 'trucks', element: <TrucksListPage /> },
      { path: 'trucks/:id', element: <TruckDetailPage /> },
      { path: 'collection-cycles', element: <CyclesListPage /> },
      { path: 'collection-cycles/batches', element: <BatchesListPage /> },
      { path: 'collection-cycles/batches/:id', element: <BatchDetailPage /> },
      // Financial — Phase 3 Module 6: Billing and Invoices are deliberately
      // separate pages/routes (approved architecture), not one combined
      // surface. 'billing' kept as the legacy path collectors/cashiers'
      // mobile tab already links to (MobileTabBar.jsx) — now a real page,
      // no longer a placeholder.
      { path: 'financial/invoices', element: <InvoicesListPage /> },
      { path: 'financial/invoices/:id', element: <InvoiceDetailPage /> },
      { path: 'financial/debts', element: <DebtsView /> },
      { path: 'financial/cashouts', element: <CashoutsListPage /> },
      { path: 'financial/cashouts/:id', element: <CashoutDetailPage /> },
      { path: 'financial/exchange-rate', element: <ExchangeRatesPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'billing', element: <BillingView /> },
      { path: 'complaints', element: <ComplaintsListPage /> },
      { path: 'complaints/:id', element: <ComplaintDetailPage /> },
      { path: 'users', element: <UsersListPage /> },
      { path: 'roles', element: <RolesPermissionsPage /> },
      { path: 'audit', element: <AuditCenterListPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'account/security', element: <AccountSecurity /> },
      { path: 'account/my-hr', element: <MyHrPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'notifications', element: <NotificationsListPage /> },
      { path: 'calendar', element: <CalendarPage /> },
      { path: 'map', element: <MapPage /> },
      // Phase 1 HR & Payroll — nav entry added in Sidebar.jsx (Phase 8 audit).
      { path: 'hr/attendance', element: <AttendanceListPage /> },
      { path: 'hr/reports', element: <HrReportsPage /> },
      { path: 'hr/leave-types', element: <LeaveTypesPage /> },
      { path: 'hr/leave-requests', element: <LeaveRequestsListPage /> },
      { path: 'payroll/periods', element: <PayrollPeriodsListPage /> },
      { path: 'payroll/periods/:id', element: <PayrollPeriodDetailPage /> },
      { path: 'payroll/records/:id', element: <PayrollRecordDetailPage /> },
      { path: 'payroll/history', element: <PayrollHistoryPage /> },
      // Phase 2 Fleet Management — nav entry added in Sidebar.jsx (Phase 8 audit).
      { path: 'fleet/maintenance', element: <FleetMaintenanceListPage /> },
      { path: 'fleet/fuel', element: <FleetFuelListPage /> },
      { path: 'fleet/expiry', element: <FleetExpiryPage /> },
      // Phase 3 Procurement — nav entry added in Sidebar.jsx (Phase 8 audit).
      { path: 'procurement/suppliers', element: <SuppliersListPage /> },
      { path: 'procurement/suppliers/:id', element: <SupplierDetailPage /> },
      { path: 'procurement/requests', element: <ProcurementRequestsListPage /> },
      { path: 'procurement/requests/:id', element: <ProcurementRequestDetailPage /> },
      { path: 'procurement/purchase-orders', element: <PurchaseOrdersListPage /> },
      { path: 'procurement/purchase-orders/:id', element: <PurchaseOrderDetailPage /> },
      // Phase 4 Inventory & Assets — nav entry added in Sidebar.jsx (Phase 8 audit).
      { path: 'inventory/items', element: <InventoryItemsListPage /> },
      { path: 'inventory/items/:id', element: <InventoryItemDetailPage /> },
      { path: 'inventory/stores', element: <InventoryStoresListPage /> },
      { path: 'inventory/stores/:id', element: <InventoryStoreDetailPage /> },
      { path: 'inventory/movements', element: <InventoryMovementsPage /> },
      { path: 'inventory/adjustments', element: <InventoryAdjustmentsPage /> },
      { path: 'inventory/assets', element: <AssetsListPage /> },
      { path: 'inventory/assets/:id', element: <AssetDetailPage /> },
      // Phase 5 Document & File Management — nav entry added in Sidebar.jsx (Phase 8 audit).
      { path: 'documents', element: <DocumentsListPage /> },
      { path: 'documents/:id', element: <DocumentDetailPage /> },
      // Phase 6 Import/Export + Master Data Governance — nav entry added in Sidebar.jsx (Phase 8 audit).
      { path: 'master-data/import', element: <MasterDataImportPage /> },
      { path: 'master-data/export', element: <MasterDataExportPage /> },
    ],
  },
  // Phase 4 — Customer Portal: a fully separate route tree, outside the
  // staff AppShell — its own shell, its own auth guard (RequirePortalAuth,
  // backed by PortalAuthContext, never the staff RequireAuth/AuthContext).
  { path: '/portal/login', element: <PortalLogin /> },
  { path: '/portal/forgot-password', element: <PortalForgotPassword /> },
  { path: '/portal/reset-password', element: <PortalResetPassword /> },
  {
    path: '/portal',
    element: <RequirePortalAuth><PortalShell /></RequirePortalAuth>,
    children: [
      { index: true, element: <PortalDashboard /> },
      { path: 'collections', element: <PortalCollections /> },
      { path: 'collections/:id', element: <PortalCollectionDetail /> },
      { path: 'invoices', element: <PortalInvoices /> },
      { path: 'invoices/:id', element: <PortalInvoiceDetail /> },
      { path: 'payments', element: <PortalPayments /> },
      { path: 'balance', element: <PortalBalance /> },
      // 'profile' kept as a redirect — the original single page split into
      // account/profile + account/security (Rebuild Spec §3/§21), so any
      // previously-bookmarked/linked '/portal/profile' still resolves.
      { path: 'profile', element: <Navigate to="/portal/account/profile" replace /> },
      { path: 'account/profile', element: <PortalAccountProfile /> },
      { path: 'account/security', element: <PortalAccountSecurity /> },
      { path: 'notifications', element: <PortalNotifications /> },
      { path: 'complaints', element: <PortalComplaints /> },
      { path: 'complaints/new', element: <PortalComplaintSubmit /> },
      { path: 'complaints/:id', element: <PortalComplaintDetail /> },
    ],
  },
  // Field Collector Mobile (Offline/Sync's own client consumer) — its own
  // route tree, its own guard (CollectorRequireAuth), its own mobile-first
  // shell (CollectorShell). CollectorApp owns the encryption-key lifecycle
  // and must wrap every authenticated Collector route.
  { path: '/collector/login', element: <CollectorLoginScreen /> },
  {
    path: '/collector',
    element: <CollectorRequireAuth><CollectorApp /></CollectorRequireAuth>,
    children: [
      {
        element: <CollectorShell />,
        children: [
          { index: true, element: <CollectorHomeScreen /> },
          { path: 'assignments', element: <CollectorAssignmentsScreen /> },
          { path: 'customer/:batchId/:customerId', element: <CollectorCustomerDetailScreen /> },
          { path: 'action/:batchId/:customerId', element: <CollectorCollectionActionScreen /> },
          { path: 'sync', element: <CollectorSyncCenterScreen /> },
          { path: 'account', element: <CollectorAccountScreen /> },
          { path: 'notifications', element: <NotificationsListPage /> },
        ],
      },
    ],
  },
]);
