import React from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Users, ClipboardList, Receipt } from 'lucide-react';
import AppShell from '../layout/AppShell.jsx';
import Login from '../pages/Login.jsx';
import Dashboard from '../pages/Dashboard.jsx';
import PlaceholderPage from '../pages/PlaceholderPage.jsx';
import ZonesListPage from '../pages/zones/ZonesListPage.jsx';
import ZoneDetailPage from '../pages/zones/ZoneDetailPage.jsx';
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
      { path: 'customers', element: <PlaceholderPage icon={Users} title="Customers" subtitle="Residential + Commercial" /> },
      { path: 'zones', element: <ZonesListPage /> },
      { path: 'zones/:id', element: <ZoneDetailPage /> },
      { path: 'collection-cycles', element: <PlaceholderPage icon={ClipboardList} title="Collection Cycles" /> },
      { path: 'billing', element: <PlaceholderPage icon={Receipt} title="Billing & Invoices" /> },
    ],
  },
]);
