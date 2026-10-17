import React, { useState } from 'react';
import { MapPin, ListFilter, Route as RouteIcon } from 'lucide-react';
import { PageHeader, LoadingState, ErrorState } from '../../components/ui/index.js';
import { useMapCustomers, useMapTrucks } from '../../hooks/useMap.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useGroups, useRoutesForGroup } from '../../hooks/useGroups.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import MapCanvas from './MapCanvas.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';

// Route & GIS / Map — Implementation Spec §16/§17. V1: read-only
// customer-pin visualization plus Zone/Group/Route filtering. No
// editing, no routing, no live tracking. Mapbox GL JS is the approved
// rendering platform (MapCanvas.jsx) — this page owns only filter
// state, data fetching, and the loading/empty/error states, mirroring
// CalendarPage.jsx's own established structure exactly.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'head_of_cashiers'];

export default function MapPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [zoneId, setZoneId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [routeId, setRouteId] = useState('');

  const isZoneScoped = ZONE_SCOPED_ROLES.includes((user?.role || '').toLowerCase());
  const { data: zonesData } = useZonesList();
  const zones = zonesData?.data || [];

  // Group dropdown scoped to the selected zone (Admin) or the caller's
  // own zone (non-Admin) — server enforces the real boundary regardless.
  const { data: groupsData } = useGroups(zoneId ? { zone_id: zoneId } : {});
  const groups = groupsData?.data || [];

  // Route dropdown is dependent on Group, matching the existing
  // Group & Route module's own established useRoutesForGroup pattern.
  const { data: routesData } = useRoutesForGroup(groupId || undefined);
  const routes = routesData?.data || [];

  const { data, isLoading, error, refetch } = useMapCustomers({
    zoneId: isZoneScoped ? undefined : (zoneId || undefined), // server forces zone for scoped roles anyway; withheld client-side too, never trusted either way
    groupId: groupId || undefined,
    routeId: routeId || undefined,
  });
  const points = data?.data || [];

  // Trucks — user-requested ('ilaa gawaadhidii ay ka soo muuqato').
  // Same zone-forcing rule as customers above: never trust a scoped
  // role's own zoneId client-side, the server enforces it regardless.
  const { data: trucksData } = useMapTrucks({ zoneId: isZoneScoped ? undefined : (zoneId || undefined) });
  const trucks = trucksData?.data || [];

  function handleGroupChange(value) {
    setGroupId(value);
    setRouteId(''); // route filter depends on group; clear a now-stale selection
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

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
        {!isZoneScoped && (
          <SelectField icon={MapPin} value={zoneId} onChange={setZoneId}>
            <option value="">{t('group.all_zones')}</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </SelectField>
        )}
        <SelectField icon={ListFilter} value={groupId} onChange={handleGroupChange}>
          <option value="">{t('map.all_groups')}</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name || g.code}</option>)}
        </SelectField>
        <SelectField icon={RouteIcon} value={routeId} onChange={setRouteId} disabled={!groupId}>
          <option value="">{t('map.all_routes')}</option>
          {routes.map((r) => <option key={r.id} value={r.id}>{r.name || r.code}</option>)}
        </SelectField>
      </div>

      {isLoading && <LoadingState label={t('map.loading_map')} />}
      {!isLoading && error && <ErrorState message={error.message} onRetry={refetch} />}
      {/* The map itself always renders once loaded — even with zero located
          customers, showing the company's own operating region (Togdheer,
          Somaliland — see MapCanvas.jsx's default view) reads as "this is
          the map, nothing to show yet" rather than hiding the map entirely
          behind an EmptyState, which is indistinguishable from "map is
          broken" to someone who has never seen it render before. */}
      {!isLoading && !error && (
        <div style={{ flex: 1, minHeight: '60vh', position: 'relative' }}>
          <MapCanvas points={points} trucks={trucks} />
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
      )}
    </div>
  );
}

function SelectField({ icon: Icon, value, onChange, disabled, children }) {
  return (
    <div style={{ position: 'relative', flex: '0 1 200px', minWidth: '160px' }}>
      <Icon size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{
          width: '100%', padding: '8px 10px 8px 30px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
          background: 'var(--surface)', color: 'var(--text)', fontSize: '13px', fontFamily: 'inherit', boxSizing: 'border-box',
          opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {children}
      </select>
    </div>
  );
}
