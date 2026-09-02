import React, { createContext, useContext, useState } from 'react';
import { portalApiClient } from './apiClient.js';

const PORTAL_USER_KEY = 'gurmad_v2_portal_customer';

const PortalAuthContext = createContext(null);

export function PortalAuthProvider({ children }) {
  const [customer, setCustomer] = useState(() => {
    const saved = localStorage.getItem(PORTAL_USER_KEY);
    return saved ? JSON.parse(saved) : null;
  });
  const [loading, setLoading] = useState(false);

  const login = async (phone, password) => {
    setLoading(true);
    try {
      const res = await portalApiClient.post('/auth/login', { phone, password });
      portalApiClient.setToken(res.data.token);
      localStorage.setItem(PORTAL_USER_KEY, JSON.stringify(res.data.customer));
      setCustomer(res.data.customer);
      return { success: true };
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    portalApiClient.clearToken();
    localStorage.removeItem(PORTAL_USER_KEY);
    setCustomer(null);
  };

  return (
    <PortalAuthContext.Provider value={{ customer, login, logout, loading, isAuthenticated: !!customer }}>
      {children}
    </PortalAuthContext.Provider>
  );
}

export function usePortalAuth() {
  const ctx = useContext(PortalAuthContext);
  if (!ctx) throw new Error('usePortalAuth must be used within PortalAuthProvider');
  return ctx;
}
