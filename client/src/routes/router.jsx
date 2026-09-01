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
import CashoutDetailPage from '../pages/financial/CashoutDetailPage.jsx';
import RequireAuth from './RequireAuth.jsx';

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
      { path: 'billing', element: <BillingView /> },
    ],
  },
]);
