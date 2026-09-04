import React, { useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { apiClient } from '../lib/apiClient.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { deriveKeyFromToken, hasKey } from './lib/collectorCrypto.js';
import { getAllQueueEntries } from './lib/collectorStore.js';
import { SyncQueueProvider } from './SyncQueueContext.jsx';
import ReauthModal from './screens/ReauthModal.jsx';

// Field Collector Mobile — Implementation Spec §9/§17. Owns the encryption-
// key lifecycle and the app-wide reauthentication prompt. Mounted once,
// above every /collector/* route.
export default function CollectorApp() {
  const { isAuthenticated } = useAuth();
  const [keyReady, setKeyReady] = useState(hasKey());
  const [orphanedCount, setOrphanedCount] = useState(0);
  const [showOrphanNotice, setShowOrphanNotice] = useState(false);
  const [showReauth, setShowReauth] = useState(false);
  const navigate = useNavigate();

  // §9: the key is deterministically re-derivable from the CURRENT JWT
  // string (already persisted by AuthContext for its own, pre-existing
  // reasons — this does not persist the key itself, only reuses an
  // already-persisted value as the key's input). A page reload with the
  // SAME still-valid token therefore recovers decryption automatically;
  // only an actual new login (different token) or logout truly changes it.
  useEffect(() => {
    (async () => {
      if (!isAuthenticated) return;
      if (!hasKey()) {
        const token = apiClient.getToken();
        if (token) {
          await deriveKeyFromToken(token);
          setKeyReady(true);
        }
      }
      const { orphanedCount: o } = await getAllQueueEntries();
      setOrphanedCount(o);
      if (o > 0) setShowOrphanNotice(true);
    })();
  }, [isAuthenticated]);

  const handleRequiresReauth = () => setShowReauth(true);
  const handleStaleOrInvalid = () => {
    // §7 outcome mapping: rejected_stale/rejected_invalid_state trigger an
    // assignment refresh — surfaced by re-navigating to Assignments, which
    // re-mounts useAssignments and its trigger-1 fetch.
    navigate('/collector');
  };

  if (!keyReady) return null; // brief, near-instant — key derivation is fast

  return (
    <SyncQueueProvider onRequiresReauth={handleRequiresReauth} onStaleOrInvalid={handleStaleOrInvalid}>
      {showOrphanNotice && (
        <OrphanBanner count={orphanedCount} onDismiss={() => setShowOrphanNotice(false)} />
      )}
      <ReauthModal open={showReauth} onSuccess={() => setShowReauth(false)} />
      <Outlet />
    </SyncQueueProvider>
  );
}

function OrphanBanner({ count, onDismiss }) {
  return (
    <div style={{
      background: 'var(--warning-bg)', color: 'var(--warning)', padding: '10px 16px',
      fontSize: '13px', fontWeight: 700, textAlign: 'center',
    }}>
      {count} previously queued {count === 1 ? 'visit' : 'visits'} could not be recovered after this restart
      — please review Today's Assignments and re-record if needed.{' '}
      <button onClick={onDismiss} style={{ background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer', color: 'inherit', fontWeight: 700 }}>
        Dismiss
      </button>
    </div>
  );
}
