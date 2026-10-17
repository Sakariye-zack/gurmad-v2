import React from 'react';
import { RefreshCw, X } from 'lucide-react';
import { PageHeader, Button, EmptyState } from '../../components/ui/index.js';
import { useSyncQueueContext } from '../SyncQueueContext.jsx';
import { outcomeMessage } from '../lib/outcomeMessages.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

const TERMINAL_OUTCOMES = new Set(['accepted', 'already_applied', 'rejected_stale', 'rejected_invalid_state']);

// Screen 6.5 (Decisions §17). Folds "Conflict/rejected action" as per-item
// state, not a separate screen. Never renders a raw outcome string,
// action_uuid, or server error text — every line goes through
// outcomeMessages.js's single translation layer.
export default function SyncCenterScreen() {
  const { t } = useI18n();
  const { entries, syncing, trySync, dismissTerminalEntry } = useSyncQueueContext();

  return (
    <div>
      <PageHeader
        title={t('collector.sync.title')}
        subtitle={syncing ? t('collector.sync.syncing') : t('collector.sync.subtitle')}
        actions={<Button variant="secondary" icon={RefreshCw} onClick={trySync} disabled={syncing} style={{ minHeight: '44px' }}>{t('collector.sync.syncNow')}</Button>}
      />
      {entries.length === 0 ? (
        <EmptyState title={t('collector.sync.caughtUp')} subtitle={t('collector.sync.nothing')} />
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
                <div style={{ fontWeight: 700, fontSize: '14px', textTransform: 'capitalize' }}>{t('status.' + e.status, e.status)}</div>
                <div style={{ fontSize: '13px', color: `var(--${msg.tone})`, marginTop: '2px' }}>{t(msg.key, msg.text)}</div>
                {/* Photo upload state (Phase 10) — separate from the status-
                    change outcome above; a Serviced visit's photo uploads
                    independently once the status change itself is accepted. */}
                {e.photo_state === 'pending' && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{t('collector.sync.photoUploading')}</div>}
                {e.photo_state === 'failed' && <div style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '2px' }}>{t('collector.sync.photoFailed')}</div>}
              </div>
              {isTerminal && (
                <button onClick={() => dismissTerminalEntry(e.action_uuid)} aria-label={t('common.dismiss')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', minWidth: '44px', minHeight: '44px' }}>
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
