import React from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, MapPin } from 'lucide-react';
import { PageHeader, Button, StatusBadge, LoadingState, EmptyState, ErrorState } from '../../components/ui/index.js';
import { useAssignments } from '../hooks/useAssignments.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

// Screen 6.2 (Decisions §17). Refresh occurs ONLY at: mount (the "login"
// trigger, since this hook mounts fresh each time the collector reaches
// this route post-auth), and manual (the button below). The 3rd trigger
// (post-reauth-reconnect) is handled by CollectorApp navigating back here,
// which re-mounts this component and its own mount-trigger.
export default function AssignmentsScreen() {
  const { data, fetchedAt, loading, error, isOffline, refresh } = useAssignments();
  const navigate = useNavigate();
  const { t } = useI18n();

  if (loading && !data) return <LoadingState label={t('collector.loadingAssignments')} />;
  if (error?.type === 'network' && !data?.batches?.length) {
    return <ErrorState message={t('collector.loadAssignmentsFailed')} onRetry={refresh} />;
  }

  const batches = data?.batches || [];
  const allCustomers = batches.flatMap((b) => b.customers);
  const totalCustomers = allCustomers.length;
  // Progress summary (user-requested, Phase 10) — the list alone never
  // showed how much of today's work is actually done; computed entirely
  // client-side from the same already-fetched assignments, no new
  // backend call. counts.pending is what's left to do today.
  const counts = { pending: 0, serviced: 0, missed: 0, skipped: 0 };
  for (const c of allCustomers) { if (counts[c.status] !== undefined) counts[c.status] += 1; }

  return (
    <div>
      <PageHeader
        title={t('collector.assignmentsTitle')}
        subtitle={isOffline ? t('collector.offlineShowing', undefined, { time: formatTime(fetchedAt, t) }) : t('collector.customersAcross', undefined, { customers: totalCustomers, batches: batches.length })}
        actions={<Button variant="secondary" icon={RefreshCw} onClick={refresh} style={{ minHeight: '44px' }}>{t('common.refresh')}</Button>}
      />

      {totalCustomers > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '18px' }}>
          <StatChip label={t('status.pending')} value={counts.pending} color="var(--warning)" />
          <StatChip label={t('status.serviced')} value={counts.serviced} color="var(--success)" />
          <StatChip label={t('status.missed')} value={counts.missed} color="var(--danger)" />
          <StatChip label={t('status.skipped')} value={counts.skipped} color="var(--info)" />
        </div>
      )}

      {batches.length === 0 ? (
        <EmptyState title={t('collector.noAssignments')} subtitle={t('collector.noAssignmentsHint')} />
      ) : (
        batches.map((b) => (
          <div key={b.id} style={{ marginBottom: '20px' }}>
            <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>
              {b.batch_code}
            </div>
            {b.customers.map((c) => (
              <button
                key={c.customer_id}
                onClick={() => navigate(`/collector/customer/${b.id}/${c.customer_id}`)}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
                  padding: '14px', marginBottom: '8px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
                  background: 'var(--surface)', minHeight: '64px', textAlign: 'left', cursor: 'pointer',
                }}
              >
                <div>
                  {/* Fix: a bare <button> does not inherit body's text color
                      in any browser (buttons default to their own control
                      color, unlike normal elements) — without this, dark
                      mode rendered near-black text on a dark card, almost
                      unreadable. Every other collector-screen button that
                      shows customer/entity names has the identical gap. */}
                  <div style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text)' }}>{c.business_name || c.name}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
                    <MapPin size={12} /> {c.address_line || t('collector.noAddress')}
                  </div>
                </div>
                <StatusBadge status={c.status} />
              </button>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

function formatTime(iso, t) {
  if (!iso) return t('collector.earlier');
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function StatChip({ label, value, color }) {
  return (
    <div style={{ padding: '10px 6px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', borderTop: `2px solid ${color}`, background: 'var(--surface)', textAlign: 'center' }}>
      <div style={{ fontSize: '19px', fontWeight: 800, color: 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>{label}</div>
    </div>
  );
}
