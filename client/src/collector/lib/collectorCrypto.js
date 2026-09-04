// Field Collector Mobile — Implementation Spec §9. Web Crypto encryption,
// key held IN MEMORY ONLY (a module-level variable) — never written to
// localStorage/sessionStorage/IndexedDB. A page reload or browser restart
// loses this key by design (locked, not a defect) — see §9's orphaned-entry
// handling in collectorStore.js.

let memoryKey = null; // CryptoKey | null

export function hasKey() {
  return memoryKey !== null;
}

// Derived at login/reauthentication from a value only available for the
// duration of a genuinely fresh, current authentication event (the JWT
// itself) — never from anything itself persisted beyond the existing,
// unmodified AuthContext/apiClient token storage.
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
  return memoryKey;
}

export function discardKey() {
  memoryKey = null;
}

export async function encryptValue(plainObject) {
  if (!memoryKey) throw new Error('No encryption key available.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const data = enc.encode(JSON.stringify(plainObject));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, memoryKey, data);
  return { iv: Array.from(iv), cipher: Array.from(new Uint8Array(cipher)) };
}

// Returns null (never throws to the caller) if decryption fails — the
// caller treats this as "orphaned" per §9, not a crash.
export async function decryptValue({ iv, cipher }) {
  if (!memoryKey) return null;
  try {
    const dec = new TextDecoder();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      memoryKey,
      new Uint8Array(cipher)
    );
    return JSON.parse(dec.decode(plain));
  } catch {
    return null; // wrong/missing key, or corrupted data — orphaned, not fatal
  }
}
