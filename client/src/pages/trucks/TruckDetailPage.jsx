import React, { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Truck, Pencil, Camera, Plus } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, ConfirmDialog, StatCard, DataTable, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useTruck, useUpdateTruckStatus } from '../../hooks/useTrucks.js';
import {
  useFuelRecords, useMaintenanceRecords, useTruckSummary, useTruckTrips, useTruckAssignments, useUploadTruckPhoto,
} from '../../hooks/useFleet.js';
import { fmtMoney } from '../../lib/money.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import TruckFormModal from './TruckFormModal.jsx';
import { complianceState, COMPLIANCE_LABELS, COMPLIANCE_BADGE_MAP } from './complianceState.js';
import { MaintenanceTable, MaintenanceFormModal } from '../fleet/FleetMaintenanceListPage.jsx';
import { TruckPhoto, FlagChips, ReceiptLink, RenewModal, DocStatusBadge, Pill, usd, fmtNum, fmtDate, cellStyle } from '../fleet/fleetShared.jsx';

// Lifecycle vocabulary is frozen (OD-3): Active / Maintenance / Inactive /
// Retired. Retired is a confirmed, permanent one-way terminal state
// (backend-enforced, Module 4 final review) — the UI mirrors that by never
// offering a way out of Retired, rather than offering a button the backend
// would just reject.
const TRANSITIONS = {
  active: ['maintenance', 'inactive', 'retired'],
  maintenance: ['active', 'inactive', 'retired'],
  inactive: ['active', 'maintenance', 'retired'],
  retired: [],
};
const STATUS_LABELS = { active: 'Active', maintenance: 'Maintenance', inactive: 'Inactive', retired: 'Retired' };
const TABS = ['overview', 'fuel', 'maintenance', 'trips', 'assignments', 'documents'];

export default function TruckDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { data, isLoading, error, refetch } = useTruck(id);
  const [editOpen, setEditOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState(null);
  const [tab, setTab] = useState('overview');
  const updateStatus = useUpdateTruckStatus(id);
  const toast = useToast();
  const truck = data?.data;

  if (isLoading) return <LoadingState label="Loading truck…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!truck) return null;

  const cs = complianceState(truck);
  const availableTransitions = TRANSITIONS[truck.status] || [];

  async function handleStatusChange() {
    try {
      await updateStatus.mutateAsync(pendingStatus);
      toast.success(`Status changed to ${STATUS_LABELS[pendingStatus]}.`);
      setPendingStatus(null);
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
      setPendingStatus(null);
    }
  }

  return (
    <div>
      <button onClick={() => navigate('/trucks')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Trucks
      </button>

      <div style={{ display: 'flex', gap: '14px', alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: '4px' }}>
        <PhotoBlock truck={truck} />
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <PageHeader
            icon={Truck}
            title={truck.plate_number}
            subtitle={`${truck.model || 'No model set'}${truck.zone_name ? ` · ${truck.zone_name}` : ' · Company-wide'}`}
            actions={
              <RoleGate roles={['admin', 'gudoomiye']}>
                <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>Edit Truck</Button>
              </RoleGate>
            }
          />
        </div>
      </div>

      <div style={{ marginBottom: '16px' }}>
        <DetailGrid items={[
          { label: 'Status', value: <StatusBadge status={truck.status} /> },
          { label: 'Compliance', value: <StatusBadge status={COMPLIANCE_LABELS[cs]} map={{ [COMPLIANCE_LABELS[cs].toLowerCase()]: COMPLIANCE_BADGE_MAP[cs] }} /> },
          { label: t('fleet.card.collector'), value: truck.collector_name || '— (unassigned)' },
          { label: t('fleet.card.driver'), value: truck.driver_name || '— (unassigned)' },
          { label: 'Zone', value: truck.zone_name || '— (company-wide)' },
          { label: 'Capacity', value: truck.capacity != null ? truck.capacity : '—', className: 'tabular-nums' },
        ]} />
      </div>

      <RoleGate roles={['admin', 'gudoomiye']}>
        {availableTransitions.length > 0 && (
          <Card style={{ ...cardPad, marginBottom: '16px' }}>
            <Label>Change lifecycle status</Label>
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
              {availableTransitions.map((s) => (
                <Button key={s} variant={s === 'retired' ? 'danger' : 'secondary'} onClick={() => setPendingStatus(s)}>
                  Mark as {STATUS_LABELS[s]}
                </Button>
              ))}
            </div>
          </Card>
        )}
        {truck.status === 'retired' && (
          <Card style={{ ...cardPad, marginBottom: '16px' }}>
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
              This truck is Retired — a permanent, terminal status. Historical records remain preserved.
              Returning a retired truck to service requires a separate, future business decision.
            </p>
          </Card>
        )}
      </RoleGate>

      <div role="tablist" style={tabBar}>
        {TABS.map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={tabBtn(tab === k)}>
            {t(`fleet.truck.tab.${k}`)}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab truckId={truck.id} />}
      {tab === 'fuel' && <FuelTab truckId={truck.id} />}
      {tab === 'maintenance' && <MaintenanceTab truck={truck} />}
      {tab === 'trips' && <TripsTab truckId={truck.id} />}
      {tab === 'assignments' && <AssignmentsTab truckId={truck.id} />}
      {tab === 'documents' && <DocumentsTab truck={truck} />}

      {truck.notes && (
        <Card style={{ ...cardPad, marginTop: '16px' }}>
          <Label>Notes</Label>
          <p style={{ margin: '6px 0 0', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{truck.notes}</p>
        </Card>
      )}

      <TruckFormModal open={editOpen} onClose={() => setEditOpen(false)} truck={truck} />
      <ConfirmDialog
        open={!!pendingStatus}
        onClose={() => setPendingStatus(null)}
        onConfirm={handleStatusChange}
        title={`Mark as ${pendingStatus ? STATUS_LABELS[pendingStatus] : ''}?`}
        message={pendingStatus === 'retired'
          ? `${truck.plate_number} will be permanently retired from active fleet operations. All history remains intact — this does not delete anything.`
          : `${truck.plate_number}'s status will change to ${pendingStatus ? STATUS_LABELS[pendingStatus] : ''}.`}
        confirmLabel={pendingStatus ? `Mark as ${STATUS_LABELS[pendingStatus]}` : 'Confirm'}
        danger={pendingStatus === 'retired'}
        isLoading={updateStatus.isPending}
      />
    </div>
  );
}

function PhotoBlock({ truck }) {
  const { t } = useI18n();
  const toast = useToast();
  const upload = useUploadTruckPhoto(truck.id);
  const input = useRef(null);
  const [version, setVersion] = useState(0);
  const path = truck.photo_storage_path ? `/v2/trucks/${truck.id}/photo?v=${version}-${truck.updated_at || ''}` : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
      <TruckPhoto path={path} size={88} radius="var(--radius-md)" />
      <RoleGate roles={['admin', 'gudoomiye']}>
        <button type="button" onClick={() => input.current?.click()} disabled={upload.isPending}
          style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', background: 'none', border: 'none', color: 'var(--brand)', fontSize: '11px', fontWeight: 700, cursor: 'pointer', padding: 0 }}>
          <Camera size={12} /> {upload.isPending ? '…' : t('fleet.truck.photo')}
        </button>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" style={{ display: 'none' }}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            try { await upload.mutateAsync(file); setVersion((v) => v + 1); toast.success(t('fleet.truck.photoSaved')); } catch (err) { toast.error(err.message); }
          }} />
      </RoleGate>
    </div>
  );
}

function OverviewTab({ truckId }) {
  const { t } = useI18n();
  const { data, isLoading, error, refetch } = useTruckSummary(truckId);
  if (isLoading) return <LoadingState label={t('common.loading')} />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const s = data.data;
  const m = s.month;
  const max = Math.max(1, ...s.chart.map((c) => c.fuel_usd + c.maintenance_usd));
  const nm = s.next_maintenance;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={kpiGrid}>
        <StatCard label={t('fleet.kpi.fuelMonth')} value={usd(m.fuel_usd)} sub={`${fmtNum(m.liters)} L`} />
        <StatCard label={t('fleet.kpi.maintMonth')} value={usd(m.maintenance_usd)} />
        <StatCard label={t('fleet.card.kmMonth')} value={fmtNum(m.gps_km)} sub={m.odometer_km ? `odo ${fmtNum(m.odometer_km, 0)}` : undefined} />
        <StatCard label={t('fleet.card.kmpl')} value={fmtNum(m.km_per_liter)} sub={m.cost_per_km_usd ? `${t('fleet.fuel.costPerKm')}: ${fmtMoney(m.cost_per_km_usd, 'USD')}` : undefined} />
        <StatCard label={t('fleet.truck.downtimeMonth')} value={t('fleet.m.days', undefined, { n: fmtNum(m.downtime_days) })} />
        <StatCard label={t('fleet.card.nextService')} value={nm ? (nm.next_service_date ? fmtDate(nm.next_service_date) : `${fmtNum(nm.next_service_km, 0)} km`) : '—'}
          sub={nm && nm.due ? t('fleet.card.due') : undefined} accent={nm && nm.due ? 'var(--warning)' : 'var(--brand)'} />
      </div>

      <Card style={cardPad}>
        <Label>{t('fleet.truck.sixMonths')}</Label>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', height: '150px', marginTop: '12px' }}>
          {s.chart.map((c) => (
            <div key={c.month} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', height: '100%' }}>
              <div title={`${c.month}: ${usd(c.fuel_usd)} + ${usd(c.maintenance_usd)}`} style={{ flex: 1, width: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                <div style={{ height: `${(c.maintenance_usd / max) * 100}%`, background: 'var(--warning)', borderRadius: '3px 3px 0 0' }} />
                <div style={{ height: `${(c.fuel_usd / max) * 100}%`, background: 'var(--brand)', borderRadius: c.maintenance_usd ? 0 : '3px 3px 0 0' }} />
              </div>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{c.month.slice(5)}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '12px', marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
          <span><Swatch c="var(--brand)" /> {t('fleet.card.fuel')}</span>
          <span><Swatch c="var(--warning)" /> {t('fleet.card.maintenance')}</span>
        </div>
      </Card>

      <Card style={cardPad}>
        <Label>{t('fleet.truck.batches')} ({s.batches_served.length})</Label>
        {s.batches_served.length === 0 && <p style={emptyStyle}>{t('fleet.truck.noData')}</p>}
        {s.batches_served.map((b) => (
          <div key={b.id} style={rowStyle}>
            <span><strong>{b.batch_code}</strong>{b.zone_name ? ` · ${b.zone_name}` : ''}</span>
            <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', color: 'var(--text-muted)' }}>{fmtDate(b.start_date)} <StatusBadge status={b.status} /></span>
          </div>
        ))}
      </Card>
    </div>
  );
}

function FuelTab({ truckId }) {
  const { t } = useI18n();
  const { data, isLoading, error, refetch } = useFuelRecords({ truck_id: truckId });
  const rows = data?.data || [];
  return (
    <DataTable loading={isLoading} error={error?.message} onRetry={refetch} isEmpty={!isLoading && !error && rows.length === 0} emptyTitle={t('fleet.fuel.none')}
      columns={[{ label: t('fleet.common.date') }, { label: t('fleet.fuel.liters'), align: 'right' }, { label: t('fleet.m.cost'), align: 'right' },
        { label: t('fleet.common.odometer'), align: 'right' }, { label: t('fleet.card.kmpl'), align: 'right' }, { label: t('fleet.fuel.costPerKm'), align: 'right' },
        { label: t('fleet.fuel.station') }, { label: t('fleet.fuel.flags') }, { label: t('fleet.fuel.receipt') }]}>
      {rows.map((r) => (
        <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
          <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{fmtDate(r.record_date)}</td>
          <td style={num}>{fmtNum(r.liters, 2)}</td>
          <td style={num}>{fmtMoney(r.cost, r.currency)}</td>
          <td style={num}>{r.odometer_reading ?? '—'}</td>
          <td style={num}>{fmtNum(r.km_per_liter)}</td>
          <td style={num}>{r.cost_per_km_usd !== null ? fmtMoney(r.cost_per_km_usd, 'USD') : '—'}</td>
          <td style={cellStyle}>{r.station || '—'}</td>
          <td style={cellStyle}><FlagChips flags={r.flags} /></td>
          <td style={cellStyle}>{r.has_receipt ? <ReceiptLink path={`/v2/fleet/fuel/${r.id}/receipt`} /> : '—'}</td>
        </tr>
      ))}
    </DataTable>
  );
}

function MaintenanceTab({ truck }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error, refetch } = useMaintenanceRecords({ truck_id: truck.id });
  return (
    <div>
      <RoleGate roles={['admin', 'gudoomiye']}>
        <div style={{ marginBottom: '10px' }}><Button icon={Plus} onClick={() => setOpen(true)}>{t('fleet.m.log')}</Button></div>
      </RoleGate>
      <MaintenanceTable records={data?.data || []} loading={isLoading} error={error} onRetry={refetch} hideTruck />
      <MaintenanceFormModal open={open} onClose={() => setOpen(false)} trucks={[truck]} defaultTruckId={truck.id} />
    </div>
  );
}

function TripsTab({ truckId }) {
  const { t } = useI18n();
  const { data, isLoading, error, refetch } = useTruckTrips(truckId, 30);
  if (isLoading) return <LoadingState label={t('common.loading')} />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  const d = data.data;
  const max = Math.max(1, ...d.rows.map((r) => r.km));
  return (
    <Card style={cardPad}>
      <Label>{t('fleet.truck.dailyTrips')} · {t('fleet.truck.totalKm', undefined, { n: fmtNum(d.total_km) })}</Label>
      {d.rows.length === 0 && <p style={emptyStyle}>{t('fleet.truck.noData')}</p>}
      {d.rows.map((r) => (
        <div key={r.day} style={{ display: 'grid', gridTemplateColumns: '84px minmax(0,1fr) 64px', gap: '8px', alignItems: 'center', padding: '5px 0', fontSize: '12px' }}>
          <span className="tabular-nums">{fmtDate(r.day)}</span>
          <div style={{ background: 'var(--bg)', borderRadius: '3px', height: '10px', overflow: 'hidden' }} title={`${t('fleet.truck.points')}: ${r.points}`}>
            <div style={{ width: `${(r.km / max) * 100}%`, height: '100%', background: 'var(--brand)' }} />
          </div>
          <span className="tabular-nums" style={{ textAlign: 'right' }}>{fmtNum(r.km)} km</span>
        </div>
      ))}
    </Card>
  );
}

function AssignmentsTab({ truckId }) {
  const { t } = useI18n();
  const { data, isLoading, error, refetch } = useTruckAssignments(truckId);
  const rows = data?.data || [];
  return (
    <DataTable loading={isLoading} error={error?.message} onRetry={refetch} isEmpty={!isLoading && !error && rows.length === 0} emptyTitle={t('fleet.truck.noData')}
      columns={[{ label: t('fleet.card.collector') }, { label: t('fleet.card.driver') }, { label: t('fleet.truck.from') }, { label: t('fleet.truck.until') }]}>
      {rows.map((r) => (
        <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
          <td style={cellStyle}>{r.collector_name || '—'}</td>
          <td style={cellStyle}>{r.driver_name || '—'}</td>
          <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{new Date(r.from_at).toLocaleString()}</td>
          <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{r.to_at ? new Date(r.to_at).toLocaleString() : <Pill variant="success">{t('fleet.truck.current')}</Pill>}</td>
        </tr>
      ))}
    </DataTable>
  );
}

function DocumentsTab({ truck }) {
  const { t } = useI18n();
  const [target, setTarget] = useState(null);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const docs = [['insurance', truck.insurance_expiry], ['registration', truck.registration_expiry], ['road_tax', truck.road_tax_expiry]];
  return (
    <Card style={cardPad}>
      {docs.map(([doc, date]) => {
        const daysLeft = date ? Math.round((new Date(date + 'T00:00:00') - today) / 86400000) : null;
        return (
          <div key={doc} style={{ ...rowStyle, alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span><strong>{t(`fleet.doc.${doc}`)}</strong> · {fmtDate(date)} {daysLeft !== null && <span style={{ color: 'var(--text-muted)' }}>({t('fleet.card.daysLeft', undefined, { n: daysLeft })})</span>}</span>
            <span style={{ display: 'inline-flex', gap: '8px', alignItems: 'center' }}>
              <DocStatusBadge daysLeft={daysLeft} />
              <RoleGate roles={['admin', 'gudoomiye']}>
                <Button variant="secondary" onClick={() => setTarget({ truckId: truck.id, document: doc, plate: truck.plate_number, current: date })}>{t('fleet.renew')}</Button>
              </RoleGate>
            </span>
          </div>
        );
      })}
      <RenewModal target={target} onClose={() => setTarget(null)} />
    </Card>
  );
}

function Swatch({ c }) {
  return <span style={{ display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', background: c, verticalAlign: 'middle' }} />;
}

function Label({ children }) {
  return <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{children}</span>;
}

const num = { ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap' };
const cardPad = { padding: '16px' };
const emptyStyle = { margin: '6px 0 0', fontSize: '13px', color: 'var(--text-muted)' };
const rowStyle = { display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px', gap: '8px' };
const kpiGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' };
const tabBar = { display: 'flex', gap: '4px', overflowX: 'auto', borderBottom: '1px solid var(--border)', marginBottom: '14px', WebkitOverflowScrolling: 'touch' };
const tabBtn = (active) => ({
  background: 'none', border: 'none', borderBottom: `2px solid ${active ? 'var(--brand)' : 'transparent'}`, padding: '9px 12px',
  fontWeight: 700, fontSize: '13px', color: active ? 'var(--brand)' : 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
});
const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
