import React, { useState } from 'react';
import { MapPin, ListFilter, Route as RouteIcon } from 'lucide-react';
import { PageHeader, LoadingState, ErrorState, EmptyState } from '../../components/ui/index.js';
import { useMapCustomers } from '../../hooks/useMap.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useGroups, useRoutesForGroup } from '../../hooks/useGroups.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import MapCanvas from './MapCanvas.jsx';

// Route & GIS / Map — Implementation Spec §16/§17. V1: read-only
// customer-pin visualization plus Zone/Group/Route filtering. No
// editing, no routing, no live tracking. Mapbox GL JS is the approved
// rendering platform (MapCanvas.jsx) — this page owns only filter
// state, data fetching, and the loading/empty/error states, mirroring
// CalendarPage.jsx's own established structure exactly.
const ZONE_SCOPED_ROLES = ['gudoomiye', 'zone_accountant', 'head_of_cashiers'];

export default function MapPage() {
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

  function handleGroupChange(value) {
    setGroupId(value);
    setRouteId(''); // route filter depends on group; clear a now-stale selection
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ marginBottom: '14px' }}>
        <PageHeader
          icon={MapPin}
          title="Map"
          subtitle="Read-only view of customer locations by zone, group, and route."
        />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
        {!isZoneScoped && (
          <SelectField icon={MapPin} value={zoneId} onChange={setZoneId}>
            <option value="">All zones</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </SelectField>
        )}
        <SelectField icon={ListFilter} value={groupId} onChange={handleGroupChange}>
          <option value="">All groups</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name || g.code}</option>)}
        </SelectField>
        <SelectField icon={RouteIcon} value={routeId} onChange={setRouteId} disabled={!groupId}>
          <option value="">All routes</option>
          {routes.map((r) => <option key={r.id} value={r.id}>{r.name || r.code}</option>)}
        </SelectField>
      </div>

      {isLoading && <LoadingState label="Loading map…" />}
      {!isLoading && error && <ErrorState message={error.message} onRetry={refetch} />}
      {!isLoading && !error && points.length === 0 && (
        <EmptyState icon={MapPin} title="No customer locations in this view" subtitle="Try a different zone, group, or route, or clear the filters." />
      )}
      {!isLoading && !error && points.length > 0 && (
        <div style={{ flex: 1, minHeight: '60vh' }}>
          <MapCanvas points={points} />
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
