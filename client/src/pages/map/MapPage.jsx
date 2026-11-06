import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MapPin, ListFilter, Route as RouteIcon, Layers, Search, CalendarCheck, ChevronDown, ChevronUp, MapPinOff } from 'lucide-react';
import { PageHeader, LoadingState, ErrorState } from '../../components/ui/index.js';
import { useMapCustomers, useMapMissingLocation, useMapTrucks } from '../../hooks/useMap.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useGroups, useRoutesForGroup } from '../../hooks/useGroups.js';
import { useGroupZones } from '../../hooks/useGroupZones.js';
import { apiClient } from '../../lib/apiClient.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import MapCanvas from './MapCanvas.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { PAYMENT_STATUSES, PAYMENT_COLORS, TODAY_STATUSES, TODAY_COLORS, customerPath, matchCustomer } from './mapStatus.js';

// Route & GIS / Map. Hierarchy: District (zones) > Group > Zone
// (group_zones) > Sub Zone (routes) > Customer. This page owns filter state,
// data fetching, search, the legend/counts, the "Today" toggle and the
// missing-location side panel; MapCanvas owns the Mapbox instance.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'head_of_cashiers'];

export default function MapPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [zoneId, setZoneId] = useState(''); // District
  const [groupId, setGroupId] = useState('');
  const [groupZoneId, setGroupZoneId] = useState('');
  const [routeId, setRouteId] = useState('');
  const [showToday, setShowToday] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searchMsg, setSearchMsg] = useState('');
  const [focus, setFocus] = useState(null);

  const isZoneScoped = ZONE_SCOPED_ROLES.includes((user?.role || '').toLowerCase());
  const { data: zonesData } = useZonesList();
  const districts = zonesData?.data || [];

  // Group dropdown scoped to the selected district (Admin) or the caller's
  // own district (non-Admin) — server enforces the real boundary regardless.
  const { data: groupsData } = useGroups(zoneId ? { zone_id: zoneId } : {});
  const groups = groupsData?.data || [];

  const { data: gzData } = useGroupZones(groupId || undefined);
  const groupZones = gzData?.data || [];

  // Sub Zones of the selected group; narrowed to the chosen Zone, otherwise
  // all of the group's Sub Zones (including those with no Zone).
  const { data: routesData } = useRoutesForGroup(groupId || undefined);
  const routes = useMemo(() => {
    const all = routesData?.data || [];
    return groupZoneId ? all.filter((r) => String(r.group_zone_id) === String(groupZoneId)) : all;
  }, [routesData, groupZoneId]);

  const filters = {
    zoneId: isZoneScoped ? undefined : (zoneId || undefined), // server forces the district for scoped roles anyway
    groupId: groupId || undefined,
    groupZoneId: groupZoneId || undefined,
    routeId: routeId || undefined,
  };
  const { data, isLoading, error, refetch } = useMapCustomers({ ...filters, today: showToday });
  const points = useMemo(() => data?.data || [], [data]);
  const { data: missingData } = useMapMissingLocation(filters);
  const missing = useMemo(() => missingData?.data || [], [missingData]);

  const { data: trucksData } = useMapTrucks({ zoneId: isZoneScoped ? undefined : (zoneId || undefined) });
  const trucks = trucksData?.data || [];

  const payCounts = useMemo(() => {
    const c = { clear: 0, partial: 0, unpaid: 0, none: 0 };
    points.forEach((p) => { c[p.payment_status in c ? p.payment_status : 'none'] += 1; });
    return c;
  }, [points]);
  const todayCounts = useMemo(() => {
    const c = { serviced: 0, pending: 0, missed: 0, skipped: 0, not_scheduled: 0 };
    points.forEach((p) => { c[p.today_status in c ? p.today_status : 'not_scheduled'] += 1; });
    return c;
  }, [points]);

  function handleDistrictChange(v) { setZoneId(v); setGroupId(''); setGroupZoneId(''); setRouteId(''); }
  function handleGroupChange(v) { setGroupId(v); setGroupZoneId(''); setRouteId(''); }
  function handleGroupZoneChange(v) { setGroupZoneId(v); setRouteId(''); }

  async function runSearch(e) {
    e.preventDefault();
    setSearchMsg('');
    if (!query.trim()) return;
    const hit = matchCustomer(points, query);
    if (hit) { setFocus({ id: hit.id, n: Date.now() }); return; }
    if (matchCustomer(missing, query)) { setSearchMsg(t('map.search_no_location')); setPanelOpen(true); return; }
    // Not on the map or in the missing list: does the customer exist outside the current filters?
    // (/customers is already district-scoped server-side.)
    try {
      const res = await apiClient.get(`/v2/customers?limit=1&q=${encodeURIComponent(query.trim())}`);
      setSearchMsg((res?.data || []).length > 0 ? t('map.search_outside_filters') : t('map.search_not_found'));
    } catch {
      setSearchMsg(t('map.search_not_found'));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ marginBottom: '14px' }}>
        <PageHeader
          icon={MapPin}
          title={t('nav.map')}
          subtitle={t('map.read_only_view_of_customer')}
        />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
        {!isZoneScoped && (
          <SelectField icon={MapPin} label={t('map.f.district')} value={zoneId} onChange={handleDistrictChange}>
            <option value="">{t('map.f.all_districts')}</option>
            {districts.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </SelectField>
        )}
        <SelectField icon={ListFilter} label={t('map.f.group')} value={groupId} onChange={handleGroupChange}>
          <option value="">{t('map.all_groups')}</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name || g.code}</option>)}
        </SelectField>
        <SelectField icon={Layers} label={t('map.f.zone')} value={groupZoneId} onChange={handleGroupZoneChange} disabled={!groupId}>
          <option value="">{t('map.f.all_zones')}</option>
          {groupZones.map((z) => <option key={z.id} value={z.id}>{z.name || z.code}</option>)}
        </SelectField>
        <SelectField icon={RouteIcon} label={t('map.f.subzone')} value={routeId} onChange={setRouteId} disabled={!groupId}>
          <option value="">{t('map.f.all_subzones')}</option>
          {routes.map((r) => <option key={r.id} value={r.id}>{r.name || r.code}</option>)}
        </SelectField>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px', alignItems: 'center' }}>
        <form onSubmit={runSearch} style={{ display: 'flex', gap: '6px', flex: '1 1 260px', maxWidth: '420px' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSearchMsg(''); }}
              placeholder={t('map.search_ph')}
              aria-label={t('map.search')}
              style={{ ...fieldStyle, padding: '8px 10px 8px 30px' }}
            />
          </div>
          <button type="submit" style={btnStyle(false)}>{t('map.search')}</button>
        </form>
        <button type="button" onClick={() => setShowToday((v) => !v)} aria-pressed={showToday} style={btnStyle(showToday)}>
          <CalendarCheck size={14} /> {t('map.today')}
        </button>
        <button type="button" onClick={() => setPanelOpen((v) => !v)} aria-expanded={panelOpen} style={btnStyle(false)}>
          <MapPinOff size={14} /> {t('map.no_location_count', undefined, { n: missing.length })}
          {panelOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {searchMsg && <span role="status" style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 600 }}>{searchMsg}</span>}
      </div>

      {/* Legend: payment-status colours with counts, total pins; Today counts when on. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', marginBottom: '10px', fontSize: '12.5px', alignItems: 'center' }}>
        <strong>{t('map.pins', undefined, { n: points.length })}</strong>
        {PAYMENT_STATUSES.map((s) => (
          <LegendItem key={s} color={PAYMENT_COLORS[s]} label={t('map.pay.' + s)} count={payCounts[s]} />
        ))}
        {showToday && (
          <>
            <span style={{ color: 'var(--text-muted)' }}>|</span>
            <strong>{t('map.today')}</strong>
            {TODAY_STATUSES.map((s) => (
              <LegendItem key={s} color={TODAY_COLORS[s]} label={t('map.today.' + s)} count={todayCounts[s]} round />
            ))}
          </>
        )}
      </div>

      {isLoading && <LoadingState label={t('map.loading_map')} />}
      {!isLoading && error && <ErrorState message={error.message} onRetry={refetch} />}
      {!isLoading && !error && (
        <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: '12px', minHeight: '60vh' }}>
          <div style={{ flex: '1 1 480px', minWidth: 0, maxWidth: '100%', minHeight: '60vh', position: 'relative' }}>
            <MapCanvas
              points={points}
              trucks={trucks}
              showToday={showToday}
              focus={focus}
              onOpenCustomer={(id) => navigate(`/customers/${id}`)}
            />
            {points.length === 0 && trucks.length === 0 && (
              <div style={{
                position: 'absolute', top: '12px', left: '50%', transform: 'translateX(-50%)', zIndex: 1,
                display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 14px',
                background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-md)', fontSize: '13px', color: 'var(--text-muted)', fontWeight: 600,
              }}>
                <MapPin size={14} />
                {t('map.m.noLocations')}
              </div>
            )}
          </div>

          {panelOpen && (
            <aside
              aria-label={t('map.no_location')}
              style={{
                flex: '1 1 280px', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box', maxHeight: '70vh', overflowY: 'auto',
                background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '10px',
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: '2px' }}>{t('map.no_location_count', undefined, { n: missing.length })}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>{t('map.no_location_hint')}</div>
              {missing.length === 0 && <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{t('map.no_location_empty')}</div>}
              {missing.map((c) => (
                <Link
                  key={c.id}
                  to={`/customers/${c.id}`}
                  style={{ display: 'block', padding: '7px 4px', borderTop: '1px solid var(--border)', textDecoration: 'none', color: 'var(--text)', fontSize: '13px' }}
                >
                  <div style={{ fontWeight: 600 }}>{c.customer_number} · {c.name}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{customerPath(c) || '—'}</div>
                </Link>
              ))}
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

const fieldStyle = {
  width: '100%', padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px', fontFamily: 'inherit', boxSizing: 'border-box',
};

function btnStyle(active) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 12px', borderRadius: 'var(--radius-sm)',
    border: '1px solid ' + (active ? 'var(--brand)' : 'var(--border)'), cursor: 'pointer', fontSize: '13px', fontWeight: 600, fontFamily: 'inherit',
    background: active ? 'var(--brand)' : 'var(--surface)', color: active ? '#fff' : 'var(--text)',
  };
}

function LegendItem({ color, label, count, round }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', color: 'var(--text)' }}>
      <span style={{ width: '10px', height: '10px', borderRadius: round ? '50%' : '3px', background: color, display: 'inline-block' }} />
      {label} <strong>{count}</strong>
    </span>
  );
}

function SelectField({ icon: Icon, label, value, onChange, disabled, children }) {
  return (
    <div style={{ position: 'relative', flex: '1 1 150px', maxWidth: '220px', minWidth: '140px' }}>
      <Icon size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label={label}
        title={label}
        style={{
          ...fieldStyle, padding: '8px 10px 8px 30px',
          opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {children}
      </select>
    </div>
  );
}
