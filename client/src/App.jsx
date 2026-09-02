import React from 'react';
import { RouterProvider } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient.js';
import { AuthProvider } from './auth/AuthContext.jsx';
import { PortalAuthProvider } from './portal/PortalAuthContext.jsx';
import { ToastProvider } from './components/ui/index.js';
import { router } from './routes/router.jsx';

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        {/* Phase 4 — Customer Portal: its own auth context, structurally
            separate from staff AuthProvider (OD-1) — a distinct token store,
            a distinct login/logout flow, no shared identity. */}
        <PortalAuthProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </PortalAuthProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
