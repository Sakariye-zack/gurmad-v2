import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Pencil, Plus, MapPin, UserRound, Layers, Route as RouteIcon, Users, Truck, Wallet, Navigation,
  StickyNote, SlidersHorizontal, MapPinOff, ChevronRight, Map as MapIcon,
} from 'lucide-react';
import { Button, LoadingState, ErrorState } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useGroup, useGroupSummary, useGroupCollectorPerformance, useGroupCustomers } from '../../hooks/useGroups.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { groupLabel, districtLabel } from '../../lib/hierarchy.js';
import { fmtMoney } from '../../lib/money.js';
import GroupFormModal from './GroupFormModal.jsx';
import { SubZoneFormModal, ZoneFormModal } from './SubZoneFormModal.jsx';
import { DayPills, PersonChip } from './GroupBits.jsx';
import { hasCenter, nameOrCode, daysOf, WRITE_ROLES } from './groupUtils.js';
import '../customers/customers.css';
import './groups.css';

// Group Detail (Groups V2): hero header, KPI tiles, Zones and Sub Zones as
// rows with chips (collector / cashier / truck, work days, start point,
// customers), the group's customers, and a side column with leader, map
// center, defaults, description and notes. Everything is live-derived.
export default function GroupDetailPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useGroup(id);
  const { data: summaryData } = useGroupSummary(id);
  const { data: perfData } = useGroupCollectorPerformance(id);
  const { data: customersData } = useGroupCustomers(id);
  const [editOpen, setEditOpen] = useState(false);
  const [subZoneTarget, setSubZoneTarget] = useState(null); // null closed, {} new, row = edit
  const [zoneTarget, setZoneTarget] = useState(null);
  const group = data?.data;
  const summary = summaryData?.data;
  const performance = perfData?.data || [];
  const customers = customersData?.data || [];
  const customersMeta = customersData?.meta;

  if (isLoading) return <LoadingState label={t('group.loading_group')} />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!group) return null;

  const zones = group.zones || [];
  const routes = group.routes || [];
  const counts = group.counts || {};
  const sections = [
    ...zones.map((z) => ({ key: 'z' + z.id, label: nameOrCode(z.name, z.code), routes: routes.filter((r) => r.group_zone_id === z.id) })),
    { key: 'none', label: t('group.no_zone', 'No zone'), routes: routes.filter((r) => !r.group_zone_id) },
  ].filter((sec) => sec.routes.length > 0);
  const title = groupLabel(group.code, group.name);
  const noSubZoneHref = `/customers?group_id=${group.id}&no_subzone=1`;

  return (
    <div>
      <button type="button" className="gv-back" onClick={() => navigate('/groups')}>
        <ArrowLeft size={14} /> {t('group.back_to_groups')}
      </button>

      <header className="gv-hero">
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <h1>{title} <StatusChip status={group.status} /></h1>
          <div className="meta">
            <span><MapPin size={13} /> <strong>{districtLabel(group.zone_name)}</strong></span>
            <span>
              <UserRound size={13} /> {t('gv.leader')}:{' '}
              {group.leader_user_id
                ? <strong style={group.leader_active === false ? { textDecoration: 'line-through' } : undefined}>{group.leader_name}</strong>
                : <span style={{ color: 'var(--warning)', fontWeight: 700 }}>{t('gv.noLeader')}</span>}
            </span>
            <span><Layers size={13} /> {t('gv.m.zonesSubZones', undefined, { z: counts.zones ?? zones.length, s: counts.sub_zones ?? routes.length })}</span>
          </div>
          {group.description && <p className="desc">{group.description}</p>}
        </div>
        <div className="actions">
          {hasCenter(group) && (
            <Link to={`/map?group=${group.id}`} className="gv-icon-btn" style={{ textDecoration: 'none', minHeight: '40px' }}><MapIcon size={14} /> {t('gv.openOnMap')}</Link>
          )}
          <RoleGate roles={WRITE_ROLES}>
            <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>{t('group.edit_group')}</Button>
          </RoleGate>
        </div>
      </header>

      <div className="gv-kpis">
        <Kpi k={t('nav.customers')} v={counts.customers ?? group.customer_count} />
        <Kpi k={t('gv.zones')} v={counts.zones} />
        <Kpi k={t('gv.subZones')} v={counts.sub_zones ?? group.route_count} />
        <Kpi k={t('gv.collectors')} v={counts.collectors} />
        <Kpi k={t('gv.cashiers')} v={counts.cashiers} />
        <Kpi k={t('gv.noSubZoneCustomers')} v={counts.customers_without_subzone} color={counts.customers_without_subzone ? 'var(--warning)' : undefined} />
      </div>

      {summary && (
        <>
          <p className="gv-kpi-label">{t('gv.todayActivity')}</p>
          <div className="gv-kpis">
            <Kpi k={t('status.assigned')} v={summary.assigned} />
            <Kpi k={t('status.serviced')} v={summary.serviced} color="var(--success)" />
            <Kpi k={t('status.missed')} v={summary.missed} color="var(--danger)" />
            <Kpi k={t('status.skipped')} v={summary.skipped} color="var(--warning)" />
            <Kpi k={t('status.rescheduled')} v={summary.rescheduled} />
            <Kpi k={t('group.remaining')} v={summary.remaining} />
            <Kpi k={t('group.completion')} v={summary.completion_pct != null ? `${summary.completion_pct}%` : '—'} color="var(--brand)" />
          </div>
        </>
      )}

      {counts.customers_without_subzone > 0 && (
        <Link to={noSubZoneHref} className="gv-shortcut">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}><MapPinOff size={16} /> {t('gv.noSubZoneShortcut', undefined, { n: counts.customers_without_subzone })}</span>
          <ChevronRight size={16} />
        </Link>
      )}

      <div className="gv-cols">
        <div style={{ minWidth: 0 }}>
          <section className="gv-sec">
            <header>
              <h2><Layers size={16} /> {t('gv.zones')} <span className="n">({zones.length})</span></h2>
              <RoleGate roles={WRITE_ROLES}>
                <Button variant="secondary" icon={Plus} onClick={() => setZoneTarget({})}>{t('group.add_zone', 'Add Zone')}</Button>
              </RoleGate>
            </header>
            {zones.length === 0 && <div className="empty">{t('gv.noZonesYet')}</div>}
            {zones.map((z) => (
              <div key={z.id} className="gv-row zone">
                <div style={{ minWidth: 0 }}>
                  <div className="title">{z.code}{z.name && z.name !== z.code && <span className="nm"> — {z.name}</span>}</div>
                  {z.description && <div className="desc">{z.description}</div>}
                  <div className="gv-meta">
                    <span><RouteIcon size={12} /> {t('gv.m.nSubZones', undefined, { n: z.route_count })}</span>
                    <span><Users size={12} /> {t('group.m.nCustomers', undefined, { n: z.customer_count ?? 0 })}</span>
                    {z.notes && <span title={z.notes}><StickyNote size={12} /> {truncate(z.notes, 60)}</span>}
                  </div>
                </div>
                <div className="end">
                  <StatusChip status={z.status} />
                  <RoleGate roles={WRITE_ROLES}>
                    <button type="button" className="gv-icon-btn" onClick={() => setZoneTarget(z)}><Pencil size={13} /> {t('group.edit')}</button>
                  </RoleGate>
                </div>
              </div>
            ))}
          </section>

          <section className="gv-sec">
            <header>
              <h2><RouteIcon size={16} /> {t('gv.subZones')} <span className="n">({routes.length})</span></h2>
              <RoleGate roles={WRITE_ROLES}>
                <Button variant="secondary" icon={Plus} onClick={() => setSubZoneTarget({})}>{t('gv.addSubZone')}</Button>
              </RoleGate>
            </header>
            {routes.length === 0 && <div className="empty">{t('group.no_routes_yet_in_this')}</div>}
            {sections.map((sec) => (
              <React.Fragment key={sec.key}>
                {zones.length > 0 && <div className="sub-h"><span>{sec.label}</span><span>{sec.routes.length}</span></div>}
                {sec.routes.map((r) => <SubZoneRow key={r.id} r={r} onEdit={() => setSubZoneTarget(r)} />)}
              </React.Fragment>
            ))}
          </section>

          <section className="gv-sec">
            <header>
              <h2><Users size={16} /> {t('cust.customers')} <span className="n">{customersMeta ? `(${customersMeta.total})` : ''}</span></h2>
              <Link to={`/customers?group_id=${group.id}`} className="gv-link">{t('gv.openInCustomers')} <ChevronRight size={14} /></Link>
            </header>
            {customers.length === 0 && <div className="empty">{t('group.no_customers_in_this_group')}</div>}
            {customers.map((c) => (
              <div key={c.id} className="gv-crow" role="link" tabIndex={0} onClick={() => navigate(`/customers/${c.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/customers/${c.id}`); }}>
                <div className="who"><span className="cl-num">{c.customer_number}</span> <span className="cl-name">{c.business_name || c.name}</span></div>
                <div className="cl-chips" style={{ marginTop: 0 }}>
                  <span className={`cl-chip ${c.customer_type === 'commercial' ? 'info' : 'success'}`}>{t('cust.' + c.customer_type, c.customer_type)}</span>
                  {!c.route_id && <span className="cl-chip warning">{t('cl.noSubZone')}</span>}
                  <StatusChip status={c.status} />
                </div>
              </div>
            ))}
            {customersMeta && customersMeta.total > customers.length && (
              <div className="empty">{t('group.m.showing', undefined, { shown: customers.length, total: customersMeta.total })}</div>
            )}
          </section>

          {performance.length > 0 && (
            <section className="gv-sec">
              <header><h2>{t('group.collector_performance_in_this_group')}</h2></header>
              <div className="cl-table-wrap" style={{ display: 'block' }}>
                <table className="cl-table">
                  <tbody>
                    {performance.map((p) => (
                      <tr key={p.collector_id} style={{ cursor: 'default' }}>
                        <td>{p.collector_name}</td>
                        <td className="tabular-nums">{t('group.m.nServiced', undefined, { n: p.serviced })}</td>
                        <td className="tabular-nums">{t('group.m.nMissed', undefined, { n: p.missed })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>

        <aside style={{ minWidth: 0 }}>
          <section className="gv-sec">
            <header><h2><MapPin size={16} /> {t('gv.sec.area')}</h2></header>
            <div className="body">
              {hasCenter(group) ? (
                <dl className="gv-kv">
                  <dt>{t('gv.center')}</dt>
                  <dd>{Number(group.center_lat).toFixed(6)}, {Number(group.center_lng).toFixed(6)}</dd>
                  <dt />
                  <dd><Link to={`/map?group=${group.id}`} className="gv-link"><Navigation size={13} /> {t('gv.openOnMap')}</Link></dd>
                </dl>
              ) : <span className="cl-muted" style={{ fontSize: '13px' }}>{t('gv.noCenter')}</span>}
            </div>
          </section>

          <section className="gv-sec">
            <header><h2><SlidersHorizontal size={16} /> {t('gv.sec.defaults')}</h2></header>
            <div className="body">
              <dl className="gv-kv">
                <dt>{t('subzone.workDays')}</dt>
                <dd>{daysOf(group.default_work_days).length ? <DayPills days={group.default_work_days} /> : <span className="cl-muted">{t('gv.notSet')}</span>}</dd>
                <dt>{t('cust.billing_type')}</dt>
                <dd>{group.default_billing_type ? t('cl.billing.' + group.default_billing_type) : <span className="cl-muted">{t('gv.notSet')}</span>}</dd>
                <dt>{t('gv.defaultFee')}</dt>
                <dd>{group.default_fee != null ? fmtMoney(Number(group.default_fee), group.default_fee_currency || 'USD') : <span className="cl-muted">{t('gv.notSet')}</span>}
                  {group.default_fee == null && group.default_fee_currency && <span className="cl-muted"> · {group.default_fee_currency}</span>}</dd>
              </dl>
            </div>
          </section>

          <section className="gv-sec">
            <header><h2><StickyNote size={16} /> {t('gv.notes')}</h2></header>
            <div className="body">
              {group.notes ? <div className="gv-note">{group.notes}</div> : <span className="cl-muted" style={{ fontSize: '13px' }}>{t('gv.noNotes')}</span>}
            </div>
          </section>

          <p className="cl-sub" style={{ margin: '0 4px 16px' }}>{t('group.collector_assignment_for_this_group')}</p>
        </aside>
      </div>

      <GroupFormModal open={editOpen} onClose={() => setEditOpen(false)} group={group} />
      {subZoneTarget && <SubZoneFormModal group={group} route={subZoneTarget.id ? subZoneTarget : null} onClose={() => setSubZoneTarget(null)} />}
      {zoneTarget && <ZoneFormModal group={group} zone={zoneTarget.id ? zoneTarget : null} onClose={() => setZoneTarget(null)} />}
    </div>
  );
}

function SubZoneRow({ r, onEdit }) {
  const { t } = useI18n();
  const hasStart = r.start_lat != null && r.start_lng != null;
  return (
    <div className="gv-row">
      <div style={{ minWidth: 0 }}>
        <div className="title">{r.code}{r.name && r.name !== r.code && <span className="nm"> — {r.name}</span>}</div>
        {r.description && <div className="desc">{r.description}</div>}
        <div className="gv-meta">
          <span><Users size={12} /> {t('group.m.nCustomers', undefined, { n: r.customer_count })}</span>
          {r.notes && <span title={r.notes}><StickyNote size={12} /> {truncate(r.notes, 50)}</span>}
        </div>
      </div>
      <div className="gv-people">
        <PersonChip icon={UserRound} name={r.collector_name} active={r.collector_active} missingLabel={t('gv.noCollector')} title={t('group.collector', 'Collector')} />
        <PersonChip icon={Wallet} name={r.cashier_name} active={r.cashier_active} missingLabel={t('gv.noCashier')} title={t('subzone.cashier', 'Cashier')} />
        {r.truck_plate
          ? <PersonChip icon={Truck} name={r.truck_plate} title={t('subzone.defaultTruck')} />
          : <span className="gv-pchip" title={t('subzone.defaultTruck')}><Truck size={12} />{t('subzone.noTruck')}</span>}
      </div>
      <div>
        <DayPills days={r.work_days} />
        <div className="gv-meta">
          {hasStart
            ? <span><Navigation size={12} /> {t('gv.startSet')}</span>
            : <span className="warn"><MapPinOff size={12} /> {t('gv.noStart')}</span>}
        </div>
      </div>
      <div className="end">
        <StatusChip status={r.status} />
        <RoleGate roles={WRITE_ROLES}>
          <button type="button" className="gv-icon-btn" onClick={onEdit}><Pencil size={13} /> {t('group.edit')}</button>
        </RoleGate>
      </div>
    </div>
  );
}

function Kpi({ k, v, color }) {
  return (
    <div className="gv-kpi" style={color ? { '--kpi-c': color } : undefined}>
      <span className="k">{k}</span>
      <span className="v">{v === undefined || v === null ? '—' : v}</span>
    </div>
  );
}

function StatusChip({ status }) {
  const { tc } = useI18n();
  const tone = status === 'active' ? 'success' : status === 'suspended' ? 'danger' : '';
  return <span className={`cl-chip dot ${tone}`}>{tc('status.' + status, status)}</span>;
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
