import React, { createContext, useContext } from 'react';
import { useSyncQueue } from './hooks/useSyncQueue.js';

// Shared across every Collector screen (shell badge, Sync Center, Collection
// Action's capture call) — one queue instance, not re-created per screen.
const SyncQueueContext = createContext(null);

export function SyncQueueProvider({ children, onRequiresReauth, onStaleOrInvalid }) {
  const queue = useSyncQueue({ onRequiresReauth, onStaleOrInvalid });
  return <SyncQueueContext.Provider value={queue}>{children}</SyncQueueContext.Provider>;
}

export function useSyncQueueContext() {
  const ctx = useContext(SyncQueueContext);
  if (!ctx) throw new Error('useSyncQueueContext must be used within SyncQueueProvider');
  return ctx;
}
