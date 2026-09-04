import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

// Same guard logic as routes/RequireAuth.jsx (that shared file is not
// modified) — redirects to the Collector Mobile's own login route instead
// of the desktop /login, since this route tree has its own entry screen.
export default function CollectorRequireAuth({ children }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/collector/login" replace />;
  return children;
}
