import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Boxes, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useGroups } from '../../hooks/useGroups.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import GroupFormModal from './GroupFormModal.jsx';

// Groups List — Group & Group-Based Collection CR, Spec §22. No fixed cap on
// how many Groups a Zone can have (Locked Decision #1 — "31+ groups, no
// hardcoded maximum"); this page paginates rather than assuming a small set.
export default function GroupsListPage() {
  const [zoneFilter, setZoneFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useGroups({ zone_id: zoneFilter || undefined });
  const { data: zonesData } = useZonesList();
  const groups = data?.data || [];
  const zones = zonesData?.data || [];

  return (
    <div>
      <PageHeader
        icon={Boxes}
        title="Groups"
        subtitle="Operational sub-divisions of a Zone — collection is organized and assigned per Group."
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>Create Group</Button>
          </RoleGate>
        }
      />

      <FilterBar searchValue="" onSearchChange={() => {}} searchPlaceholder="">
        <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} style={selectStyle}>
          <option value="">All zones</option>
          {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && groups.length === 0}
        emptyTitle="No groups yet"
        emptySubtitle="Create the first Group to start organizing collection by Group."
        columns={[{ label: 'Group' }, { label: 'Zone' }, { label: 'Customers' }, { label: 'Routes' }, { label: 'Status' }]}
      >
        {groups.map((g) => (
          <tr key={g.id} onClick={() => navigate(`/groups/${g.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong>{g.code}</strong>{g.name && g.name !== g.code ? <span style={{ color: 'var(--text-muted)' }}> — {g.name}</span> : null}</td>
            <td style={cellStyle}>{g.zone_name}</td>
            <td style={cellStyle} className="tabular-nums">{g.customer_count}</td>
            <td style={cellStyle} className="tabular-nums">{g.route_count}</td>
            <td style={cellStyle}><StatusBadge status={g.status} /></td>
          </tr>
        ))}
      </DataTable>

      <GroupFormModal open={formOpen} onClose={() => setFormOpen(false)} defaultZoneId={zoneFilter || undefined} />
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
