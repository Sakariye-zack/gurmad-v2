import React, { createContext, useContext, useState } from 'react';
import { apiClient } from '../lib/apiClient.js';

// V2 Foundation reuses the existing, already-frozen T2.8-F auth backend
// (POST /api/auth/login) as-is — validated business/RBAC logic, not
// reimplemented. See Phase 1 Foundation plan, item 5.
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('gurmad_v2_user');
    return saved ? JSON.parse(saved) : null;
  });
  const [loading, setLoading] = useState(false);

  const login = async (username, password, token) => {
    setLoading(true);
    try {
      const data = await apiClient.post('/auth/login', { username, password, token });
      if (data.require2FA) return { require2FA: true, userId: data.userId };
      apiClient.setToken(data.token);
      const { token: _t, ...safeUser } = data;
      localStorage.setItem('gurmad_v2_user', JSON.stringify(safeUser));
      setUser(safeUser);
      return { success: true };
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    apiClient.clearToken();
    localStorage.removeItem('gurmad_v2_user');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, loading, isAuthenticated: !!user }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
