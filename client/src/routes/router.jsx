import React from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import AppShell from '../layout/AppShell.jsx';
import Login from '../pages/Login.jsx';
import Dashboard from '../pages/Dashboard.jsx';
import ZonesListPage from '../pages/zones/ZonesListPage.jsx';
import ZoneDetailPage from '../pages/zones/ZoneDetailPage.jsx';
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
import RequireAuth from './RequireAuth.jsx';
import RequirePortalAuth from '../portal/RequirePortalAuth.jsx';
import PortalShell from '../portal/PortalShell.jsx';
import PortalLogin from '../portal/pages/PortalLogin.jsx';
import PortalForgotPassword from '../portal/pages/PortalForgotPassword.jsx';
import PortalResetPassword from '../portal/pages/PortalResetPassword.jsx';
import PortalDashboard from '../portal/pages/PortalDashboard.jsx';
import PortalCollections from '../portal/pages/PortalCollections.jsx';
import PortalInvoices from '../portal/pages/PortalInvoices.jsx';
import PortalInvoiceDetail from '../portal/pages/PortalInvoiceDetail.jsx';
import PortalPayments from '../portal/pages/PortalPayments.jsx';
import PortalProfile from '../portal/pages/PortalProfile.jsx';

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
      { path: 'invoices', element: <PortalInvoices /> },
      { path: 'invoices/:id', element: <PortalInvoiceDetail /> },
      { path: 'payments', element: <PortalPayments /> },
      { path: 'profile', element: <PortalProfile /> },
    ],
  },
]);
