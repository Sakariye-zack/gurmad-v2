import { useSyncExternalStore } from 'react';

// Module-level store of staff ZAAD pushes, keyed by invoice id. It outlives
// the payment panel: if the cashier switches invoice (or the panel remounts)
// while a request is waiting, the request keeps running and coming back to
// the invoice shows the waiting view and then the final result — including a
// critical "do not resend" outcome. Lost only on a full page reload, which
// the page guards with beforeunload while anything is waiting.
//   entry: { phase: 'waiting' | 'success' | 'failed', startedAt, amount, currency, phone, result?, fail? }
const entries = new Map();
const listeners = new Set();
let version = 0;

function emit() {
  version += 1;
  listeners.forEach((l) => l());
}
function subscribe(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const getVersion = () => version;

export function getZaadEntry(invoiceId) {
  return entries.get(invoiceId) || null;
}
export function setZaadEntry(invoiceId, entry) {
  if (entry) entries.set(invoiceId, entry); else entries.delete(invoiceId);
  emit();
}
export function anyZaadWaiting() {
  for (const e of entries.values()) if (e.phase === 'waiting') return true;
  return false;
}
// Re-renders the caller whenever any entry changes.
export function useZaadStore() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return { getZaadEntry, anyZaadWaiting };
}
