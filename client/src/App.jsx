import React, { Suspense } from 'react';
import { RouterProvider } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/queryClient.js';
import { AuthProvider } from './auth/AuthContext.jsx';
import { PortalAuthProvider } from './portal/PortalAuthContext.jsx';
import { ToastProvider } from './components/ui/index.js';
import { router } from './routes/router.jsx';
import { useDynamicBranding } from './hooks/useDynamicBranding.js';
import { I18nProvider } from './i18n/I18nContext.jsx';

// User-requested: browser tab title/favicon reflect the real company
// branding everywhere, including the login screen, not just once logged
// in. A separate inner component because useDynamicBranding() calls
// useQuery, which needs to render INSIDE QueryClientProvider's context,
// not in App() itself (App() only returns that provider, it isn't a
// descendant of it).
function DynamicBrandingEffect() {
  useDynamicBranding();
  return null;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <DynamicBrandingEffect />
        <AuthProvider>
          {/* Phase 4 — Customer Portal: its own auth context, structurally
              separate from staff AuthProvider (OD-1) — a distinct token store,
              a distinct login/logout flow, no shared identity. */}
          <PortalAuthProvider>
            <ToastProvider>
              <Suspense fallback={<div style={{ minHeight: '100vh', background: 'var(--bg)' }} />}>
                <RouterProvider router={router} />
              </Suspense>
            </ToastProvider>
          </PortalAuthProvider>
        </AuthProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
