import React from 'react';
import { Navigate } from 'react-router-dom';
import { usePortalAuth } from './PortalAuthContext.jsx';

export default function RequirePortalAuth({ children }) {
  const { isAuthenticated } = usePortalAuth();
  if (!isAuthenticated) return <Navigate to="/portal/login" replace />;
  return children;
}
