import React from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import AppShell from '../layout/AppShell.jsx';
import Login from '../pages/Login.jsx';
import Dashboard from '../pages/Dashboard.jsx';
import ZonesListPage from '../pages/zones/ZonesListPage.jsx';
import ZoneDetailPage from '../pages/zones/ZoneDetailPage.jsx';
// Group & Group-Based Collection — Change Request.
import GroupsListPage from '../pages/groups/GroupsListPage.jsx';
import GroupDetailPage from '../pages/groups/GroupDetailPage.jsx';
// Audit & Security Center.
import AuditCenterListPage from '../pages/audit/AuditCenterListPage.jsx';
// System Settings.
import SettingsPage from '../pages/settings/SettingsPage.jsx';
// Staff Notifications — additive route, in-app only.
import NotificationsListPage from '../pages/notifications/NotificationsListPage.jsx';
// Operational Calendar — additive route, read-only projection of batches.
import CalendarPage from '../pages/calendar/CalendarPage.jsx';
import CustomersListPage from '../pages/customers/CustomersListPage.jsx';
import CustomerDetailPage from '../pages/customers/CustomerDetailPage.jsx';
import EmployeesListPage from '../pages/employees/EmployeesListPage.jsx';
import EmployeeDetailPage from '../pages/employees/EmployeeDetailPage.jsx';
import TrucksListPage from '../pages/trucks/TrucksListPage.jsx';
import TruckDetailPage from '../pages/trucks/TruckDetailPage.jsx';
import CyclesListPage from '../pages/collection/CyclesListPage.jsx';
import BatchesListPage from '../pages/collection/BatchesListPage.jsx';
import BatchDetailPage from '../pages/collection/BatchDetailPage.jsx';
import InvoicesListPage from '../pages/financial/InvoicesListPage.jsx';
import InvoiceDetailPage from '../pages/financial/InvoiceDetailPage.jsx';
import BillingView from '../pages/financial/BillingView.jsx';
import DebtsView from '../pages/financial/DebtsView.jsx';
import CashoutsListPage from '../pages/financial/CashoutsListPage.jsx';
import ReportsPage from '../pages/reports/ReportsPage.jsx';
import CashoutDetailPage from '../pages/financial/CashoutDetailPage.jsx';
import ComplaintsListPage from '../pages/complaints/ComplaintsListPage.jsx';
import ComplaintDetailPage from '../pages/complaints/ComplaintDetailPage.jsx';
import UsersListPage from '../pages/users/UsersListPage.jsx';
import AccountSecurity from '../pages/account/AccountSecurity.jsx';
import RequireAuth from './RequireAuth.jsx';
import RequirePortalAuth from '../portal/RequirePortalAuth.jsx';
import PortalShell from '../portal/PortalShell.jsx';
import PortalLogin from '../portal/pages/PortalLogin.jsx';
import PortalForgotPassword from '../portal/pages/PortalForgotPassword.jsx';
import PortalResetPassword from '../portal/pages/PortalResetPassword.jsx';
import PortalDashboard from '../portal/pages/PortalDashboard.jsx';
import PortalCollections from '../portal/pages/PortalCollections.jsx';
import PortalCollectionDetail from '../portal/pages/collections/PortalCollectionDetail.jsx';
import PortalInvoices from '../portal/pages/PortalInvoices.jsx';
import PortalInvoiceDetail from '../portal/pages/PortalInvoiceDetail.jsx';
import PortalPayments from '../portal/pages/PortalPayments.jsx';
import PortalAccountProfile from '../portal/pages/account/PortalAccountProfile.jsx';
import PortalAccountSecurity from '../portal/pages/account/PortalAccountSecurity.jsx';
import PortalNotifications from '../portal/pages/notifications/PortalNotifications.jsx';
import PortalComplaints from '../portal/pages/complaints/PortalComplaints.jsx';
import PortalComplaintDetail from '../portal/pages/complaints/PortalComplaintDetail.jsx';
import PortalComplaintSubmit from '../portal/pages/complaints/PortalComplaintSubmit.jsx';
// Field Collector Mobile — a fully separate route tree, outside the staff
// desktop AppShell (its own mobile-first shell), reusing the existing
// staff AuthContext/JWT exactly as-is (NOT a new auth system, unlike the
// Customer Portal's own separate identity system above).
import CollectorApp from '../collector/CollectorApp.jsx';
import CollectorRequireAuth from '../collector/CollectorRequireAuth.jsx';
import CollectorShell from '../collector/CollectorShell.jsx';
import CollectorLoginScreen from '../collector/screens/LoginScreen.jsx';
import CollectorAssignmentsScreen from '../collector/screens/AssignmentsScreen.jsx';
import CollectorCustomerDetailScreen from '../collector/screens/CustomerDetailScreen.jsx';
import CollectorCollectionActionScreen from '../collector/screens/CollectionActionScreen.jsx';
import CollectorSyncCenterScreen from '../collector/screens/SyncCenterScreen.jsx';
import CollectorAccountScreen from '../collector/screens/AccountScreen.jsx';

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
      { path: 'reports', element: <ReportsPage /> },
      { path: 'billing', element: <BillingView /> },
      { path: 'complaints', element: <ComplaintsListPage /> },
      { path: 'complaints/:id', element: <ComplaintDetailPage /> },
      { path: 'users', element: <UsersListPage /> },
      { path: 'audit', element: <AuditCenterListPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'account/security', element: <AccountSecurity /> },
      { path: 'notifications', element: <NotificationsListPage /> },
      { path: 'calendar', element: <CalendarPage /> },
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
          { index: true, element: <CollectorAssignmentsScreen /> },
          { path: 'customer/:batchId/:customerId', element: <CollectorCustomerDetailScreen /> },
          { path: 'action/:batchId/:customerId', element: <CollectorCollectionActionScreen /> },
          { path: 'sync', element: <CollectorSyncCenterScreen /> },
          { path: 'account', element: <CollectorAccountScreen /> },
        ],
      },
    ],
  },
]);
