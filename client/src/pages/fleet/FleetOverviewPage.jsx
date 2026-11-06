import React from 'react';
import { Link } from 'react-router-dom';
import { Gauge, Fuel, Wrench, FileWarning, Truck, AlertTriangle } from 'lucide-react';
import { PageHeader, Card, StatCard, StatusBadge, LoadingState, ErrorState, EmptyState } from '../../components/ui/index.js';
import { useFleetOverview } from '../../hooks/useFleet.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { Pill, FlagChips, TruckPhoto, LIVE_MAP, usd, fmtNum, fmtDate } from './fleetShared.jsx';

function ago(secs) {
  if (secs === null || secs === undefined) return '';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

export default function FleetOverviewPage() {
  const { t } = useI18n();
  const { data, isLoading, error, refetch } = useFleetOverview();
  if (isLoading) return <LoadingState label={t('common.loading')} />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const d = data?.data;
  if (!d || !d.kpis) return <ErrorState message={t('fleet.truck.noData')} onRetry={refetch} />;
  const k = d.kpis;

  return (
    <div>
      <PageHeader icon={Gauge} title={t('fleet.overview.title')} subtitle={`${t('fleet.overview.subtitle')} (${d.period})`} />

      <div style={kpiGrid}>
        <StatCard label={t('fleet.kpi.active')} value={k.trucks.active} icon={Truck} />
        <StatCard label={t('fleet.kpi.maintenance')} value={k.trucks.maintenance} icon={Wrench} accent="var(--warning)" />
        <StatCard label={t('fleet.kpi.inactive')} value={k.trucks.inactive} icon={Truck} accent="var(--text-muted)" />
        <StatCard label={t('fleet.kpi.fuelMonth')} value={usd(k.fuel_cost_month_usd)} sub={t('fleet.kpi.usdEquiv')} icon={Fuel} />
        <StatCard label={t('fleet.kpi.maintMonth')} value={usd(k.maintenance_cost_month_usd)} sub={t('fleet.kpi.usdEquiv')} icon={Wrench} />
        <StatCard label={t('fleet.kpi.docsExpiring')} value={k.documents_expiring_30} sub={k.documents_expired ? t('fleet.kpi.expired', undefined, { n: k.documents_expired }) : undefined} icon={FileWarning} accent={k.documents_expiring_30 ? 'var(--danger)' : 'var(--brand)'} />
        <StatCard label={t('fleet.kpi.maintDue')} value={k.maintenance_due} icon={AlertTriangle} accent={k.maintenance_due ? 'var(--warning)' : 'var(--brand)'} />
      </div>

      {d.trucks.length === 0 && <EmptyState title={t('fleet.empty')} />}
      <div style={cardGrid}>
        {d.trucks.map((tr) => <TruckCard key={tr.id} tr={tr} />)}
      </div>
    </div>
  );
}

function TruckCard({ tr }) {
  const { t } = useI18n();
  const nm = tr.next_maintenance;
  const doc = tr.nearest_document;
  return (
    <Card style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 }}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', minWidth: 0 }}>
        <TruckPhoto path={tr.photo_url} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '15px' }}>{tr.plate_number}</strong>
            <StatusBadge status={tr.status} map={{ maintenance: 'warning', inactive: 'info' }} />
          </div>
          <div style={muted}>{tr.model || '—'}{tr.zone_name ? ` · ${tr.zone_name}` : ''}</div>
          {tr.live && (
            <div style={{ marginTop: '4px' }}>
              <Pill variant={LIVE_MAP[tr.live.status]}>
                {t(`fleet.live.${tr.live.status}`)}{tr.live.seconds_ago !== null ? ` · ${t('fleet.live.lastSeen', undefined, { t: ago(tr.live.seconds_ago) })}` : ''}
              </Pill>
            </div>
          )}
        </div>
      </div>

      <div style={metaGrid}>
        <Meta label={t('fleet.card.collector')} value={tr.collector_name || t('fleet.card.unassigned')} />
        <Meta label={t('fleet.card.driver')} value={tr.driver_name || t('fleet.card.unassigned')} />
        <Meta label={t('fleet.card.fuel')} value={usd(tr.fuel_cost_month_usd)} sub={`${fmtNum(tr.fuel_liters_month)} L`} />
        <Meta label={t('fleet.card.maintenance')} value={usd(tr.maintenance_cost_month_usd)} />
        <Meta label={t('fleet.card.kmMonth')} value={fmtNum(tr.km_month)} sub={tr.odometer_km_month ? `odo ${fmtNum(tr.odometer_km_month, 0)}` : undefined} />
        <Meta label={t('fleet.card.kmpl')} value={fmtNum(tr.km_per_liter)} sub={tr.gps_km_per_liter !== null ? `${t('fleet.card.kmplGps')}: ${fmtNum(tr.gps_km_per_liter)}` : undefined} />
      </div>
      <FlagChips flags={tr.fuel_flags} />

      <div style={{ ...metaGrid, gridTemplateColumns: '1fr' }}>
        <Meta label={t('fleet.card.nextService')} value={nm ? (
          <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
            {nm.next_service_date && <span>{fmtDate(nm.next_service_date)} ({t('fleet.card.daysLeft', undefined, { n: nm.days_remaining })})</span>}
            {nm.next_service_km !== null && <span>{fmtNum(nm.next_service_km, 0)} km{nm.km_remaining !== null ? ` (${t('fleet.card.kmLeft', undefined, { n: fmtNum(nm.km_remaining, 0) })})` : ''}</span>}
            {nm.due && <Pill variant="warning">{t('fleet.card.due')}</Pill>}
          </span>
        ) : t('fleet.card.none')} />
        <Meta label={t('fleet.card.nearestDoc')} value={doc ? (
          <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
            {t(`fleet.doc.${doc.document_type}`)} · {fmtDate(doc.expiry_date)}
            <Pill variant={doc.days_left < 0 ? 'danger' : doc.days_left <= 30 ? 'warning' : 'success'}>{t('fleet.card.daysLeft', undefined, { n: doc.days_left })}</Pill>
          </span>
        ) : t('fleet.card.none')} />
      </div>
      <Link to={`/trucks/${tr.id}`} style={{ fontSize: '13px', fontWeight: 700, color: 'var(--brand)', textDecoration: 'none', marginTop: 'auto' }}>{t('fleet.card.open')} →</Link>
    </Card>
  );
}

function Meta({ label, value, sub }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{label}</div>
      <div className="tabular-nums" style={{ fontSize: '13px', fontWeight: 600, overflowWrap: 'anywhere' }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

const muted = { fontSize: '12px', color: 'var(--text-muted)' };
const kpiGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '20px' };
const cardGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: '14px' };
const metaGrid = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px 12px' };
