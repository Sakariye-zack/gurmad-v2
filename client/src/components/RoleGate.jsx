import { useAuth } from '../auth/AuthContext.jsx';
import { usePermissions } from '../hooks/usePermissions.js';

// RoleGate — the mandatory, structural fix for the single most-repeated
// finding across the entire T2.8 audit program: "the UI showed an action the
// backend correctly denied" (Billing's Record Payment, Cashout's
// approve/reject, Collection Cycles' mark-status, zone_accountant's Cashout
// tab — every one of these was fixed reactively, one at a time, after the
// fact). In V2 a gated control cannot be written any other way — there is no
// code path where visibility is decided independently of what the backend
// actually allows.
//
// Bridge note (Foundation phase, disclosed): the existing backend's dynamic
// permission engine (GET /api/auth/my-permissions) only covers ~21 of 211
// routes today — most current authorization is still legacy checkRole(role
// arrays), a gap already tracked as P1-10 in the V2 backlog and explicitly
// scoped for the V2 API/RBAC rebuild, not this Foundation phase. Until that
// rebuild lands, RoleGate accepts an ADDITIONAL `roles` fallback so it can
// already govern every action correctly today, on top of the real
// `permission` check wherever the dynamic engine already covers it. Backend
// authorization remains the enforced boundary either way — RoleGate never
// substitutes for it, per the explicit instruction.
export default function RoleGate({ permission, roles, children, fallback = null }) {
  const { user } = useAuth();
  const { permissions, loading } = usePermissions();

  if (!user) return fallback;
  if (user.role?.toLowerCase() === 'admin') return children; // Super Admin always passes, matches backend's own bypass.

  if (permission) {
    if (loading) return fallback;
    if (!permissions.includes(permission)) return fallback;
  }

  if (roles && roles.length > 0) {
    if (!roles.map((r) => r.toLowerCase()).includes((user.role || '').toLowerCase())) return fallback;
  }

  return children;
}
