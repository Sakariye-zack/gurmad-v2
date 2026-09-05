// Field Collector Mobile — Implementation Spec §8/§9. IndexedDB-backed local
// store for exactly two categories of data (nothing else, per the locked
// allow-list): the offline action queue, and the cached Assignments
// response. Every stored value is encrypted (collectorCrypto.js) before
// being written; nothing here ever persists plaintext protected data.

import { encryptValue, decryptValue } from './collectorCrypto.js';

const DB_NAME = 'gurmad-collector-mobile';
const DB_VERSION = 1;
const QUEUE_STORE = 'queue';
const CACHE_STORE = 'cache'; // single row, key 'assignments'

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'action_uuid' });
      }
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = fn(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

// ---------- Queue ----------

// entry: { action_uuid, action_type, captured_at, batch_id, customer_id,
//          task_id, status, reason, note, lat, lng, photo_blob_ref,
//          sync_state, last_outcome }
export async function addQueueEntry(entry) {
  const encrypted = await encryptValue(entry);
  return withStore(QUEUE_STORE, 'readwrite', (store) => {
    store.put({ action_uuid: entry.action_uuid, encrypted });
  });
}

export async function updateQueueEntryOutcome(action_uuid, sync_state, last_outcome) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    const store = tx.objectStore(QUEUE_STORE);
    const getReq = store.get(action_uuid);
    getReq.onsuccess = async () => {
      const row = getReq.result;
      if (!row) return resolve(null);
      const plain = await decryptValue(row.encrypted);
      if (!plain) return resolve(null); // orphaned — nothing to update
      plain.sync_state = sync_state;
      plain.last_outcome = last_outcome;
      const encrypted = await encryptValue(plain);
      store.put({ action_uuid, encrypted });
      resolve(plain);
    };
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => {};
  });
}

export async function removeQueueEntry(action_uuid) {
  return withStore(QUEUE_STORE, 'readwrite', (store) => store.delete(action_uuid));
}

// Returns { entries: [...decrypted], orphanedCount } — an orphaned row
// (undecryptable under the current key) is never silently deleted; it is
// reported so the UI can surface the §9-required recovery prompt.
export async function getAllQueueEntries() {
  const db = await openDb();
  const rows = await new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readonly');
    const store = tx.objectStore(QUEUE_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const entries = [];
  let orphanedCount = 0;
  for (const row of rows) {
    const plain = await decryptValue(row.encrypted);
    if (plain) entries.push(plain);
    else orphanedCount += 1;
  }
  // Oldest-captured-first, per §11's locked processing order.
  entries.sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
  return { entries, orphanedCount };
}

export async function clearOrphanedEntries() {
  const { orphanedCount } = await getAllQueueEntries();
  if (orphanedCount === 0) return 0;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    const store = tx.objectStore(QUEUE_STORE);
    const req = store.getAll();
    req.onsuccess = async () => {
      let removed = 0;
      for (const row of req.result) {
        const plain = await decryptValue(row.encrypted);
        if (!plain) { store.delete(row.action_uuid); removed += 1; }
      }
      resolve(removed);
    };
    req.onerror = () => reject(req.error);
  });
}

// ---------- Assignment cache (single entry) ----------

export async function setCachedAssignments(data) {
  const encrypted = await encryptValue({ data, fetchedAt: new Date().toISOString() });
  return withStore(CACHE_STORE, 'readwrite', (store) => {
    store.put({ key: 'assignments', encrypted });
  });
}

// Returns { data, fetchedAt } or null if absent/undecryptable (the caller
// must then re-fetch fresh from the server — assignments are always safely
// reconstructable online, unlike unsynced queue entries, per §9).
export async function getCachedAssignments() {
  const db = await openDb();
  const row = await new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, 'readonly');
    const store = tx.objectStore(CACHE_STORE);
    const req = store.get('assignments');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!row) return null;
  return decryptValue(row.encrypted);
}

// ---------- Key rotation (Hardening H-FC-1) ----------

// Re-encrypts every row in both stores using the supplied decrypt/encrypt
// functions (bound to the OLD and NEW keys respectively by
// collectorCrypto.deriveKeyForReauth). A row that the OLD key itself can't
// decrypt (already-orphaned before this reauth) is left untouched — this
// routine only carries forward what was genuinely readable a moment ago,
// never invents recovery of already-lost data.
export async function reencryptAllRows(decryptWithOld, encryptWithNew) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, 'readwrite');
    const store = tx.objectStore(QUEUE_STORE);
    const req = store.getAll();
    req.onsuccess = async () => {
      for (const row of req.result) {
        const plain = await decryptWithOld(row.encrypted);
        if (plain) store.put({ action_uuid: row.action_uuid, encrypted: await encryptWithNew(plain) });
      }
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    const store = tx.objectStore(CACHE_STORE);
    const req = store.get('assignments');
    req.onsuccess = async () => {
      const row = req.result;
      if (row) {
        const plain = await decryptWithOld(row.encrypted);
        if (plain) store.put({ key: 'assignments', encrypted: await encryptWithNew(plain) });
      }
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

// ---------- Purge (logout, §6.8) ----------

export async function purgeAllLocalData() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([QUEUE_STORE, CACHE_STORE], 'readwrite');
    tx.objectStore(QUEUE_STORE).clear();
    tx.objectStore(CACHE_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
