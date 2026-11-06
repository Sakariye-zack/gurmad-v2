import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import ForcedPasswordChange from '../components/ForcedPasswordChange.jsx';
import { deriveKeyForReauth } from './lib/collectorCrypto.js';
import { reencryptAllRows } from './lib/collectorStore.js';

// Same guard logic as routes/RequireAuth.jsx — redirects to the Collector
// Mobile's own login route instead of the desktop /login, since this
// route tree has its own entry screen.
//
// Account security: an admin-created/reset collector account must set its
// own password first (the server answers 403 PASSWORD_CHANGE_REQUIRED to
// everything else). The password change returns a fresh token, so the
// in-memory offline-store key is rotated to it (same mechanism as
// re-authentication — any queued rows are carried forward).
export default function CollectorRequireAuth({ children }) {
  const { isAuthenticated, user } = useAuth();
  if (!isAuthenticated) return <Navigate to="/collector/login" replace />;
  if (user?.must_change_password) {
    return <ForcedPasswordChange onTokenChanged={(token) => deriveKeyForReauth(token, reencryptAllRows)} />;
  }
  return children;
}
