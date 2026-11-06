import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiClient, AUTH_GATE_EVENT } from '../lib/apiClient.js';

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

  // Account security — merge server-side flags (must_change_password,
  // must_enroll_2fa, ...) into the stored user, so the route guards can
  // force the Change Password screen / the 2FA enrolment page.
  const updateUser = useCallback((patch) => {
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      localStorage.setItem('gurmad_v2_user', JSON.stringify(next));
      return next;
    });
  }, []);

  const refreshSecurityStatus = useCallback(async () => {
    if (!apiClient.getToken()) return null;
    try {
      const res = await apiClient.get('/v2/auth/security-status');
      const { must_change_password, must_enroll_2fa, two_factor_required } = res.data || {};
      updateUser({ must_change_password: !!must_change_password, must_enroll_2fa: !!must_enroll_2fa, two_factor_required: !!two_factor_required });
      return res.data;
    } catch {
      return null; // offline / legacy token — keep whatever we had
    }
  }, [updateUser]);

  // Clears this device's session locally only (no server call).
  const clearLocalSession = useCallback(() => {
    apiClient.clearToken();
    localStorage.removeItem('gurmad_v2_user');
    setUser(null);
  }, []);

  // A page reload (or a session that predates this feature) still learns
  // about a pending gate — the login response alone isn't enough.
  // (The state update happens after the network round-trip, not
  // synchronously in the effect.)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (user) refreshSecurityStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onGate = (e) => {
      const code = e.detail?.code;
      if (code === 'PASSWORD_CHANGE_REQUIRED') updateUser({ must_change_password: true });
      else if (code === 'TWO_FACTOR_REQUIRED') updateUser({ must_enroll_2fa: true });
      else if (code === 'SESSION_REVOKED') {
        // The collector app keeps its own 401 -> re-authenticate flow,
        // which preserves the encrypted offline queue; dropping the
        // session here would orphan it.
        if (window.location.pathname.startsWith('/collector')) return;
        clearLocalSession();
      }
    };
    window.addEventListener(AUTH_GATE_EVENT, onGate);
    return () => window.removeEventListener(AUTH_GATE_EVENT, onGate);
  }, [updateUser, clearLocalSession]);

  const login = async (username, password, token) => {
    setLoading(true);
    try {
      let flat;
      try {
        const v2 = await apiClient.post('/v2/auth/login', { username, password });
        // Two-Factor Authentication (user-requested), V2-native — distinct
        // from the legacy backend's own require2FA/userId shape below (a
        // different, pre-existing mechanism this must not disturb). No
        // token is issued yet; the caller gets only a short-lived
        // pendingToken and must complete verifyTwoFactorLogin() next.
        if (v2.data.requires2FA) return { requiresV2TwoFA: true, pendingToken: v2.data.pendingToken };
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
      // `user` included directly (not just relying on the caller re-reading
      // useAuth().user right after) — React state updates from setUser()
      // above aren't guaranteed visible in the same synchronous callback
      // that called login(), so a caller needing the just-logged-in role
      // immediately (Login.jsx's own post-login redirect, Phase 10) would
      // otherwise read a stale value.
      return { success: true, user: safeUser };
    } finally {
      setLoading(false);
    }
  };

  // Completes a V2-native 2FA login (see `requiresV2TwoFA` above) — the
  // pendingToken proves the password step already succeeded; this
  // exchanges it plus a live/backup code for a real session token.
  const verifyTwoFactorLogin = async (pendingToken, code) => {
    setLoading(true);
    try {
      const v2 = await apiClient.post('/v2/auth/2fa/verify-login', { pendingToken, code });
      const flat = { token: v2.data.token, ...v2.data.user };
      apiClient.setToken(flat.token);
      const { token: _t, ...safeUser } = flat;
      localStorage.setItem('gurmad_v2_user', JSON.stringify(safeUser));
      setUser(safeUser);
      return { success: true, user: safeUser };
    } finally {
      setLoading(false);
    }
  };

  // Revokes this device's server session (best-effort — the request
  // captures the token before it is cleared locally), then clears it.
  const logout = () => {
    if (apiClient.getToken()) apiClient.post('/v2/auth/logout', {}).catch(() => {});
    clearLocalSession();
  };

  return (
    <AuthContext.Provider value={{ user, login, verifyTwoFactorLogin, logout, loading, isAuthenticated: !!user, updateUser, refreshSecurityStatus }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
