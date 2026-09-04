// Field Collector Mobile — Implementation Spec §10/§11. The offline action
// queue and its sync engine. Reuses the CLOSED, unmodified
// POST /api/v2/collection-sync/replay endpoint exactly as-is — no second
// sync engine, no duplicated status-transition logic (that lives entirely
// server-side in applyBatchCustomerStatusChange, untouched).
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../lib/apiClient.js';
import {
  addQueueEntry, getAllQueueEntries, removeQueueEntry, updateQueueEntryOutcome, clearOrphanedEntries,
} from '../lib/collectorStore.js';

// Locked outcome vocabulary (§9 of Decisions) — never renamed/expanded here.
const TERMINAL_OUTCOMES = new Set(['accepted', 'already_applied', 'rejected_stale', 'rejected_invalid_state']);

function makeUuid() {
  // Native, no new dependency — every evergreen browser Decision 1's PWA
  // platform targets supports this.
  return crypto.randomUUID();
}

export function useSyncQueue({ onRequiresReauth, onStaleOrInvalid } = {}) {
  const [entries, setEntries] = useState([]);
  const [orphanedCount, setOrphanedCount] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const reloadFromStore = useCallback(async () => {
    const { entries: e, orphanedCount: o } = await getAllQueueEntries();
    setEntries(e);
    setOrphanedCount(o);
  }, []);

  useEffect(() => { reloadFromStore(); }, [reloadFromStore]);

  // §14 — capture a new action. Always queue-then-sync, identical code path
  // online or offline (Spec §14's own deliberate simplification).
  const captureAction = useCallback(async ({ batchId, customerId, taskId, status, reason, note, lat, lng }) => {
    const action_uuid = makeUuid();
    const entry = {
      action_uuid,
      action_type: 'batch_customer.status_change',
      captured_at: new Date().toISOString(),
      batch_id: batchId,
      customer_id: customerId,
      task_id: taskId,
      status,
      reason: reason || null,
      note: note || null,
      lat: lat ?? null,
      lng: lng ?? null,
      sync_state: 'captured',
      last_outcome: null,
    };
    await addQueueEntry(entry);
    await reloadFromStore();
    if (navigator.onLine) trySync();
    return action_uuid;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadFromStore]);

  // §11 — one /replay call per sync attempt, oldest-first (already sorted
  // by getAllQueueEntries), per-action outcome handling.
  const trySync = useCallback(async () => {
    if (syncing) return;
    const { entries: pending } = await getAllQueueEntries();
    const toSend = pending.filter((e) => e.sync_state !== 'synced_terminal');
    if (toSend.length === 0) return;
    setSyncing(true);
    try {
      const actions = toSend.map((e) => ({
        action_uuid: e.action_uuid,
        action_type: e.action_type,
        batch_id: e.batch_id,
        customer_id: e.customer_id,
        task_id: e.task_id,
        status: e.status,
        reason: e.reason,
        note: e.note,
        lat: e.lat,
        lng: e.lng,
      }));
      const res = await apiClient.post('/v2/collection-sync/replay', { actions });
      for (const result of res.results) {
        if (TERMINAL_OUTCOMES.has(result.outcome)) {
          await updateQueueEntryOutcome(result.action_uuid, 'synced_terminal', result.outcome);
          if (result.outcome === 'rejected_stale' || result.outcome === 'rejected_invalid_state') {
            onStaleOrInvalid && onStaleOrInvalid();
          }
        } else if (result.outcome === 'technical_error') {
          // Retryable — held for the next trigger, not looped immediately.
          await updateQueueEntryOutcome(result.action_uuid, 'captured', 'technical_error');
        }
        // 'requires_reauthentication' cannot occur per-action within an
        // already-accepted request (Offline/Sync's own request-level
        // enforcement) — handled by the 401 catch branch below instead.
      }
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        // Entire batch blocked — queue untouched, per §17/Decision 2.
        onRequiresReauth && onRequiresReauth();
      }
      // A network-level failure here leaves every entry at 'captured' —
      // safe to retry on the next trigger; the server's own idempotency
      // (action_uuid) protects against a partially-delivered request being
      // re-sent (§27).
    } finally {
      setSyncing(false);
      await reloadFromStore();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing, onRequiresReauth, onStaleOrInvalid, reloadFromStore]);

  // Trigger on network restoration — no polling.
  useEffect(() => {
    const onOnline = () => trySync();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trySync]);

  const dismissTerminalEntry = useCallback(async (action_uuid) => {
    await removeQueueEntry(action_uuid);
    await reloadFromStore();
  }, [reloadFromStore]);

  const dismissOrphaned = useCallback(async () => {
    await clearOrphanedEntries();
    await reloadFromStore();
  }, [reloadFromStore]);

  const activeCount = entries.filter((e) => e.sync_state !== 'synced_terminal' || !TERMINAL_OUTCOMES.has(e.last_outcome)).length;

  return { entries, orphanedCount, syncing, activeCount, captureAction, trySync, dismissTerminalEntry, dismissOrphaned, reloadFromStore };
}
