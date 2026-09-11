// Field Collector Mobile — Implementation Spec §10/§11. The offline action
// queue and its sync engine. Reuses the CLOSED, unmodified
// POST /api/v2/collection-sync/replay endpoint exactly as-is — no second
// sync engine, no duplicated status-transition logic (that lives entirely
// server-side in applyBatchCustomerStatusChange, untouched).
import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../../lib/apiClient.js';
import {
  addQueueEntry, getAllQueueEntries, removeQueueEntry, updateQueueEntryOutcome, updateQueueEntryFields, clearOrphanedEntries,
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
  //
  // photoBase64/photoMime (Phase 10 Gap Audit follow-up — collector photo
  // capture): the queue entry's own schema comment already anticipated a
  // photo_blob_ref field; stored here as base64 (not a raw Blob) because
  // it passes through the exact same JSON.stringify-then-AES-GCM-encrypt
  // path (collectorCrypto.js's encryptValue) every other field already
  // uses — a Blob cannot survive JSON.stringify, and adding a SEPARATE
  // IndexedDB object store just for binary photo data would duplicate the
  // orphaned-entry/encryption-key-rotation handling collectorStore.js
  // already solves once for the whole queue. photo_state starts 'pending'
  // when a photo is present, null when it isn't — trySync() below uploads
  // it only once the matching status-change action has itself been
  // accepted server-side (POST /collection-sync/photo requires that).
  const captureAction = useCallback(async ({ batchId, customerId, taskId, status, reason, note, lat, lng, photoBase64, photoMime }) => {
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
      photo_base64: photoBase64 || null,
      photo_mime: photoMime || null,
      photo_state: photoBase64 ? 'pending' : null,
    };
    await addQueueEntry(entry);
    await reloadFromStore();
    if (navigator.onLine) trySync();
    return action_uuid;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadFromStore]);

  // Decode a base64 string back into a Blob for the multipart upload —
  // the inverse of what CollectionActionScreen.jsx encodes from the
  // canvas capture.
  function base64ToBlob(base64, mime) {
    const byteChars = atob(base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    return new Blob([new Uint8Array(byteNumbers)], { type: mime });
  }

  // Uploads one queued entry's pending photo via the Phase 10
  // POST /collection-sync/photo endpoint. Best-effort and independently
  // retryable from the status-change sync above — a photo upload failure
  // (network blip, server error) never re-queues or blocks the already-
  // accepted status change; it simply stays 'pending' and is retried on
  // the next trySync() pass, same retry model as a 'technical_error'
  // status-change outcome.
  const uploadPendingPhoto = useCallback(async (entry) => {
    try {
      const blob = base64ToBlob(entry.photo_base64, entry.photo_mime || 'image/jpeg');
      const formData = new FormData();
      formData.append('action_uuid', entry.action_uuid);
      formData.append('photo', blob, 'visit.jpg');
      await apiClient.uploadFile('/v2/collection-sync/photo', formData);
      await updateQueueEntryFields(entry.action_uuid, { photo_state: 'uploaded', photo_base64: null });
    } catch (err) {
      // A 409 (already recorded, or the status-change wasn't 'serviced')
      // is not retryable — anything else (network/5xx) is left 'pending'
      // for the next sync pass.
      if (err.status === 409 || err.status === 400) {
        await updateQueueEntryFields(entry.action_uuid, { photo_state: 'failed', photo_base64: null });
      }
      // else: leave photo_state 'pending' untouched — retried next pass.
    }
  }, []);

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
          // Only a freshly-'accepted' Serviced visit can have its photo
          // uploaded — 'already_applied' on a prior sync already handled
          // (or already attempted) its own photo, and a rejected outcome
          // has no accepted visit for the photo to attach to.
          if (result.outcome === 'accepted') {
            const entry = toSend.find((e) => e.action_uuid === result.action_uuid);
            if (entry && entry.photo_state === 'pending') {
              await uploadPendingPhoto(entry);
            }
          }
        } else if (result.outcome === 'technical_error') {
          // Retryable — held for the next trigger, not looped immediately.
          await updateQueueEntryOutcome(result.action_uuid, 'captured', 'technical_error');
        }
        // 'requires_reauthentication' cannot occur per-action within an
        // already-accepted request (Offline/Sync's own request-level
        // enforcement) — handled by the 401 catch branch below instead.
      }
      // Sweep for any earlier-accepted entry whose photo upload didn't
      // finish last time (a network blip, mid-upload) — retried here
      // rather than only at the moment of its own status-change accept.
      const stillPending = pending.filter((e) => e.sync_state === 'synced_terminal' && e.last_outcome === 'accepted' && e.photo_state === 'pending');
      for (const entry of stillPending) {
        await uploadPendingPhoto(entry);
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
