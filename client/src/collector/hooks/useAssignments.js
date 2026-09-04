// Field Collector Mobile — Implementation Spec §13. Wraps the CLOSED,
// unmodified GET /api/v2/collection-sync/my-assignments endpoint with a
// local encrypted cache. Refresh occurs ONLY at the 3 locked triggers:
// login, post-reauth-reconnect, and manual — never background polling.
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../lib/apiClient.js';
import { getCachedAssignments, setCachedAssignments } from '../lib/collectorStore.js';
import { hasKey } from '../lib/collectorCrypto.js';

export function useAssignments() {
  const [data, setData] = useState(null); // { batches: [...] }
  const [fetchedAt, setFetchedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  const loadFromCache = useCallback(async () => {
    if (!hasKey()) return false; // no key -> nothing decryptable, caller must fetch fresh
    const cached = await getCachedAssignments();
    if (cached) {
      setData(cached.data);
      setFetchedAt(cached.fetchedAt);
      return true;
    }
    return false;
  }, []);

  // One of the 3 locked triggers — call explicitly, never on a timer.
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.get('/v2/collection-sync/my-assignments');
      setData(res.data);
      setFetchedAt(new Date().toISOString());
      await setCachedAssignments(res.data);
      setIsOffline(false);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        // requires_reauthentication — surfaced by the caller (AssignmentsScreen),
        // which routes to the Reauthentication flow. Fall back to cache so the
        // collector isn't left with a blank screen while re-authenticating.
        setError({ type: 'auth', message: err.message });
        await loadFromCache();
      } else {
        // Network/technical failure while an online fetch was expected —
        // fall back to cache, mark offline-equivalent state.
        setError({ type: 'network', message: err.message });
        const hadCache = await loadFromCache();
        setIsOffline(true);
        if (!hadCache) setData({ batches: [] });
      }
    } finally {
      setLoading(false);
    }
  }, [loadFromCache]);

  // Trigger 1: on mount (component's own "login" entry, since this hook is
  // only ever mounted within the authenticated Collector route tree).
  useEffect(() => {
    (async () => {
      if (navigator.onLine) {
        await refresh();
      } else {
        setIsOffline(true);
        const had = await loadFromCache();
        setLoading(false);
        if (!had) setData({ batches: [] });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return { data, fetchedAt, loading, error, isOffline, refresh, loadFromCache };
}
