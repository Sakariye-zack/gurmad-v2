import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import ForcedPasswordChange from '../components/ForcedPasswordChange.jsx';

// Account security gates (server enforces the same with 403s):
//  - must_change_password -> the Change Password screen replaces the app
//  - must_enroll_2fa (admin/gudoomiye without 2FA) -> held on Account
//    Security until two-factor authentication is enabled
export default function RequireAuth({ children }) {
  const { isAuthenticated, user } = useAuth();
  const location = useLocation();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user?.must_change_password) return <ForcedPasswordChange />;
  if (user?.must_enroll_2fa && location.pathname !== '/account/security') {
    return <Navigate to="/account/security" replace />;
  }
  return children;
}
