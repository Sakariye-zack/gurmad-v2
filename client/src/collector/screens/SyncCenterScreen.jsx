import React from 'react';
import { RefreshCw, X } from 'lucide-react';
import { PageHeader, Button, EmptyState } from '../../components/ui/index.js';
import { useSyncQueueContext } from '../SyncQueueContext.jsx';
import { outcomeMessage } from '../lib/outcomeMessages.js';

const TERMINAL_OUTCOMES = new Set(['accepted', 'already_applied', 'rejected_stale', 'rejected_invalid_state']);

// Screen 6.5 (Decisions §17). Folds "Conflict/rejected action" as per-item
// state, not a separate screen. Never renders a raw outcome string,
// action_uuid, or server error text — every line goes through
// outcomeMessages.js's single translation layer.
export default function SyncCenterScreen() {
  const { entries, syncing, trySync, dismissTerminalEntry } = useSyncQueueContext();

  return (
    <div>
      <PageHeader
        title="Sync Center"
        subtitle={syncing ? 'Syncing…' : 'Your queued visits'}
        actions={<Button variant="secondary" icon={RefreshCw} onClick={trySync} disabled={syncing} style={{ minHeight: '44px' }}>Sync now</Button>}
      />
      {entries.length === 0 ? (
        <EmptyState title="All caught up" subtitle="Nothing to sync." />
      ) : (
        entries.map((e) => {
          const isTerminal = e.sync_state === 'synced_terminal' && TERMINAL_OUTCOMES.has(e.last_outcome);
          const msg = outcomeMessage(e.last_outcome || e.sync_state);
          return (
            <div key={e.action_uuid} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px',
              marginBottom: '8px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--surface)',
            }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: '14px', textTransform: 'capitalize' }}>{e.status}</div>
                <div style={{ fontSize: '13px', color: `var(--${msg.tone})`, marginTop: '2px' }}>{msg.text}</div>
              </div>
              {isTerminal && (
                <button onClick={() => dismissTerminalEntry(e.action_uuid)} aria-label="Dismiss" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', minWidth: '44px', minHeight: '44px' }}>
                  <X size={18} />
                </button>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
