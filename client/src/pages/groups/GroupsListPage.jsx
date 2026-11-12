import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Boxes, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useGroups } from '../../hooks/useGroups.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import GroupFormModal from './GroupFormModal.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';

// Groups List — Group & Group-Based Collection CR, Spec §22. No fixed cap on
// how many Groups a Zone can have (Locked Decision #1 — "31+ groups, no
// hardcoded maximum"); this page paginates rather than assuming a small set.
export default function GroupsListPage() {
  const { t } = useI18n();
  const [zoneFilter, setZoneFilter] = useState('');
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useGroups({ zone_id: zoneFilter || undefined, search: search || undefined });
  const { data: zonesData } = useZonesList();
  const groups = data?.data || [];
  const zones = zonesData?.data || [];

  return (
    <div>
      <PageHeader
        icon={Boxes}
        title={t('nav.groups')}
        subtitle={t('group.operational_sub_divisions_of_a')}
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>{t('group.create_group')}</Button>
          </RoleGate>
        }
      />

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder={t('group.search_by_code_or_name')}>
        <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} style={selectStyle}>
          <option value="">{t('group.all_zones')}</option>
          {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && groups.length === 0}
        emptyTitle={t('group.no_groups_yet')}
        emptySubtitle={t('group.create_the_first_group_to')}
        columns={[{ label: t('group.group') }, { label: t('common.zone') }, { label: t('nav.customers') }, { label: t('opsp.col.zones') }, { label: t('group.routes') }, { label: t('opsp.col.collectors') }, { label: t('common.status') }]}
      >
        {groups.map((g) => (
          <tr key={g.id} onClick={() => navigate(`/groups/${g.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}>
              <strong>{g.code}</strong>{g.name && g.name !== g.code ? <span style={{ color: 'var(--text-muted)' }}> — {g.name}</span> : null}
              {g.is_empty && <span style={emptyChipStyle} title={t('opsp.emptyHint')}>{t('opsp.empty')}</span>}
            </td>
            <td style={cellStyle}>{g.zone_name}</td>
            <td style={cellStyle} className="tabular-nums">{g.customer_count}</td>
            <td style={cellStyle} className="tabular-nums">{g.group_zone_count ?? 0}</td>
            <td style={cellStyle} className="tabular-nums">{g.route_count}</td>
            <td style={cellStyle} title={(g.collectors || []).map((c) => c.name).join(', ')}>{collectorSummary(g.collectors, t)}</td>
            <td style={cellStyle}><StatusBadge status={g.status} /></td>
          </tr>
        ))}
      </DataTable>

      <GroupFormModal open={formOpen} onClose={() => setFormOpen(false)} defaultZoneId={zoneFilter || undefined} />
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const emptyChipStyle = {
  marginLeft: '8px', fontSize: '11px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px',
  color: 'var(--warning)', border: '1px solid var(--warning)', whiteSpace: 'nowrap',
};

// "Axmed +1": first collector's first name (truncated), then how many more.
// The full list is in the cell's title tooltip.
function collectorSummary(collectors, t) {
  const list = collectors || [];
  if (list.length === 0) return '—';
  const first = (list[0].name || '').trim().split(/\s+/)[0];
  const short = first.length > 18 ? `${first.slice(0, 17)}…` : first;
  return list.length > 1 ? `${short} ${t('opsp.moreN', undefined, { n: list.length - 1 })}` : short;
}
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
