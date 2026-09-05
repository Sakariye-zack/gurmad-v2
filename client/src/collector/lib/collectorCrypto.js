// Field Collector Mobile — Implementation Spec §9. Web Crypto encryption,
// key held IN MEMORY ONLY (a module-level variable) — never written to
// localStorage/sessionStorage/IndexedDB. A page reload or browser restart
// loses this key by design (locked, not a defect) — see §9's orphaned-entry
// handling in collectorStore.js.

let memoryKey = null; // CryptoKey | null
let memoryKeyUsername = null; // the username the current key was derived for — identity guard for rotation

export function hasKey() {
  return memoryKey !== null;
}

function decodeUsernameFromToken(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.username || null;
  } catch {
    return null;
  }
}

// Derived at login/reauthentication from the JWT itself — a secret bearer
// credential, never independently guessable — NOT from any public
// identifier such as username alone (an earlier draft of this fix tried
// that and was reverted: a username is not secret, so a key derivable from
// it alone would be guessable without ever holding a valid token, defeating
// the entire point of encrypting data a lost/stolen device might expose).
export async function deriveKeyFromToken(token) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(token), 'PBKDF2', false, ['deriveKey']);
  memoryKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('gurmad-v2-collector-mobile'), iterations: 100000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  memoryKeyUsername = decodeUsernameFromToken(token);
  return memoryKey;
}

// Hardening H-FC-1 (P1): a fresh JWT is minted on every login/reauth — even
// for the SAME collector re-authenticating (iat/exp differ token-to-token) —
// so a plain deriveKeyFromToken() call on reauth produces a DIFFERENT key
// than the one that encrypted the pre-reauth queue, silently orphaning the
// very queue Decision 2 requires reauthentication to PRESERVE.
//
// Fix: an in-memory-only key ROTATION. The OLD key (still held in memory,
// itself never persisted or guessable) is used to decrypt existing rows;
// they are re-encrypted under the NEW key; only then is the old key
// discarded. Gated on identity: rotation is performed ONLY when the
// reauthenticating username matches the username the current key belongs
// to — if a DIFFERENT collector authenticates on the same device, no
// carry-forward occurs and the prior collector's entries remain correctly
// orphaned (never decryptable by the new collector's key), preserving the
// original cross-collector isolation guarantee exactly.
export async function deriveKeyForReauth(token, reencryptCallback) {
  const newUsername = decodeUsernameFromToken(token);
  const sameCollector = memoryKey !== null && newUsername !== null && newUsername === memoryKeyUsername;
  const oldKey = memoryKey;

  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey('raw', enc.encode(token), 'PBKDF2', false, ['deriveKey']);
  const newKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('gurmad-v2-collector-mobile'), iterations: 100000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );

  if (sameCollector && reencryptCallback) {
    await reencryptCallback(
      (blob) => decryptWithKey(oldKey, blob),
      (obj) => encryptWithKey(newKey, obj)
    );
  }

  memoryKey = newKey;
  memoryKeyUsername = newUsername;
  return newKey;
}

export function discardKey() {
  memoryKey = null;
  memoryKeyUsername = null;
}

async function encryptWithKey(key, plainObject) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const data = enc.encode(JSON.stringify(plainObject));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: Array.from(iv), cipher: Array.from(new Uint8Array(cipher)) };
}

async function decryptWithKey(key, { iv, cipher }) {
  if (!key) return null;
  try {
    const dec = new TextDecoder();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      new Uint8Array(cipher)
    );
    return JSON.parse(dec.decode(plain));
  } catch {
    return null;
  }
}

export async function encryptValue(plainObject) {
  if (!memoryKey) throw new Error('No encryption key available.');
  return encryptWithKey(memoryKey, plainObject);
}

// Returns null (never throws to the caller) if decryption fails — the
// caller treats this as "orphaned" per §9, not a crash.
export async function decryptValue(blob) {
  return decryptWithKey(memoryKey, blob);
}
