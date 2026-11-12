import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Boxes, Pencil, Plus } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, StatCard, LoadingState, ErrorState, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useGroup, useGroupSummary, useGroupCollectorPerformance, useCreateRoute, useUpdateRoute, useGroupCustomers } from '../../hooks/useGroups.js';
import { useCreateGroupZone, useUpdateGroupZone } from '../../hooks/useGroupZones.js';
import GroupFormModal from './GroupFormModal.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { useUsers } from '../../hooks/useUsers.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useDailyListOptions } from '../../hooks/useDailyLists.js';

const WEEK_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];

// Group Detail — Group & Group-Based Collection CR, Spec §8. Group
// information, Zone, status, customer/route counts and lists, and current
// collection activity (Group-level report summary) — all live-derived,
// never hardcoded (mirrors ZoneDetailPage's own foundation-first pattern).
export default function GroupDetailPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useGroup(id);
  const { data: summaryData } = useGroupSummary(id);
  const { data: perfData } = useGroupCollectorPerformance(id);
  // User-requested gap-audit sweep ('sii wad qaybaha kale'): useGroupCustomers()
  // already existed in useGroups.js, fully wired to the backend (GET
  // /v2/groups/:id/customers, paginated), but nothing here ever called it —
  // this page only ever showed a bare customer COUNT (DetailGrid above),
  // never the actual list, and CustomersListPage.jsx has no group filter
  // either, so there was no path anywhere from a Group to its customers.
  const { data: customersData } = useGroupCustomers(id);
  const [editOpen, setEditOpen] = useState(false);
  const [routeFormOpen, setRouteFormOpen] = useState(false);
  // User-requested gap-audit sweep ('sii wad qaybaha kale'): useUpdateRoute()
  // already existed in useGroups.js, fully wired to the backend (PUT
  // /v2/routes/:id), but nothing here ever called it — Add Route existed,
  // a typo'd code or a status change on an existing route did not.
  const [editRouteTarget, setEditRouteTarget] = useState(null);
  const [zoneFormTarget, setZoneFormTarget] = useState(null); // null closed, {} new, row = edit
  const group = data?.data;
  const summary = summaryData?.data;
  const performance = perfData?.data || [];
  const zones = group?.zones || [];
  const customers = customersData?.data || [];
  const customersMeta = customersData?.meta;

  const routeSections = [
    ...zones.map((z) => ({ key: 'z' + z.id, label: z.name ? `${z.code} — ${z.name}` : z.code, routes: (group?.routes || []).filter((r) => r.group_zone_id === z.id) })),
    { key: 'none', label: t('group.no_zone', 'No zone'), routes: (group?.routes || []).filter((r) => !r.group_zone_id) },
  ].filter((sec) => sec.routes.length > 0);

  if (isLoading) return <LoadingState label={t('group.loading_group')} />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!group) return null;

  return (
    <div>
      <button onClick={() => navigate('/groups')} style={backLinkStyle}>
        <ArrowLeft size={14} /> {t('group.back_to_groups')}
      </button>

      <PageHeader
        icon={Boxes}
        title={group.code}
        subtitle={group.zone_name}
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>{t('group.edit_group')}</Button>
          </RoleGate>
        }
      />

      <DetailGrid items={[
        { label: t('common.status'), value: <StatusBadge status={group.status} /> },
        { label: t('common.zone'), value: group.zone_name },
        { label: t('nav.customers'), value: group.customer_count },
        { label: t('group.routes'), value: group.route_count },
      ]} />

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '14px', margin: '20px 0' }}>
          <StatCard label={t('status.assigned')} value={summary.assigned} />
          <StatCard label={t('status.serviced')} value={summary.serviced} accent="var(--success)" />
          <StatCard label={t('status.missed')} value={summary.missed} accent="var(--danger)" />
          <StatCard label={t('status.skipped')} value={summary.skipped} accent="var(--warning)" />
          <StatCard label={t('status.rescheduled')} value={summary.rescheduled} />
          <StatCard label={t('group.remaining')} value={summary.remaining} />
          <StatCard label={t('group.completion')} value={summary.completion_pct != null ? `${summary.completion_pct}%` : '—'} accent="var(--brand)" />
        </div>
      )}

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <strong style={{ fontSize: '13px' }}>{t('group.zones', 'Zones')} ({zones.length})</strong>
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button variant="secondary" icon={Plus} onClick={() => setZoneFormTarget({})}>{t('group.add_zone', 'Add Zone')}</Button>
          </RoleGate>
        </div>
        {zones.length === 0 && <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>{t('group.no_zone', 'No zone')}</p>}
        {zones.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <tbody>
              {zones.map((z) => (
                <tr key={z.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 4px' }}><strong>{z.code}</strong>{z.name && z.name !== z.code ? ` — ${z.name}` : ''}</td>
                  <td style={{ padding: '8px 4px' }} className="tabular-nums">{z.route_count} {t('group.routes')}</td>
                  <td style={{ padding: '8px 4px' }}><StatusBadge status={z.status} /></td>
                  <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                    <RoleGate roles={['admin', 'gudoomiye']}>
                      <Button variant="ghost" icon={Pencil} style={{ padding: '4px 8px', fontSize: '12px' }} onClick={() => setZoneFormTarget(z)}>{t('group.edit')}</Button>
                    </RoleGate>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <strong style={{ fontSize: '13px' }}>{t('group.m.routesN', undefined, { n: group.routes?.length || 0 })}</strong>
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button variant="secondary" icon={Plus} onClick={() => setRouteFormOpen(true)}>{t('group.add_route')}</Button>
          </RoleGate>
        </div>
        {(!group.routes || group.routes.length === 0) && (
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>{t('group.no_routes_yet_in_this')}</p>
        )}
        {group.routes && group.routes.length > 0 && (
          <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <tbody>
              {routeSections.map((sec) => (
                <React.Fragment key={sec.key}>
                  <tr><td colSpan={6} style={{ padding: '10px 4px 4px', fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)' }}>{sec.label}</td></tr>
                  {sec.routes.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 4px' }}><strong>{r.code}</strong>{r.name && r.name !== r.code ? ` — ${r.name}` : ''}</td>
                  <td style={{ padding: '8px 4px', color: r.collector_name ? 'inherit' : 'var(--text-muted)' }}>
                    {r.collector_name || t('group.unassigned', 'Unassigned')}
                    {r.truck_plate && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{r.truck_plate}</div>}
                    <div style={{ fontSize: '11px', color: r.cashier_name ? 'var(--text-muted)' : 'var(--warning)' }}>
                      {t('subzone.cashier', 'Cashier')}: {r.cashier_name || t('subzone.noCashier', 'none')}
                    </div>
                  </td>
                  <td style={{ padding: '8px 4px', fontSize: '11px' }}><DaysText days={r.work_days} /></td>
                  <td style={{ padding: '8px 4px' }} className="tabular-nums">{t('group.m.nCustomers', undefined, { n: r.customer_count })}</td>
                  <td style={{ padding: '8px 4px' }}><StatusBadge status={r.status} /></td>
                  <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                    <RoleGate roles={['admin', 'gudoomiye']}>
                      <Button variant="ghost" icon={Pencil} style={{ padding: '4px 8px', fontSize: '12px' }} onClick={() => setEditRouteTarget(r)}>{t('group.edit')}</Button>
                    </RoleGate>
                  </td>
                </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </Card>

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <strong style={{ fontSize: '13px' }}>
          {t('cust.customers')} {customersMeta ? `(${customersMeta.total})` : ''}
        </strong>
        {customers.length === 0 && <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>{t('group.no_customers_in_this_group')}</p>}
        {customers.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginTop: '8px' }}>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => navigate(`/customers/${c.id}`)}>
                  <td style={{ padding: '8px 4px' }}>{c.business_name || c.name} <span style={{ color: 'var(--text-muted)' }}>({c.customer_number})</span></td>
                  <td style={{ padding: '8px 4px', textTransform: 'capitalize' }}>{t('cust.' + c.customer_type, c.customer_type)}</td>
                  <td style={{ padding: '8px 4px' }}><StatusBadge status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {customersMeta && customersMeta.total > customers.length && (
          <p style={{ margin: '10px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>
            {t('group.m.showing', undefined, { shown: customers.length, total: customersMeta.total })}
          </p>
        )}
      </Card>

      {performance.length > 0 && (
        <Card style={{ padding: '16px', marginTop: '16px' }}>
          <strong style={{ fontSize: '13px' }}>{t('group.collector_performance_in_this_group')}</strong>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginTop: '8px' }}>
            <tbody>
              {performance.map((p) => (
                <tr key={p.collector_id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 4px' }}>{p.collector_name}</td>
                  <td style={{ padding: '8px 4px' }} className="tabular-nums">{t('group.m.nServiced', undefined, { n: p.serviced })}</td>
                  <td style={{ padding: '8px 4px' }} className="tabular-nums">{t('group.m.nMissed', undefined, { n: p.missed })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '16px' }}>
        {t('group.collector_assignment_for_this_group')}
      </p>

      <GroupFormModal open={editOpen} onClose={() => setEditOpen(false)} group={group} />
      <RouteFormModal open={routeFormOpen} onClose={() => setRouteFormOpen(false)} groupId={group.id} zones={zones} districtId={group.zone_id} />
      <EditRouteModal route={editRouteTarget} zones={zones} districtId={group.zone_id} onClose={() => setEditRouteTarget(null)} onDone={refetch} />
      {zoneFormTarget && <ZoneFormModal groupId={group.id} zone={zoneFormTarget.id ? zoneFormTarget : null} onClose={() => setZoneFormTarget(null)} />}
    </div>
  );
}

function EditRouteModal({ route, zones, districtId, onClose, onDone }) {
  const { t } = useI18n();
  const [code, setCode] = useState(route?.code || '');
  const [name, setName] = useState(route?.name || '');
  const [status, setStatus] = useState(route?.status || 'active');
  const [collectorId, setCollectorId] = useState(route?.collector_user_id ? String(route.collector_user_id) : '');
  const [cashierId, setCashierId] = useState(route?.cashier_user_id ? String(route.cashier_user_id) : '');
  const [zoneId, setZoneId] = useState(route?.group_zone_id ? String(route.group_zone_id) : '');
  const [workDays, setWorkDays] = useState(Array.isArray(route?.work_days) ? route.work_days : []);
  const [truckId, setTruckId] = useState(route?.truck_id ? String(route.truck_id) : '');
  const [startPt, setStartPt] = useState(startOf(route));
  const [error, setError] = useState('');
  const update = useUpdateRoute(route?.id);
  const toast = useToast();

  React.useEffect(() => {
    if (route) { setCode(route.code); setName(route.name || ''); setStatus(route.status); setCollectorId(route.collector_user_id ? String(route.collector_user_id) : ''); setCashierId(route.cashier_user_id ? String(route.cashier_user_id) : ''); setZoneId(route.group_zone_id ? String(route.group_zone_id) : ''); setWorkDays(Array.isArray(route.work_days) ? route.work_days : []); setTruckId(route.truck_id ? String(route.truck_id) : ''); setStartPt(startOf(route)); setError(''); }
  }, [route]);

  if (!route) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!code.trim()) { setError(t('group.route_code_is_required')); return; }
    if (collectorId && workDays.length === 0) { setError(t('subzone.workDaysRequired')); return; }
    const sp = startPayload(startPt);
    if (!sp) { setError(t('subzone.startInvalid')); return; }
    try {
      await update.mutateAsync({ code: code.trim(), name: name.trim() || null, status, collector_user_id: collectorId ? parseInt(collectorId, 10) : null, cashier_user_id: cashierId ? parseInt(cashierId, 10) : null, group_zone_id: zoneId ? parseInt(zoneId, 10) : null, work_days: workDays, truck_id: truckId ? parseInt(truckId, 10) : null, ...sp });
      toast.success(t('group.route_updated'));
      onDone?.();
      onClose();
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      onClose={update.isPending ? () => {} : onClose}
      title={t('group.edit_route')}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={update.isPending}>{t('common.cancel')}</Button>
        <Button type="submit" form="edit-route-form" disabled={update.isPending}>{update.isPending ? t('common.saving') : t('group.save_changes')}</Button>
      </>}
    >
      <form id="edit-route-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('group.route_code')}</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('group.name_optional')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </label>
        <ZoneSelect value={zoneId} onChange={setZoneId} zones={zones} />
        <CollectorSelect value={collectorId} onChange={setCollectorId} current={route} />
        <CashierSelect value={cashierId} onChange={setCashierId} current={route} />
        <WorkDaysPicker value={workDays} onChange={setWorkDays} required={!!collectorId} />
        <TruckSelect value={truckId} onChange={setTruckId} districtId={districtId} current={route} />
        <StartPointInput value={startPt} onChange={setStartPt} />
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('common.status')}</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
            <option value="active">{t('status.active')}</option>
            <option value="inactive">{t('status.inactive')}</option>
          </select>
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function RouteFormModal({ open, onClose, groupId, zones, districtId }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [collectorId, setCollectorId] = useState('');
  const [cashierId, setCashierId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [workDays, setWorkDays] = useState([]);
  const [truckId, setTruckId] = useState('');
  const [startPt, setStartPt] = useState({ lat: '', lng: '' });
  const [error, setError] = useState('');
  const createRoute = useCreateRoute();
  const toast = useToast();
  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!code.trim()) { setError(t('group.route_code_is_required')); return; }
    if (collectorId && workDays.length === 0) { setError(t('subzone.workDaysRequired')); return; }
    const sp = startPayload(startPt);
    if (!sp) { setError(t('subzone.startInvalid')); return; }
    try {
      await createRoute.mutateAsync({ group_id: groupId, code: code.trim(), name: name.trim() || null, collector_user_id: collectorId ? parseInt(collectorId, 10) : null, cashier_user_id: cashierId ? parseInt(cashierId, 10) : null, group_zone_id: zoneId ? parseInt(zoneId, 10) : null, work_days: workDays, truck_id: truckId ? parseInt(truckId, 10) : null, ...sp });
      toast.success(t('fin.m.created', undefined, { number: code }));
      setCode(''); setName(''); setCollectorId(''); setCashierId(''); setZoneId(''); setWorkDays([]); setTruckId(''); setStartPt({ lat: '', lng: '' }); setError('');
      onClose();
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      onClose={createRoute.isPending ? () => {} : onClose}
      title={t('group.add_route')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createRoute.isPending}>{t('common.cancel')}</Button>
          <Button type="submit" form="route-form" disabled={createRoute.isPending}>{createRoute.isPending ? t('common.saving') : t('group.save_route')}</Button>
        </>
      }
    >
      <form id="route-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('group.route_code')}</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} style={inputStyle} placeholder="e.g. Route 07-A" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('group.name_optional')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </label>
        <ZoneSelect value={zoneId} onChange={setZoneId} zones={zones} />
        <CollectorSelect value={collectorId} onChange={setCollectorId} />
        <CashierSelect value={cashierId} onChange={setCashierId} />
        <WorkDaysPicker value={workDays} onChange={setWorkDays} required={!!collectorId} />
        <TruckSelect value={truckId} onChange={setTruckId} districtId={districtId} />
        <StartPointInput value={startPt} onChange={setStartPt} />
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function DaysText({ days }) {
  const { t } = useI18n();
  const list = Array.isArray(days) ? days : [];
  if (list.length === 0) return <span style={{ color: 'var(--warning)' }}>{t('subzone.noWorkDays')}</span>;
  return <span style={{ color: 'var(--text-muted)' }}>{WEEK_DAYS.filter((d) => list.includes(d)).map((d) => t('cust.day_' + d)).join(' · ')}</span>;
}

// Sub Zone work days: every customer of the Sub Zone is on the daily list on
// these days (a customer's own work days, if set, override them).
function WorkDaysPicker({ value, onChange, required }) {
  const { t } = useI18n();
  const missing = required && value.length === 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('subzone.workDays')}{required ? ' *' : ''}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
        {WEEK_DAYS.map((d) => {
          const on = value.includes(d);
          return (
            <button key={d} type="button" aria-pressed={on}
              onClick={() => onChange(on ? value.filter((x) => x !== d) : WEEK_DAYS.filter((x) => x === d || value.includes(x)))}
              style={{ padding: '6px 11px', borderRadius: '999px', fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit',
                border: '1px solid ' + (on ? 'var(--brand)' : missing ? 'var(--danger)' : 'var(--border)'),
                background: on ? 'var(--success-bg)' : 'transparent', color: on ? 'var(--brand)' : 'var(--text)' }}>
              {t('cust.day_' + d)}
            </button>
          );
        })}
      </div>
      {missing && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{t('subzone.workDaysRequired')}</span>}
    </div>
  );
}

// Route order start point (where the collector starts the day). Optional;
// both blank clears it. "Use my location" fills it from this device's GPS.
function startOf(route) {
  return { lat: route?.start_lat != null ? String(Number(route.start_lat)) : '', lng: route?.start_lng != null ? String(Number(route.start_lng)) : '' };
}
// {start_lat, start_lng} for the API, or null when the input is invalid.
function startPayload(v) {
  const la = String(v.lat).trim();
  const ln = String(v.lng).trim();
  if (!la && !ln) return { start_lat: null, start_lng: null };
  const a = Number(la);
  const b = Number(ln);
  if (!la || !ln || !Number.isFinite(a) || !Number.isFinite(b) || a < -90 || a > 90 || b < -180 || b > 180) return null;
  return { start_lat: a, start_lng: b };
}
function StartPointInput({ value, onChange }) {
  const { t } = useI18n();
  const [locating, setLocating] = useState(false);
  function useMine() {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocating(false); onChange({ lat: pos.coords.latitude.toFixed(6), lng: pos.coords.longitude.toFixed(6) }); },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('subzone.startPoint')}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <input inputMode="decimal" placeholder={t('subzone.lat')} value={value.lat} onChange={(e) => onChange({ ...value, lat: e.target.value })} style={{ ...inputStyle, flex: '1 1 110px', minWidth: 0 }} />
        <input inputMode="decimal" placeholder={t('subzone.lng')} value={value.lng} onChange={(e) => onChange({ ...value, lng: e.target.value })} style={{ ...inputStyle, flex: '1 1 110px', minWidth: 0 }} />
        <Button type="button" variant="secondary" onClick={useMine} disabled={locating}>{locating ? t('common.loading') : t('subzone.useMyLocation')}</Button>
      </div>
      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('subzone.startPointHint')}</span>
    </div>
  );
}

// Default truck for the Sub Zone's daily lists — trucks of this district or company-wide, not retired.
function TruckSelect({ value, onChange, districtId, current }) {
  const { t } = useI18n();
  const { data } = useDailyListOptions(districtId, !!districtId);
  const trucks = data?.data?.trucks || [];
  const hasCurrent = !value || trucks.some((tk) => String(tk.id) === value);
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('subzone.defaultTruck')}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
        <option value="">{t('subzone.noTruck')}</option>
        {!hasCurrent && <option value={value}>{current?.truck_plate || `#${value}`}</option>}
        {trucks.map((tk) => <option key={tk.id} value={String(tk.id)}>{tk.plate_number}{tk.model ? ` — ${tk.model}` : ''}</option>)}
      </select>
    </label>
  );
}

function ZoneSelect({ value, onChange, zones }) {
  const { t } = useI18n();
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('group.zone', 'Zone')}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
        <option value="">{t('group.no_zone', 'No zone')}</option>
        {(zones || []).filter((z) => z.status === 'active' || String(z.id) === value).map((z) => <option key={z.id} value={String(z.id)}>{z.name ? `${z.code} — ${z.name}` : z.code}</option>)}
      </select>
    </label>
  );
}

function ZoneFormModal({ groupId, zone, onClose }) {
  const { t } = useI18n();
  const [code, setCode] = useState(zone?.code || '');
  const [name, setName] = useState(zone?.name || '');
  const [status, setStatus] = useState(zone?.status || 'active');
  const [error, setError] = useState('');
  const create = useCreateGroupZone();
  const update = useUpdateGroupZone(zone?.id);
  const toast = useToast();
  const busy = create.isPending || update.isPending;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!code.trim()) { setError(t('group.zone_code_required', 'Zone code is required.')); return; }
    try {
      if (zone) await update.mutateAsync({ code: code.trim(), name: name.trim() || null, status });
      else await create.mutateAsync({ group_id: groupId, code: code.trim(), name: name.trim() || null });
      toast.success(t('group.zone', 'Zone'));
      onClose();
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={zone ? t('group.edit_zone', 'Edit Zone') : t('group.add_zone', 'Add Zone')}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button type="submit" form="zone-form" disabled={busy}>{busy ? t('common.saving') : t('group.save_changes')}</Button>
      </>}
    >
      <form id="zone-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('group.zone', 'Zone')}</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} style={inputStyle} placeholder="e.g. Zone A" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('group.name_optional')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </label>
        {zone && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('common.status')}</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
              <option value="active">{t('status.active')}</option>
              <option value="inactive">{t('status.inactive')}</option>
            </select>
          </label>
        )}
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

// Collector assignment for a Sub Zone. Lists active collectors; if the route's
// current collector is inactive it is still shown so the value is not silently lost.
// GET /v2/users is admin-only, so non-admins get a read-only display instead.
function CollectorSelect({ value, onChange, current }) {
  const { t } = useI18n();
  const isAdmin = (useAuth().user?.role || '').toLowerCase() === 'admin';
  const { data } = useUsers(isAdmin);
  const collectors = (data?.data || []).filter((u) => (u.role || '').toLowerCase() === 'collector' && (u.is_active || String(u.id) === value));
  const label = (u) => u.full_name || u.name || u.username || u.email || `#${u.id}`;
  if (!isAdmin) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('group.collector', 'Collector')}</span>
        <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{current?.collector_name || t('group.unassigned', 'Unassigned')}</span>
      </div>
    );
  }
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('group.collector', 'Collector')}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
        <option value="">{t('group.unassigned', 'Unassigned')}</option>
        {collectors.map((u) => <option key={u.id} value={String(u.id)}>{label(u)}</option>)}
      </select>
    </label>
  );
}

// Cashier responsible for a Sub Zone's money (Cashout V2). Same rules as
// the collector selector: active cashiers listed, an inactive current one
// kept visible; read-only for non-admins (GET /v2/users is admin-only).
function CashierSelect({ value, onChange, current }) {
  const { t } = useI18n();
  const isAdmin = (useAuth().user?.role || '').toLowerCase() === 'admin';
  const { data } = useUsers(isAdmin);
  const cashiers = (data?.data || []).filter((u) => (u.role || '').toLowerCase() === 'cashier' && (u.is_active || String(u.id) === value));
  const label = (u) => u.full_name || u.name || u.username || u.email || `#${u.id}`;
  if (!isAdmin) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('subzone.cashier', 'Cashier')}</span>
        <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{current?.cashier_name || t('group.unassigned', 'Unassigned')}</span>
      </div>
    );
  }
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('subzone.cashier', 'Cashier')}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
        <option value="">{t('group.unassigned', 'Unassigned')}</option>
        {cashiers.map((u) => <option key={u.id} value={String(u.id)}>{label(u)}{u.zone ? ` — ${u.zone}` : ''}</option>)}
      </select>
      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('subzone.cashierHint')}</span>
    </label>
  );
}

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
