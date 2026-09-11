import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, RefreshCw, TrendingUp, CheckCircle2, XCircle, SkipForward, Clock } from 'lucide-react';
import { Button, LoadingState } from '../../components/ui/index.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useAssignments } from '../hooks/useAssignments.js';
import { apiClient } from '../../lib/apiClient.js';

// Screen — user-requested ("Home screen kana iigu soo dar", Phase 10 Gap
// Audit follow-up). The collector previously landed straight on the
// Assignments list with no orientation point — no greeting, no sense of
// today's overall progress beyond the list itself, no single place that
// answers "how am I doing today" without opening Sync/Account. Uses the
// already-CLOSED, collector-self-scoped GET /v2/reports/collector-performance
// endpoint (server/routes/reports.js) — zero backend changes. Falls back
// silently to the locally-cached assignment counts (already fetched by
// useAssignments for the Assignments screen) if the performance call
// fails, so Home never blocks on a second network round-trip the way a
// hard error/loading gate would.
export default function HomeScreen() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data, loading: assignmentsLoading, refresh } = useAssignments();
  const [perf, setPerf] = useState(null); // { assigned, serviced, missed, skipped, completionRate } | null
  const [perfLoading, setPerfLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiClient.get('/v2/reports/collector-performance?period=today');
        const row = res?.data?.[0] || null;
        if (!cancelled) setPerf(row);
      } catch {
        if (!cancelled) setPerf(null);
      } finally {
        if (!cancelled) setPerfLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const batches = data?.batches || [];
  const allCustomers = batches.flatMap((b) => b.customers);
  // Fallback counts from the already-cached assignments, used only when
  // the performance endpoint itself didn't return usable data.
  const fallbackCounts = { pending: 0, serviced: 0, missed: 0, skipped: 0 };
  for (const c of allCustomers) { if (fallbackCounts[c.status] !== undefined) fallbackCounts[c.status] += 1; }

  const assigned = perf?.assigned ?? allCustomers.length;
  const serviced = perf?.serviced ?? fallbackCounts.serviced;
  const missed = perf?.missed ?? fallbackCounts.missed;
  const skipped = perf?.skipped ?? fallbackCounts.skipped;
  const pending = fallbackCounts.pending;
  const completionRate = perf?.completionRate ?? (assigned > 0 ? Math.round((serviced / assigned) * 1000) / 10 : null);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <div>
      <div style={{ marginBottom: '20px' }}>
        <div style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 600 }}>{greeting},</div>
        <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--text)' }}>{user?.full_name || user?.username}</div>
        {user?.zone && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{user.zone}</div>}
      </div>

      {/* Today's progress ring/card — the single "how am I doing" answer. */}
      <div style={{
        borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', background: 'var(--surface)',
        padding: '18px', marginBottom: '16px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', fontWeight: 800, color: 'var(--text)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
            <TrendingUp size={15} /> Today's Progress
          </div>
          {(perfLoading || assignmentsLoading) && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Loading…</span>}
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '14px' }}>
          <div style={{ fontSize: '34px', fontWeight: 900, color: 'var(--text)', lineHeight: 1 }}>
            {completionRate !== null ? `${completionRate}%` : '—'}
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 600 }}>
            {serviced} of {assigned} serviced
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px' }}>
          <MiniStat icon={Clock} label="Pending" value={pending} color="var(--warning)" />
          <MiniStat icon={CheckCircle2} label="Serviced" value={serviced} color="var(--success)" />
          <MiniStat icon={XCircle} label="Missed" value={missed} color="var(--danger)" />
          <MiniStat icon={SkipForward} label="Skipped" value={skipped} color="var(--info)" />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <Button
          icon={ClipboardList}
          onClick={() => navigate('/collector/assignments')}
          style={{ width: '100%', minHeight: '52px', fontSize: '15px', justifyContent: 'center' }}
        >
          {pending > 0 ? `View Today's Assignments (${pending} pending)` : "View Today's Assignments"}
        </Button>
        <Button
          variant="secondary"
          icon={RefreshCw}
          onClick={refresh}
          style={{ width: '100%', minHeight: '48px', justifyContent: 'center' }}
        >
          Refresh Assignments
        </Button>
      </div>

      {assignmentsLoading && !data && (
        <div style={{ marginTop: '16px' }}><LoadingState label="Loading your day…" /></div>
      )}
    </div>
  );
}

function MiniStat({ icon: Icon, label, value, color }) {
  return (
    <div style={{ padding: '10px 4px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', borderTop: `2px solid ${color}`, background: 'var(--bg)', textAlign: 'center' }}>
      <Icon size={14} style={{ color, marginBottom: '4px' }} />
      <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>{label}</div>
    </div>
  );
}
