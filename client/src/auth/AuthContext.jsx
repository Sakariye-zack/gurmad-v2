import React, { createContext, useContext, useState } from 'react';
import { apiClient } from '../lib/apiClient.js';

// V2 Foundation originally reused the existing, already-frozen T2.8-F
// auth backend (POST /api/auth/login) as-is for every login — correct at
// the time (Phase 1 Foundation plan, item 5, before any V2-native account
// existed). middleware/auth.js's own OD-1 Hybrid design has always
// verified tokens from EITHER backend identically, and routes/auth.js's
// own POST /v2/auth/login has existed since then too — but this file
// never actually called it. The practical effect (found live, Phase 10):
// a V2-native account (auth_source='v2' in v2_users — created via the
// Users & Access "Create User" page) could NEVER sign in through this
// app at all, regardless of a correct password, because every login
// attempt only ever reached the legacy backend's own, entirely separate
// user table.
//
// Fixed as the Hybrid design always implied: try V2's own login first;
// only on AUTH_SOURCE_LEGACY (409 — routes/auth.js's own explicit "not
// migrated yet" response, not a credential failure) fall back to the
// legacy backend. A wrong password on either path still surfaces as a
// normal login failure, not a fallback trigger. Response shapes differ
// (V2 nests under `data`, legacy is flat) - normalized to the one flat
// shape the rest of this file already expects, so nothing downstream of
// login() changes.
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
      let flat;
      try {
        const v2 = await apiClient.post('/v2/auth/login', { username, password });
        flat = { token: v2.data.token, ...v2.data.user };
      } catch (err) {
        if (err.code !== 'AUTH_SOURCE_LEGACY') throw err;
        flat = await apiClient.post('/auth/login', { username, password, token });
      }
      if (flat.require2FA) return { require2FA: true, userId: flat.userId };
      apiClient.setToken(flat.token);
      const { token: _t, ...safeUser } = flat;
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
