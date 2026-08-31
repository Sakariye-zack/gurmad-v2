import { useAuth } from '../auth/AuthContext.jsx';

// Frontend_Architecture.md §2: one implementation of "what zone am I scoped
// to" — not a req.user.zone string check copy-pasted per page/component the
// way the current backend does today (the exact pattern DR-2 flags for
// FK-hardening on the backend; the frontend gets the same single-source-of-
// truth treatment here).
export function useCurrentZone() {
  const { user } = useAuth();
  const isZoneScoped = user && ['gudoomiye', 'zone_accountant'].includes((user.role || '').toLowerCase());
  return {
    zone: isZoneScoped ? user.zone : null,
    isZoneScoped: !!isZoneScoped,
    isGlobal: !isZoneScoped,
  };
}
