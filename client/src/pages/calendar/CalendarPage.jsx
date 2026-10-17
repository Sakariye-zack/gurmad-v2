import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { PageHeader, LoadingState, ErrorState, EmptyState } from '../../components/ui/index.js';
import { useCalendarBatches } from '../../hooks/useCalendar.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import WeekGrid from './WeekGrid.jsx';
import MonthGrid from './MonthGrid.jsx';
import {
  addDays, endOfWeek, formatMonthLabel, formatWeekLabel, monthGridRange,
  startOfWeek, toISODate,
} from './dateUtils.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

const STATUS_OPTIONS = ['draft', 'assigned', 'in_progress', 'partially_completed', 'completed', 'cancelled'];
const CUSTOMER_TYPE_OPTIONS = ['residential', 'commercial'];
// Decisions §"RBAC": Cashier/Collector get no v1 access — mirrored here so
// the nav-hidden case (a role without the page reachable at all) still
// degrades safely if ever linked to directly; the backend's own requireRole
// is the actual enforced boundary.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'head_of_cashiers'];

export default function CalendarPage() {
  const { t } = useI18n();
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
      <div style={{ marginBottom: '14px' }}>
        <PageHeader
          icon={CalendarDays}
          title={t('cal.operational_calendar')}
          subtitle={t('cal.read_only_view_of_collection')}
        />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <button onClick={goPrev} aria-label={t('cal.previous')} style={navBtnStyle}><ChevronLeft size={15} /></button>
          <button onClick={goToday} style={{ ...navBtnStyle, width: 'auto', padding: '0 12px', fontSize: '12px', fontWeight: 700 }}>{t('cal.today')}</button>
          <button onClick={goNext} aria-label={t('common.next')} style={navBtnStyle}><ChevronRight size={15} /></button>
          <span style={{ fontSize: '13px', fontWeight: 700, marginLeft: '4px' }}>{rangeLabel}</span>
        </div>

        <div style={{ display: 'flex', gap: '4px', padding: '2px', background: 'var(--bg)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
          <button
            onClick={() => setView('week')}
            style={toggleBtnStyle(view === 'week')}
          >
            {t('cal.week')}
          </button>
          <button
            onClick={() => setView('month')}
            style={toggleBtnStyle(view === 'month')}
          >
            {t('cal.month')}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
        {!isZoneScoped && (
          <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} style={selectStyle}>
            <option value="">{t('group.all_zones')}</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        )}
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle}>
          <option value="">{t('cust.all_statuses')}</option>
          {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{t('status.' + s, s.replace(/_/g, ' '))}</option>)}
        </select>
        <select value={customerType} onChange={(e) => setCustomerType(e.target.value)} style={selectStyle}>
          <option value="">{t('cal.all_customer_types')}</option>
          {CUSTOMER_TYPE_OPTIONS.map((c) => <option key={c} value={c}>{t('cust.' + c, c)}</option>)}
        </select>
      </div>

      {isLoading && <LoadingState label={t('cal.loading_calendar')} />}
      {!isLoading && error && <ErrorState message={error.message} onRetry={refetch} />}
      {!isLoading && !error && batches.length === 0 && (
        <EmptyState icon={CalendarDays} title={t('cal.no_batches_in_this_range')} subtitle={t('cal.try_a_different_date_range')} />
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
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(`/collection-cycles/batches/${batch.id}`)}
      style={{
        textAlign: 'left', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        background: 'var(--surface)', padding: '10px 12px', cursor: 'pointer', fontFamily: 'inherit',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', color: 'var(--text)',
        /* Explicit color required: a <button>'s UA default text color (black)
           does not inherit var(--text) from <body> — same dark-theme
           readability defect as the WeekGrid/MonthGrid event buttons. */
      }}
    >
      <div>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text)' }}>{batch.batch_code}</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{batch.zone_name} · {batch.start_date}{batch.end_date ? ` – ${batch.end_date}` : t('cal.ongoing')}</div>
      </div>
      <span style={{ fontSize: '11px', fontWeight: 700, textTransform: 'capitalize', color: 'var(--text-muted)' }}>{batch.status.replace(/_/g, ' ')}</span>
    </button>
  );
}

const selectStyle = {
  padding: '6px 8px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '12px', fontFamily: 'inherit',
};

const navBtnStyle = {
  height: '28px', minWidth: '28px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)',
  color: 'var(--text)', cursor: 'pointer', fontFamily: 'inherit',
};

function toggleBtnStyle(active) {
  return {
    padding: '5px 12px', borderRadius: 'var(--radius-sm)', border: 'none',
    background: active ? 'var(--brand)' : 'transparent', color: active ? '#fff' : 'var(--text-muted)',
    fontWeight: 700, fontSize: '12px', cursor: 'pointer', fontFamily: 'inherit',
  };
}
