import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { PageHeader, Button, LoadingState, ErrorState, EmptyState } from '../../components/ui/index.js';
import { useCalendarBatches } from '../../hooks/useCalendar.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import WeekGrid from './WeekGrid.jsx';
import MonthGrid from './MonthGrid.jsx';
import {
  addDays, endOfWeek, formatMonthLabel, formatWeekLabel, monthGridRange,
  startOfWeek, toISODate,
} from './dateUtils.js';

const STATUS_OPTIONS = ['draft', 'assigned', 'in_progress', 'partially_completed', 'completed', 'cancelled'];
const CUSTOMER_TYPE_OPTIONS = ['residential', 'commercial'];
// Decisions §"RBAC": Cashier/Collector get no v1 access — mirrored here so
// the nav-hidden case (a role without the page reachable at all) still
// degrades safely if ever linked to directly; the backend's own requireRole
// is the actual enforced boundary.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'head_of_cashiers'];

export default function CalendarPage() {
  const { user } = useAuth();
  const [view, setView] = useState('week'); // 'week' | 'month'
  const [anchor, setAnchor] = useState(() => new Date());
  const [zoneId, setZoneId] = useState('');
  const [status, setStatus] = useState('');
  const [customerType, setCustomerType] = useState('');

  const isZoneScoped = ZONE_SCOPED_ROLES.includes((user?.role || '').toLowerCase());
  const { data: zonesData } = useZonesList();
  const zones = zonesData?.data || [];

  const range = useMemo(() => {
    if (view === 'month') return monthGridRange(anchor);
    return { from: startOfWeek(anchor), to: endOfWeek(anchor) };
  }, [view, anchor]);

  const { data, isLoading, error, refetch } = useCalendarBatches({
    from: toISODate(range.from),
    to: toISODate(range.to),
    zoneId: isZoneScoped ? undefined : (zoneId || undefined), // server forces zone for scoped roles anyway; withheld client-side too, never trusted either way
    status: status || undefined,
    customerType: customerType || undefined,
  });
  const batches = data?.data || [];

  function goPrev() {
    setAnchor((d) => (view === 'month' ? new Date(d.getFullYear(), d.getMonth() - 1, 1) : addDays(startOfWeek(d), -7)));
  }
  function goNext() {
    setAnchor((d) => (view === 'month' ? new Date(d.getFullYear(), d.getMonth() + 1, 1) : addDays(startOfWeek(d), 7)));
  }
  function goToday() {
    setAnchor(new Date());
  }

  const rangeLabel = view === 'month' ? formatMonthLabel(anchor) : formatWeekLabel(anchor);

  return (
    <div>
      <PageHeader
        icon={CalendarDays}
        title="Operational Calendar"
        subtitle="A read-only view of collection batches by date. Click a batch to open it."
      />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Button variant="secondary" onClick={goPrev} aria-label="Previous"><ChevronLeft size={16} /></Button>
          <Button variant="secondary" onClick={goToday}>Today</Button>
          <Button variant="secondary" onClick={goNext} aria-label="Next"><ChevronRight size={16} /></Button>
          <span style={{ fontSize: '14px', fontWeight: 700, marginLeft: '6px' }}>{rangeLabel}</span>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={() => setView('week')}
            style={toggleBtnStyle(view === 'week')}
          >
            Week
          </button>
          <button
            onClick={() => setView('month')}
            style={toggleBtnStyle(view === 'month')}
          >
            Month
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
        {!isZoneScoped && (
          <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} style={selectStyle}>
            <option value="">All zones</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        )}
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <select value={customerType} onChange={(e) => setCustomerType(e.target.value)} style={selectStyle}>
          <option value="">All customer types</option>
          {CUSTOMER_TYPE_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {isLoading && <LoadingState label="Loading calendar…" />}
      {!isLoading && error && <ErrorState message={error.message} onRetry={refetch} />}
      {!isLoading && !error && batches.length === 0 && (
        <EmptyState icon={CalendarDays} title="No batches in this range" subtitle="Try a different date range or clear the filters." />
      )}
      {!isLoading && !error && batches.length > 0 && (
        <div className="v2-calendar-grid-wrap" style={{ overflowX: 'auto' }}>
          {view === 'week'
            ? <WeekGrid from={range.from} to={range.to} batches={batches} />
            : <MonthGrid from={range.from} to={range.to} batches={batches} focusMonth={anchor} />}
        </div>
      )}

      {/* Responsive: below 768px the grid is replaced by a simple chronological
          list — a 7/42-column CSS grid cannot be read on a phone-width screen.
          Implementation Spec §"Responsive". */}
      <style>{`
        @media (max-width: 767px) {
          .v2-calendar-grid-wrap { display: none; }
        }
      `}</style>
      {!isLoading && !error && batches.length > 0 && (
        <div className="v2-calendar-list-fallback" style={{ display: 'none', flexDirection: 'column', gap: '8px' }}>
          <CalendarListFallback batches={batches} />
        </div>
      )}
      <style>{`
        @media (max-width: 767px) {
          .v2-calendar-list-fallback { display: flex !important; }
        }
      `}</style>
    </div>
  );
}

function CalendarListFallback({ batches }) {
  const sorted = [...batches].sort((a, b) => a.start_date.localeCompare(b.start_date));
  return sorted.map((b) => (
    <ListRow key={b.id} batch={b} />
  ));
}

function ListRow({ batch }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(`/collection-cycles/batches/${batch.id}`)}
      style={{
        textAlign: 'left', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        background: 'var(--surface)', padding: '10px 12px', cursor: 'pointer', fontFamily: 'inherit',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px',
      }}
    >
      <div>
        <div style={{ fontSize: '13px', fontWeight: 700 }}>{batch.batch_code}</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{batch.zone_name} · {batch.start_date}{batch.end_date ? ` – ${batch.end_date}` : ' (ongoing)'}</div>
      </div>
      <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'capitalize', color: 'var(--text-muted)' }}>{batch.status.replace(/_/g, ' ')}</span>
    </button>
  );
}

const selectStyle = {
  padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px', fontFamily: 'inherit',
};

function toggleBtnStyle(active) {
  return {
    padding: '7px 14px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
    background: active ? 'var(--brand)' : 'var(--surface)', color: active ? '#fff' : 'var(--text)',
    fontWeight: 700, fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit',
  };
}
