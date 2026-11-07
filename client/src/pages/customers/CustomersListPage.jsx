import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, Card } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useCustomers, useNumberRequests, useZonesList } from '../../hooks/useCustomers.js';
import { useGroups, useRoutesForGroup } from '../../hooks/useGroups.js';
import { useGroupZones } from '../../hooks/useGroupZones.js';
import CustomerFormModal from './CustomerFormModal.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';

export default function CustomersListPage() {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active'); // active | archived | all — OD-1: hidden by default
  const [typeFilter, setTypeFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  // Group › District › Zone › Sub Zone filters (group first; a group fixes the district).
  const [groupId, setGroupId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [groupZoneId, setGroupZoneId] = useState('');
  const [routeId, setRouteId] = useState('');
  const navigate = useNavigate();
  const { data: zonesData } = useZonesList();
  const districts = zonesData?.data || [];
  const { data: groupsData } = useGroups({ limit: 200 });
  const groups = (groupsData?.data || []).filter((g) => !zoneId || String(g.zone_id) === zoneId || String(g.id) === groupId);
  const { data: gzData } = useGroupZones(groupId || undefined);
  const groupZones = groupId ? (gzData?.data || []) : [];
  const { data: routesData } = useRoutesForGroup(groupId || undefined);
  const subZones = groupId ? (routesData?.data || []).filter((r) => !groupZoneId || String(r.group_zone_id) === groupZoneId) : [];

  function onGroup(v) {
    setGroupId(v); setGroupZoneId(''); setRouteId('');
    const g = groups.find((x) => String(x.id) === v);
    if (g) setZoneId(String(g.zone_id));
  }
  function onDistrict(v) { setZoneId(v); setGroupId(''); setGroupZoneId(''); setRouteId(''); }

  const { data, isLoading, error, refetch } = useCustomers({
    q: search || undefined,
    status: statusFilter === 'active' ? undefined : statusFilter,
    customer_type: typeFilter || undefined,
    group_id: groupId || undefined,
    zone_id: zoneId || undefined,
    group_zone_id: groupZoneId || undefined,
    route_id: routeId || undefined,
  });
  const customers = data?.data || [];
  const { user } = useAuth();
  const canSeeRequests = ['admin', 'gudoomiye'].includes((user?.role || '').toLowerCase());
  const { data: reqData } = useNumberRequests({ enabled: canSeeRequests });
  const pendingRequests = reqData?.data || [];

  return (
    <div>
      <PageHeader
        icon={Users}
        title={t('nav.customers')}
        subtitle={t('cust.residential_and_commercial_customers')}
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>{t('cust.create_customer')}</Button>
          </RoleGate>
        }
      />

      {pendingRequests.length > 0 && (
        <Card style={{ padding: '12px 16px', marginBottom: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '6px' }}>{t('cust.m.pendingChanges')} ({pendingRequests.length})</div>
          {pendingRequests.map((r) => (
            <div key={r.id} style={{ fontSize: '13px', padding: '2px 0' }} className="tabular-nums">
              <a href={'/customers/' + r.customer_id} onClick={(e) => { e.preventDefault(); navigate('/customers/' + r.customer_id); }}>{r.customer_name}</a>
              {' — '}{r.old_number} → {r.new_number}
            </div>
          ))}
        </Card>
      )}

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder={t('cust.search_by_customer_number_name')}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="active">{t('status.active')}</option>
          <option value="archived">{t('status.archived')}</option>
          <option value="all">{t('cust.all_statuses')}</option>
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={selectStyle}>
          <option value="">{t('cust.all_types')}</option>
          <option value="residential">{t('cust.residential')}</option>
          <option value="commercial">{t('cust.commercial')}</option>
        </select>
        <select value={groupId} onChange={(e) => onGroup(e.target.value)} style={selectStyle} aria-label={t('map.f.group')}>
          <option value="">{t('map.all_groups')}</option>
          {groups.map((g) => <option key={g.id} value={String(g.id)}>{(g.name || g.code) + (g.zone_name ? ` — ${g.zone_name}` : '')}</option>)}
        </select>
        {districts.length > 1 && (
          <select value={zoneId} onChange={(e) => onDistrict(e.target.value)} style={selectStyle} aria-label={t('map.f.district')}>
            <option value="">{t('map.f.all_districts')}</option>
            {districts.map((z) => <option key={z.id} value={String(z.id)}>{z.name}</option>)}
          </select>
        )}
        <select value={groupZoneId} onChange={(e) => { setGroupZoneId(e.target.value); setRouteId(''); }} style={selectStyle} disabled={!groupId} aria-label={t('map.f.zone')}>
          <option value="">{t('map.f.all_zones')}</option>
          {groupZones.map((z) => <option key={z.id} value={String(z.id)}>{z.name || z.code}</option>)}
        </select>
        <select value={routeId} onChange={(e) => setRouteId(e.target.value)} style={selectStyle} disabled={!groupId} aria-label={t('map.f.subzone')}>
          <option value="">{t('map.f.all_subzones')}</option>
          {subZones.map((r) => <option key={r.id} value={String(r.id)}>{r.name || r.code}</option>)}
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && customers.length === 0}
        emptyTitle={search ? t('cust.no_customers_match_your_search') : t('cust.no_customers_yet')}
        emptySubtitle={search ? t('cust.try_a_different_name_phone') : t('cust.create_the_first_customer_to')}
        columns={[
          { label: t('cust.customer') }, { label: t('common.name') }, { label: t('cust.type') }, { label: t('common.phone') },
          { label: t('common.zone') }, { label: t('cust.door_col', 'Door #') }, { label: t('common.status') },
        ]}
      >
        {customers.map((c) => (
          <tr key={c.id} onClick={() => navigate(`/customers/${c.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong className="tabular-nums">{c.customer_number}</strong></td>
            <td style={cellStyle}>{c.business_name || c.name}</td>
            <td style={cellStyle}><span style={{ textTransform: 'capitalize' }}>{t('cust.' + c.customer_type, c.customer_type)}</span></td>
            <td style={cellStyle} className="tabular-nums">{c.phone}</td>
            <td style={cellStyle}>{c.path || c.zone_name}</td>
            <td style={cellStyle} className="tabular-nums">{c.door_number || '—'}</td>
            <td style={cellStyle}><StatusBadge status={c.status} /></td>
          </tr>
        ))}
      </DataTable>

      <CustomerFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
