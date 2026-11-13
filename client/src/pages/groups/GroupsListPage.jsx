import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Boxes, Plus, Search, X, Route, Users, AlertTriangle, UserRound } from 'lucide-react';
import { PageHeader, Button, LoadingState, ErrorState } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useGroups, useGroupsSummary } from '../../hooks/useGroups.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { groupLabel, districtLabel } from '../../lib/hierarchy.js';
import GroupFormModal from './GroupFormModal.jsx';
import { WRITE_ROLES } from './groupUtils.js';
import '../customers/customers.css';
import './groups.css';

const LIMIT = 200;

// Groups list (Groups V2): summary cards, search + district/status/leader
// filters, table on desktop and cards on phones. No fixed cap on how many
// Groups a district can have (Locked Decision #1).
export default function GroupsListPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const role = (useAuth().user?.role || '').toLowerCase();
  const [zoneFilter, setZoneFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [leaderFilter, setLeaderFilter] = useState('');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  useEffect(() => { const h = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(h); }, [search]);

  const filters = { zone_id: zoneFilter || undefined, status: statusFilter || undefined, leader_user_id: leaderFilter || undefined };
  const { data, isLoading, error, refetch } = useGroups({ ...filters, search: q || undefined, limit: LIMIT });
  const { data: summaryData } = useGroupsSummary(filters);
  const { data: allData } = useGroups({ limit: LIMIT }); // leader filter options
  const { data: zonesData } = useZonesList();
  const groups = data?.data || [];
  const total = data?.meta?.total ?? groups.length;
  const s = summaryData?.data;
  const zones = zonesData?.data || [];
  const leaders = useMemo(() => {
    const m = new Map();
    (allData?.data || []).forEach((g) => { if (g.leader_user_id) m.set(String(g.leader_user_id), g.leader_name || `#${g.leader_user_id}`); });
    if (leaderFilter && leaderFilter !== 'none' && !m.has(leaderFilter)) m.set(leaderFilter, `#${leaderFilter}`);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [allData, leaderFilter]);

  const chips = [];
  if (q) chips.push({ k: 'q', label: `“${q}”`, clear: () => { setSearch(''); setQ(''); } });
  if (zoneFilter) chips.push({ k: 'z', label: districtLabel(zones.find((z) => String(z.id) === zoneFilter)?.name) || `#${zoneFilter}`, clear: () => setZoneFilter('') });
  if (statusFilter) chips.push({ k: 's', label: t('status.' + statusFilter), clear: () => setStatusFilter('') });
  if (leaderFilter) chips.push({ k: 'l', label: leaderFilter === 'none' ? t('gv.noLeader') : leaders.find(([id]) => id === leaderFilter)?.[1], clear: () => setLeaderFilter('') });
  const clearAll = () => { setSearch(''); setQ(''); setZoneFilter(''); setStatusFilter(''); setLeaderFilter(''); };
  const fmt = (v) => (v === undefined || v === null ? '—' : Number(v).toLocaleString('en-US'));
  const gaps = s ? s.sub_zones_no_collector + s.sub_zones_no_cashier + s.sub_zones_no_work_days : null;
  const canSeeSetup = WRITE_ROLES.includes(role);

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

      <div className="gv-stats">
        <div className="gv-stat" style={{ '--accent-c': 'var(--brand)' }}>
          <span className="k"><Boxes size={14} /> {t('nav.groups')}</span>
          <span className="v">{fmt(s?.groups)}</span>
          <span className="s">{s ? t('gv.card.noLeader', undefined, { n: s.groups_without_leader }) : ''}</span>
        </div>
        <div className="gv-stat" style={{ '--accent-c': 'var(--info)' }}>
          <span className="k"><Route size={14} /> {t('gv.subZones')}</span>
          <span className="v">{fmt(s?.sub_zones)}</span>
          <span className="s">{t('gv.card.subZonesSub')}</span>
        </div>
        <div className="gv-stat" style={{ '--accent-c': 'var(--accent)' }}>
          <span className="k"><Users size={14} /> {t('nav.customers')}</span>
          <span className="v">{fmt(s?.customers)}</span>
          <span className="s">{t('gv.card.customersSub')}</span>
        </div>
        <GapsCard s={s} gaps={gaps} linked={canSeeSetup} />
      </div>

      <div className="gv-filters">
        <label className="cl-search">
          <Search size={15} />
          <input className="cl-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('group.search_by_code_or_name')} aria-label={t('group.search_by_code_or_name')} />
        </label>
        {zones.length > 1 && (
          <select className="cl-input" value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} aria-label={t('gv.district')}>
            <option value="">{t('map.f.all_districts')}</option>
            {zones.map((z) => <option key={z.id} value={String(z.id)}>{districtLabel(z.name)}</option>)}
          </select>
        )}
        <select className="cl-input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={t('common.status')}>
          <option value="">{t('gv.anyStatus')}</option>
          <option value="active">{t('status.active')}</option>
          <option value="inactive">{t('status.inactive')}</option>
        </select>
        <select className="cl-input" value={leaderFilter} onChange={(e) => setLeaderFilter(e.target.value)} aria-label={t('gv.leader')}>
          <option value="">{t('gv.anyLeader')}</option>
          <option value="none">{t('gv.noLeader')}</option>
          {leaders.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>
      <div className="cl-chiprow">
        {chips.map((c) => (
          <span key={c.k} className="cl-fchip">
            {c.label}
            <button type="button" aria-label={t('cl.removeFilter', undefined, { f: c.label })} onClick={c.clear}><X size={13} /></button>
          </span>
        ))}
        {chips.length > 0 && <button type="button" className="cl-clear" onClick={clearAll}>{t('cl.clearAll')}</button>}
      </div>

      <div className="cl-card">
        <div className="cl-toolbar">
          <span className="count">{t('gv.showingGroups', undefined, { shown: groups.length, total })}</span>
        </div>
        {isLoading && <LoadingState label={t('common.loading')} />}
        {error && <ErrorState message={error.message} onRetry={refetch} />}
        {!isLoading && !error && groups.length === 0 && (
          <div className="cl-empty">
            <Boxes size={28} />
            <strong>{chips.length ? t('gv.noMatch') : t('group.no_groups_yet')}</strong>
            <span>{chips.length ? t('cust.try_a_different_name_phone') : t('group.create_the_first_group_to')}</span>
            {chips.length > 0 && <Button variant="secondary" onClick={clearAll}>{t('cl.clearAll')}</Button>}
          </div>
        )}
        {!isLoading && !error && groups.length > 0 && (<>
          <div className="cl-table-wrap">
            <table className="cl-table">
              <thead>
                <tr>
                  <th>{t('group.group')}</th>
                  <th>{t('gv.district')}</th>
                  <th>{t('gv.leader')}</th>
                  <th className="r">{t('gv.zones')}</th>
                  <th className="r">{t('gv.subZones')}</th>
                  <th className="r">{t('nav.customers')}</th>
                  <th>{t('gv.collectors')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.id} onClick={() => navigate(`/groups/${g.id}`)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/groups/${g.id}`); }}>
                    <td>
                      <div className="gv-gname"><span className="code">{groupLabel(g.code, g.name)}</span></div>
                      {g.is_empty && <div className="cl-chips"><span className="cl-chip warning" title={t('opsp.emptyHint')}>{t('opsp.empty')}</span></div>}
                    </td>
                    <td>{districtLabel(g.zone_name)}</td>
                    <td><LeaderText g={g} /></td>
                    <td className="r tabular-nums">{g.group_zone_count ?? 0}</td>
                    <td className="r tabular-nums">{g.route_count}</td>
                    <td className="r tabular-nums">{g.customer_count}</td>
                    <td title={(g.collectors || []).map((c) => c.name).join(', ')}>{collectorSummary(g.collectors, t)}</td>
                    <td><StatusChip status={g.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="cl-cards">
            {groups.map((g) => (
              <div key={g.id} className="cl-mcard" role="button" tabIndex={0} onClick={() => navigate(`/groups/${g.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/groups/${g.id}`); }}>
                <div className="top">
                  <div style={{ minWidth: 0 }}>
                    <div className="gv-gname"><span className="code">{groupLabel(g.code, g.name)}</span></div>
                    <div className="cl-sub">{districtLabel(g.zone_name)}</div>
                  </div>
                  <StatusChip status={g.status} />
                </div>
                <div className="meta">
                  <div><UserRound size={12} /> <LeaderText g={g} /></div>
                  <div className="cl-muted tabular-nums">
                    {t('gv.m.counts', undefined, { z: g.group_zone_count ?? 0, s: g.route_count, c: g.customer_count })}
                  </div>
                  {(g.collectors || []).length > 0 && <div className="cl-muted">{t('gv.collectors')}: {(g.collectors || []).map((c) => c.name).join(', ')}</div>}
                </div>
                {g.is_empty && <div className="cl-chips"><span className="cl-chip warning">{t('opsp.empty')}</span></div>}
              </div>
            ))}
          </div>
        </>)}
      </div>

      <GroupFormModal open={formOpen} onClose={() => setFormOpen(false)} defaultZoneId={zoneFilter || undefined} />
    </div>
  );
}

function GapsCard({ s, gaps, linked }) {
  const { t } = useI18n();
  const body = (
    <>
      <span className="k"><AlertTriangle size={14} /> {t('gv.card.gaps')}</span>
      {s ? (
        <span className="gaps">
          <span>{t('gv.card.noCollector')} <b className={s.sub_zones_no_collector ? '' : 'ok'}>{s.sub_zones_no_collector}</b></span>
          <span>{t('gv.card.noCashier')} <b className={s.sub_zones_no_cashier ? '' : 'ok'}>{s.sub_zones_no_cashier}</b></span>
          <span>{t('gv.card.noWorkDays')} <b className={s.sub_zones_no_work_days ? '' : 'ok'}>{s.sub_zones_no_work_days}</b></span>
        </span>
      ) : <span className="v">—</span>}
      {linked && <span className="s">{t('gv.card.openSetup')}</span>}
    </>
  );
  const style = { '--accent-c': gaps ? 'var(--warning)' : 'var(--brand)' };
  // The Setup checklist lives on the dashboard (admin / gudoomiye).
  return linked
    ? <Link to="/" className="gv-stat wide" style={style}>{body}</Link>
    : <div className="gv-stat wide" style={style}>{body}</div>;
}

function LeaderText({ g }) {
  const { t } = useI18n();
  if (!g.leader_user_id) return <span className="cl-muted">{t('gv.noLeader')}</span>;
  return <span style={g.leader_active === false ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>{g.leader_name}</span>;
}

function StatusChip({ status }) {
  const { tc } = useI18n();
  return <span className={`cl-chip dot ${status === 'active' ? 'success' : ''}`}>{tc('status.' + status, status)}</span>;
}

// "Axmed +1": first collector's first name (truncated), then how many more.
function collectorSummary(collectors, t) {
  const list = collectors || [];
  if (list.length === 0) return <span className="cl-muted">—</span>;
  const first = (list[0].name || '').trim().split(/\s+/)[0];
  const short = first.length > 18 ? `${first.slice(0, 17)}…` : first;
  return list.length > 1 ? `${short} ${t('opsp.moreN', undefined, { n: list.length - 1 })}` : short;
}
