import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Users, Plus, Search, X, Download, Wallet, MapPinOff, Route, Ban, KeyRound, Phone, MessageCircle,
  MoreVertical, ExternalLink, Pencil, CreditCard, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, ListChecks,
} from 'lucide-react';
import { PageHeader, Button, Card, LoadingState, ErrorState, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useCustomersPage, useCustomersSummary, exportCustomersCsv, useNumberRequests, useZonesList } from '../../hooks/useCustomers.js';
import { useGroups, useRoutesForGroup } from '../../hooks/useGroups.js';
import { useGroupZones } from '../../hooks/useGroupZones.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { fmtMoney } from '../../lib/money.js';
import { formatPhone, telHref, whatsappHref } from '../../lib/phone.js';
import { hierarchyParts, groupLabel, districtLabel } from '../../lib/hierarchy.js';
import CustomerFormModal from './CustomerFormModal.jsx';
import AssignSubZoneModal from './AssignSubZoneModal.jsx';
import './customers.css';

const EMPTY_FILTERS = {
  q: '', status: '', customer_type: '', group_id: '', zone_id: '', group_zone_id: '', route_id: '', billing_type: '',
  owes: '', has_location: '', no_subzone: '', suspended_for_debt: '', portal: '',
};
// Summary cards: each toggles one quick filter (and clears the other quick filters).
const QUICK_KEYS = ['owes', 'has_location', 'no_subzone', 'suspended_for_debt', 'portal'];
const PAGE_SIZES = [25, 50, 100];
const BALANCE_ROLES = ['admin', 'cashier', 'gudoomiye', 'zone_accountant'];
const PAY_ROLES = ['admin', 'cashier'];
const EDIT_ROLES = ['admin', 'gudoomiye'];

export default function CustomersListPage() {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const role = (user?.role || '').toLowerCase();
  const canSeeBalance = BALANCE_ROLES.includes(role);
  const canEdit = EDIT_ROLES.includes(role);
  const canPay = PAY_ROLES.includes(role);

  const [baseFilters, setFiltersRaw] = useState(EMPTY_FILTERS);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState({ key: 'created_at', dir: 'desc' });
  const [selected, setSelected] = useState(() => new Map()); // id -> row
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Any filter change goes back to page 1 and drops the selection.
  const setFilters = (updater) => { setFiltersRaw(updater); setPage(1); setSelected(new Map()); };
  // Debounced search (kept out of `filters` until it settles).
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const term = search.trim();
    const h = setTimeout(() => { setDebouncedQ(term); setPage(1); setSelected(new Map()); }, 300);
    return () => clearTimeout(h);
  }, [search]);

  const filters = useMemo(() => ({ ...baseFilters, q: debouncedQ }), [baseFilters, debouncedQ]);
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const quickActive = (patch) => Object.entries(patch).every(([k, v]) => filters[k] === v);
  const toggleQuick = (patch) => setFilters((f) => {
    const same = Object.entries(patch).every(([k, v]) => f[k] === v);
    const cleared = { ...f };
    for (const k of QUICK_KEYS) cleared[k] = '';
    return same ? cleared : { ...cleared, ...patch };
  });

  const listQ = useCustomersPage(filters, { page, pageSize, sort: sort.key, dir: sort.dir, withBalance: canSeeBalance });
  const summaryQ = useCustomersSummary(filters);
  const rows = listQ.data?.data || [];
  const meta = listQ.data?.meta || { total: 0, pages: 1 };
  const s = summaryQ.data?.data;

  const canSeeRequests = EDIT_ROLES.includes(role);
  const { data: reqData } = useNumberRequests({ enabled: canSeeRequests });
  const pendingRequests = reqData?.data || [];

  // Hierarchy filter sources (group first; a group fixes the district) — same cascade as before.
  const { data: zonesData } = useZonesList();
  const districts = zonesData?.data || [];
  const { data: groupsData } = useGroups({ limit: 200 });
  const allGroups = groupsData?.data || [];
  const groups = allGroups.filter((g) => !filters.zone_id || String(g.zone_id) === filters.zone_id || String(g.id) === filters.group_id);
  const { data: gzData } = useGroupZones(filters.group_id || undefined);
  const groupZones = filters.group_id ? (gzData?.data || []) : [];
  const { data: routesData } = useRoutesForGroup(filters.group_id || undefined);
  const subZones = filters.group_id ? (routesData?.data || []).filter((r) => !filters.group_zone_id || String(r.group_zone_id) === filters.group_zone_id) : [];

  function onGroup(v) {
    const g = allGroups.find((x) => String(x.id) === v);
    set({ group_id: v, group_zone_id: '', route_id: '', ...(g ? { zone_id: String(g.zone_id) } : {}) });
  }
  const onDistrict = (v) => set({ zone_id: v, group_id: '', group_zone_id: '', route_id: '' });

  const anyFilter = Object.entries(filters).some(([, v]) => v);
  const clearAll = () => { setSearch(''); setDebouncedQ(''); setFilters(EMPTY_FILTERS); };

  // Removable chips for every active filter.
  const nameOf = (list, id, fn) => { const x = list.find((i) => String(i.id) === String(id)); return x ? fn(x) : `#${id}`; };
  const chips = [];
  if (filters.q) chips.push({ k: 'q', label: `“${filters.q}”`, clear: () => { setSearch(''); setDebouncedQ(''); setPage(1); } });
  const statusLabels = { active_only: t('status.active'), suspended: t('status.suspended'), archived: t('status.archived'), all: t('cl.status.all') };
  if (filters.status) chips.push({ k: 'status', label: statusLabels[filters.status] });
  if (filters.customer_type) chips.push({ k: 'customer_type', label: t('cust.' + filters.customer_type) });
  if (filters.zone_id) chips.push({ k: 'zone_id', label: nameOf(districts, filters.zone_id, (z) => districtLabel(z.name)), clear: () => onDistrict('') });
  if (filters.group_id) chips.push({ k: 'group_id', label: nameOf(allGroups, filters.group_id, (g) => groupLabel(g.code, g.name)), clear: () => set({ group_id: '', group_zone_id: '', route_id: '' }) });
  if (filters.group_zone_id) chips.push({ k: 'group_zone_id', label: nameOf(groupZones, filters.group_zone_id, (z) => z.name || z.code), clear: () => set({ group_zone_id: '', route_id: '' }) });
  if (filters.route_id) chips.push({ k: 'route_id', label: nameOf(subZones, filters.route_id, (r) => r.name || r.code) });
  if (filters.billing_type) chips.push({ k: 'billing_type', label: t('cl.billing.' + filters.billing_type) });
  if (filters.owes) chips.push({ k: 'owes', label: filters.owes === '1' ? t('cl.owing') : t('cl.notOwing') });
  if (filters.has_location) chips.push({ k: 'has_location', label: filters.has_location === '1' ? t('cl.hasLocation') : t('cl.noLocation') });
  if (filters.no_subzone) chips.push({ k: 'no_subzone', label: t('cl.noSubZone') });
  if (filters.suspended_for_debt) chips.push({ k: 'suspended_for_debt', label: t('cl.suspendedDebt') });
  if (filters.portal) chips.push({ k: 'portal', label: filters.portal === '1' ? t('cl.portal') : t('cl.noPortal') });

  const toggleSort = (key) => setSort((cur) => (cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'balance' || key === 'last_payment' || key === 'created_at' ? 'desc' : 'asc' }));

  // Selection (bulk actions).
  const pageIds = rows.map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggleRow = (row) => setSelected((cur) => { const n = new Map(cur); if (n.has(row.id)) n.delete(row.id); else n.set(row.id, row); return n; });
  const togglePage = () => setSelected((cur) => {
    const n = new Map(cur);
    if (allOnPage) pageIds.forEach((id) => n.delete(id)); else rows.forEach((r) => n.set(r.id, r));
    return n;
  });

  async function onExport() {
    setExporting(true);
    try { await exportCustomersCsv(filters, { sort: sort.key, dir: sort.dir }); }
    catch (e) { toast.error(e.message); }
    finally { setExporting(false); }
  }

  const open = (row) => navigate(`/customers/${row.id}`);
  const actions = { open, edit: (row) => setEditing(row), pay: (row) => navigate(`/billing?invoice=${row.oldest_open_invoice_id}`) };
  const perms = { canEdit, canPay, canSeeBalance };

  return (
    <div>
      <PageHeader
        icon={Users}
        title={t('nav.customers')}
        subtitle={t('cust.residential_and_commercial_customers')}
        actions={
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <Button variant="secondary" icon={Download} onClick={onExport} disabled={exporting || !meta.total}>{exporting ? t('cl.exporting') : t('cl.exportCsv')}</Button>
            <RoleGate roles={['admin', 'gudoomiye']}>
              <Button icon={Plus} onClick={() => setFormOpen(true)}>{t('cust.create_customer')}</Button>
            </RoleGate>
          </div>
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

      <div className="cl-stats">
        <StatCardBtn accent="var(--brand)" icon={Users} label={t('cl.card.total')} value={s?.total} sub={s ? t('cl.card.totalSub', undefined, { a: s.active, s: s.suspended }) : ''}
          pressed={!QUICK_KEYS.some((k) => filters[k])} onClick={() => setFilters((f) => { const n = { ...f }; QUICK_KEYS.forEach((k) => { n[k] = ''; }); return n; })} />
        {canSeeBalance && (
          <StatCardBtn accent="var(--danger)" icon={Wallet} label={t('cl.card.owing')} value={s?.owing?.count}
            sub={s?.owing ? owedText(s.owing) : ''} pressed={quickActive({ owes: '1' })} onClick={() => toggleQuick({ owes: '1' })} />
        )}
        <StatCardBtn accent="var(--warning)" icon={MapPinOff} label={t('cl.card.noLocation')} value={s?.without_location} sub={t('cl.card.noLocationSub')}
          pressed={quickActive({ has_location: '0' })} onClick={() => toggleQuick({ has_location: '0' })} />
        <StatCardBtn accent="var(--warning)" icon={Route} label={t('cl.card.noSubZone')} value={s?.without_subzone} sub={t('cl.card.noSubZoneSub')}
          pressed={quickActive({ no_subzone: '1' })} onClick={() => toggleQuick({ no_subzone: '1' })} />
        <StatCardBtn accent="var(--danger)" icon={Ban} label={t('cl.card.suspendedDebt')} value={s?.suspended_for_debt} sub={t('cl.card.suspendedDebtSub')}
          pressed={quickActive({ suspended_for_debt: '1' })} onClick={() => toggleQuick({ suspended_for_debt: '1' })} />
        <StatCardBtn accent="var(--info)" icon={KeyRound} label={t('cl.card.portal')} value={s?.with_portal} sub={t('cl.card.portalSub')}
          pressed={quickActive({ portal: '1' })} onClick={() => toggleQuick({ portal: '1' })} />
      </div>

      <div className="cl-filters">
        <label className="cl-search">
          <Search size={15} />
          <input className="cl-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('cl.searchPh')} aria-label={t('cl.searchPh')} />
        </label>
        <select className="cl-input" value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label={t('common.status')}>
          <option value="">{t('cl.status.notArchived')}</option>
          <option value="active_only">{t('status.active')}</option>
          <option value="suspended">{t('status.suspended')}</option>
          <option value="archived">{t('status.archived')}</option>
          <option value="all">{t('cl.status.all')}</option>
        </select>
        <select className="cl-input" value={filters.customer_type} onChange={(e) => set({ customer_type: e.target.value })} aria-label={t('cust.type')}>
          <option value="">{t('cust.all_types')}</option>
          <option value="residential">{t('cust.residential')}</option>
          <option value="commercial">{t('cust.commercial')}</option>
        </select>
        <select className="cl-input" value={filters.group_id} onChange={(e) => onGroup(e.target.value)} aria-label={t('map.f.group')}>
          <option value="">{t('map.all_groups')}</option>
          {groups.map((g) => <option key={g.id} value={String(g.id)}>{groupLabel(g.code, g.name) + (g.zone_name ? ` — ${districtLabel(g.zone_name)}` : '')}</option>)}
        </select>
        {districts.length > 1 && (
          <select className="cl-input" value={filters.zone_id} onChange={(e) => onDistrict(e.target.value)} aria-label={t('map.f.district')}>
            <option value="">{t('map.f.all_districts')}</option>
            {districts.map((z) => <option key={z.id} value={String(z.id)}>{districtLabel(z.name)}</option>)}
          </select>
        )}
        <select className="cl-input" value={filters.group_zone_id} onChange={(e) => set({ group_zone_id: e.target.value, route_id: '' })} disabled={!filters.group_id} aria-label={t('map.f.zone')} title={!filters.group_id ? t('cl.pickGroupFirst') : undefined}>
          <option value="">{t('map.f.all_zones')}</option>
          {groupZones.map((z) => <option key={z.id} value={String(z.id)}>{z.name || z.code}</option>)}
        </select>
        <select className="cl-input" value={filters.route_id} onChange={(e) => set({ route_id: e.target.value })} disabled={!filters.group_id} aria-label={t('map.f.subzone')} title={!filters.group_id ? t('cl.pickGroupFirst') : undefined}>
          <option value="">{t('map.f.all_subzones')}</option>
          {subZones.map((r) => <option key={r.id} value={String(r.id)}>{r.name || r.code}</option>)}
        </select>
        <select className="cl-input" value={filters.billing_type} onChange={(e) => set({ billing_type: e.target.value })} aria-label={t('cl.billingType')}>
          <option value="">{t('cl.billing.any')}</option>
          <option value="monthly">{t('cl.billing.monthly')}</option>
          <option value="daily">{t('cl.billing.daily')}</option>
        </select>
        {canSeeBalance && (
          <select className="cl-input" value={filters.owes} onChange={(e) => set({ owes: e.target.value })} aria-label={t('cl.balance')}>
            <option value="">{t('cl.balanceAny')}</option>
            <option value="1">{t('cl.owing')}</option>
            <option value="0">{t('cl.notOwing')}</option>
          </select>
        )}
        <select className="cl-input" value={filters.has_location} onChange={(e) => set({ has_location: e.target.value })} aria-label={t('cl.location')}>
          <option value="">{t('cl.locationAny')}</option>
          <option value="1">{t('cl.hasLocation')}</option>
          <option value="0">{t('cl.noLocation')}</option>
        </select>
        <select className="cl-input" value={filters.portal} onChange={(e) => set({ portal: e.target.value })} aria-label={t('cl.portal')}>
          <option value="">{t('cl.portalAny')}</option>
          <option value="1">{t('cl.portal')}</option>
          <option value="0">{t('cl.noPortal')}</option>
        </select>
      </div>
      <div className="cl-chiprow">
        {chips.map((c) => (
          <span key={c.k} className="cl-fchip">
            {c.label}
            <button type="button" aria-label={t('cl.removeFilter', undefined, { f: c.label })} onClick={c.clear || (() => set({ [c.k]: '' }))}><X size={13} /></button>
          </span>
        ))}
        {anyFilter && <button type="button" className="cl-clear" onClick={clearAll}>{t('cl.clearAll')}</button>}
      </div>

      <div className="cl-card">
        {canEdit && selected.size > 0 && (
          <div className="cl-bulkbar" role="region" aria-label={t('cl.bulk.region')}>
            <ListChecks size={16} />
            <span className="grow">{t('cl.bulk.selected', undefined, { n: selected.size })}</span>
            <Button icon={Route} onClick={() => setAssignOpen(true)} style={{ padding: '7px 12px', fontSize: '13px' }}>{t('cl.bulk.assign')}</Button>
            <Button variant="secondary" onClick={() => setSelected(new Map())} style={{ padding: '7px 12px', fontSize: '13px' }}>{t('cl.bulk.clear')}</Button>
          </div>
        )}
        <div className="cl-toolbar">
          <span className="count">{meta.total ? t('cl.showing', undefined, { from: (page - 1) * pageSize + 1, to: Math.min(page * pageSize, meta.total), total: meta.total.toLocaleString('en-US') }) : ''}</span>
          <label className="sort">
            {t('cl.sortBy')}
            <select className="cl-input" value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [key, dir] = e.target.value.split(':'); setSort({ key, dir }); }}>
              <option value="created_at:desc">{t('cl.sort.newest')}</option>
              <option value="created_at:asc">{t('cl.sort.oldest')}</option>
              <option value="customer_number:asc">{t('cl.sort.number')}</option>
              <option value="name:asc">{t('cl.sort.name')}</option>
              {canSeeBalance && <option value="balance:desc">{t('cl.sort.balance')}</option>}
              {canSeeBalance && <option value="last_payment:desc">{t('cl.sort.lastPayment')}</option>}
              {canSeeBalance && <option value="last_payment:asc">{t('cl.sort.lastPaymentOld')}</option>}
            </select>
          </label>
        </div>

        {listQ.isLoading && <LoadingState label={t('common.loading')} />}
        {listQ.error && <ErrorState message={listQ.error.message} onRetry={listQ.refetch} />}
        {!listQ.isLoading && !listQ.error && rows.length === 0 && (
          <div className="cl-empty">
            <Users size={28} />
            <strong>{anyFilter ? t('cust.no_customers_match_your_search') : t('cust.no_customers_yet')}</strong>
            <span>{anyFilter ? t('cust.try_a_different_name_phone') : t('cust.create_the_first_customer_to')}</span>
            {anyFilter && <Button variant="secondary" onClick={clearAll}>{t('cl.clearAll')}</Button>}
          </div>
        )}
        {!listQ.isLoading && !listQ.error && rows.length > 0 && (<>
          <div className="cl-table-wrap">
            <table className="cl-table">
              <thead>
                <tr>
                  {canEdit && <th className="chk"><input type="checkbox" className="cl-check" checked={allOnPage} onChange={togglePage} aria-label={t('cl.selectPage')} /></th>}
                  <th>
                    <SortBtn k="customer_number" sort={sort} onSort={toggleSort}>#</SortBtn>
                    <span className="cl-muted"> · </span>
                    <SortBtn k="name" sort={sort} onSort={toggleSort}>{t('cl.col.customer')}</SortBtn>
                  </th>
                  <th>{t('cust.type')}</th>
                  <th>{t('common.phone')}</th>
                  <th>{t('cl.col.location')}</th>
                  <th>{t('cl.col.collector')}</th>
                  <th>{t('cl.col.billing')}</th>
                  {canSeeBalance && <th className="r"><SortBtn k="balance" sort={sort} onSort={toggleSort}>{t('cl.balance')}</SortBtn></th>}
                  <th>{t('common.status')}</th>
                  <th aria-label={t('cl.actions')} />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} onClick={() => open(c)} aria-selected={selected.has(c.id)}>
                    {canEdit && (
                      <td className="chk" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" className="cl-check" checked={selected.has(c.id)} onChange={() => toggleRow(c)} aria-label={t('cl.selectRow', undefined, { c: c.customer_number })} />
                      </td>
                    )}
                    <td>
                      <div className="cl-num">{c.customer_number}</div>
                      <div className="cl-name">{c.name}</div>
                      {c.business_name && <div className="cl-biz">{c.business_name}</div>}
                    </td>
                    <td><TypeChip type={c.customer_type} shift={c.commercial_shift} /></td>
                    <td onClick={(e) => e.stopPropagation()}><PhoneCell row={c} /></td>
                    <td><PathCell row={c} /></td>
                    <td>{c.collector_name ? c.collector_name : <span className="cl-muted">—</span>}</td>
                    <td><BillingCell row={c} /></td>
                    {canSeeBalance && <td className="r"><BalanceCell row={c} /></td>}
                    <td><StatusCell row={c} /></td>
                    <td onClick={(e) => e.stopPropagation()}><RowMenu row={c} perms={perms} actions={actions} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="cl-cards">
            {rows.map((c) => (
              <MobileCard key={c.id} row={c} perms={perms} actions={actions} selectable={canEdit} selected={selected.has(c.id)} onToggle={() => toggleRow(c)} />
            ))}
          </div>
          <Pager page={page} pages={meta.pages || 1} pageSize={pageSize} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
        </>)}
      </div>

      <CustomerFormModal open={formOpen} onClose={() => setFormOpen(false)} />
      {editing && <CustomerFormModal open onClose={() => setEditing(null)} customer={editing} />}
      {assignOpen && (
        <AssignSubZoneModal
          open
          customers={[...selected.values()]}
          onClose={(done) => { setAssignOpen(false); if (done) setSelected(new Map()); }}
        />
      )}
    </div>
  );
}

function owedText(owing) {
  const parts = [];
  if (owing.USD > 0.004) parts.push(fmtMoney(owing.USD, 'USD'));
  if (owing.SLSH > 0.4) parts.push(fmtMoney(owing.SLSH, 'SLSH'));
  return parts.join(' + ') || fmtMoney(0, 'USD');
}

function StatCardBtn({ accent, icon: Icon, label, value, sub, pressed, onClick }) {
  return (
    <button type="button" className="cl-stat" style={{ '--accent-c': accent }} aria-pressed={pressed} onClick={onClick}>
      <span className="k"><Icon size={14} /> {label}</span>
      <span className="v">{value === undefined || value === null ? '—' : Number(value).toLocaleString('en-US')}</span>
      <span className="s">{sub}</span>
    </button>
  );
}

function SortBtn({ k, sort, onSort, children }) {
  const active = sort.key === k;
  const Icon = active && sort.dir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <button type="button" className="cl-sort" data-active={active} onClick={() => onSort(k)} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      {children}{active && <Icon size={13} />}
    </button>
  );
}

function TypeChip({ type, shift }) {
  const { t } = useI18n();
  if (type === 'commercial') {
    return <span className="cl-chip info">{t('cust.commercial')}{shift ? ` · ${t('cust.' + shift, shift)}` : ''}</span>;
  }
  return <span className="cl-chip success">{t('cust.residential')}</span>;
}

function PhoneCell({ row }) {
  const { t } = useI18n();
  if (!row.phone) return <span className="cl-muted">—</span>;
  const tel = telHref(row.phone);
  const wa = whatsappHref(row.whatsapp || row.phone);
  return (
    <div>
      <div className="cl-phone">
        <span>{formatPhone(row.phone)}</span>
        {tel && <a className="cl-icon-link" href={tel} aria-label={t('cl.call', undefined, { p: formatPhone(row.phone) })} title={t('cl.callShort')}><Phone size={13} /></a>}
        {wa && <a className="cl-icon-link wa" href={wa} target="_blank" rel="noopener noreferrer" aria-label={t('cl.whatsapp')} title={t('cl.whatsapp')}><MessageCircle size={13} /></a>}
      </div>
      {row.alternate_phone && <div className="cl-sub tabular-nums">{formatPhone(row.alternate_phone)}</div>}
    </div>
  );
}

function PathCell({ row }) {
  const { t } = useI18n();
  const p = hierarchyParts(row);
  const parts = [p.group, p.district, p.zone, p.subZone].filter(Boolean);
  return (
    <div className="cl-path">
      {parts.map((x, i) => <React.Fragment key={i}>{i > 0 && <span className="sep">›</span>}{x}</React.Fragment>)}
      {!row.route_id && <div className="cl-sub"><span className="none">{t('cl.noSubZone')}</span></div>}
      {row.door_number && <div className="cl-sub tabular-nums">{t('cust.door_col', 'Door #')} {row.door_number}</div>}
    </div>
  );
}

function BillingCell({ row }) {
  const { t } = useI18n();
  const fee = row.fee === null || row.fee === undefined ? null : Number(row.fee);
  const type = row.billing_type ? t('cl.billing.' + row.billing_type) : t('cl.billing.notSet');
  return (
    <div>
      <div style={{ whiteSpace: 'nowrap' }}>
        <span className={row.billing_type ? '' : 'cl-muted'}>{type}</span>
        {fee !== null && <span className="cl-money"> · {fmtMoney(fee, row.fee_currency)}</span>}
      </div>
      {Array.isArray(row.effective_work_days) && row.effective_work_days.length > 0 && (
        <div className="cl-sub">{row.effective_work_days.map((d) => t('cl.day.' + d, d)).join(' ')}</div>
      )}
    </div>
  );
}

function BalanceCell({ row }) {
  const { t } = useI18n();
  if (!row.balance) return <span className="cl-muted">—</span>;
  const usd = row.balance.USD > 0.004;
  const slsh = row.balance.SLSH > 0.4;
  return (
    <div>
      {!usd && !slsh && <span className="cl-muted">—</span>}
      {usd && <div className="cl-money cl-owe">{fmtMoney(row.balance.USD, 'USD')}</div>}
      {slsh && <div className="cl-money cl-owe">{fmtMoney(row.balance.SLSH, 'SLSH')}</div>}
      {row.last_payment_at && <div className="cl-sub" title={new Date(row.last_payment_at).toLocaleString()}>{t('cl.lastPaid', undefined, { d: relDays(t, row.last_payment_at) })}</div>}
    </div>
  );
}

function relDays(t, iso) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return t('cl.today');
  return t('cl.daysAgo', undefined, { n: days });
}

function StatusCell({ row }) {
  const { t, tc } = useI18n();
  const tone = row.status === 'active' ? 'success' : row.status === 'suspended' ? 'danger' : '';
  return (
    <div>
      <span className={`cl-chip dot ${tone}`}>{tc('status.' + row.status, row.status)}</span>
      <div className="cl-chips">
        {row.status === 'suspended' && row.suspended_reason === 'debt' && <span className="cl-chip danger">{t('cl.suspendedDebt')}</span>}
        {!row.has_location && <span className="cl-chip warning">{t('cl.noLocation')}</span>}
        {row.portal_status === 'active' && <span className="cl-chip info">{t('cl.portal')}</span>}
      </div>
    </div>
  );
}

function RowMenu({ row, perms, actions }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const owing = row.balance && (row.balance.USD > 0.004 || row.balance.SLSH > 0.4) && row.oldest_open_invoice_id;
  const wa = whatsappHref(row.whatsapp || row.phone);
  const tel = row.phone ? telHref(row.phone) : null;
  const toggle = () => {
    if (!open && ref.current) setUp(ref.current.getBoundingClientRect().bottom > window.innerHeight - 230);
    setOpen((o) => !o);
  };
  const run = (fn) => () => { setOpen(false); fn(row); };
  return (
    <div className="cl-actions" ref={ref}>
      <button type="button" className="cl-menu-btn" aria-haspopup="menu" aria-expanded={open} aria-label={t('cl.actionsFor', undefined, { c: row.customer_number })} onClick={toggle}>
        <MoreVertical size={16} />
      </button>
      {open && (
        <div className={`cl-menu${up ? ' up' : ''}`} role="menu">
          <button type="button" role="menuitem" onClick={run(actions.open)}><ExternalLink size={14} /> {t('cl.act.open')}</button>
          {perms.canEdit && <button type="button" role="menuitem" onClick={run(actions.edit)}><Pencil size={14} /> {t('cl.act.edit')}</button>}
          {perms.canPay && owing && <button type="button" role="menuitem" className="pay" onClick={run(actions.pay)}><CreditCard size={14} /> {t('cl.act.pay')}</button>}
          {tel && <a role="menuitem" href={tel} onClick={() => setOpen(false)}><Phone size={14} /> {t('cl.callShort')}</a>}
          {wa && <a role="menuitem" href={wa} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}><MessageCircle size={14} /> {t('cl.whatsapp')}</a>}
        </div>
      )}
    </div>
  );
}

function MobileCard({ row, perms, actions, selectable, selected, onToggle }) {
  const { t, tc } = useI18n();
  const p = hierarchyParts(row);
  const path = [p.group, p.district, p.zone, p.subZone].filter(Boolean).join(' › ');
  return (
    <div className="cl-mcard" role="button" tabIndex={0} aria-selected={selected} onClick={() => actions.open(row)} onKeyDown={(e) => { if (e.key === 'Enter') actions.open(row); }}>
      <div className="top">
        <div className="who">
          {selectable && (
            <input type="checkbox" className="cl-check" checked={selected} onClick={(e) => e.stopPropagation()} onChange={onToggle} aria-label={t('cl.selectRow', undefined, { c: row.customer_number })} style={{ marginTop: '3px' }} />
          )}
          <div style={{ minWidth: 0 }}>
            <div className="cl-name">{row.name} <span className="cl-num" style={{ fontSize: '12px' }}>{row.customer_number}</span></div>
            {row.business_name && <div className="cl-biz">{row.business_name}</div>}
          </div>
        </div>
        {perms.canSeeBalance && <div className="bal"><BalanceCell row={row} /></div>}
      </div>
      <div className="meta">
        <div className={row.route_id ? '' : 'cl-muted'}>{path || '—'}</div>
        <div className="cl-muted"><BillingInline row={row} />{row.collector_name ? ` · ${row.collector_name}` : ''}</div>
      </div>
      <div className="cl-chips">
        <TypeChip type={row.customer_type} shift={row.commercial_shift} />
        <span className={`cl-chip dot ${row.status === 'active' ? 'success' : row.status === 'suspended' ? 'danger' : ''}`}>{tc('status.' + row.status, row.status)}</span>
        {row.status === 'suspended' && row.suspended_reason === 'debt' && <span className="cl-chip danger">{t('cl.suspendedDebt')}</span>}
        {!row.has_location && <span className="cl-chip warning">{t('cl.noLocation')}</span>}
        {!row.route_id && <span className="cl-chip warning">{t('cl.noSubZone')}</span>}
        {row.portal_status === 'active' && <span className="cl-chip info">{t('cl.portal')}</span>}
      </div>
      <div className="bottom" onClick={(e) => e.stopPropagation()}>
        <PhoneCell row={row} />
        <RowMenu row={row} perms={perms} actions={actions} />
      </div>
    </div>
  );
}

function BillingInline({ row }) {
  const { t } = useI18n();
  const type = row.billing_type ? t('cl.billing.' + row.billing_type) : t('cl.billing.notSet');
  return <>{type}{row.fee !== null && row.fee !== undefined ? ` · ${fmtMoney(row.fee, row.fee_currency)}` : ''}</>;
}

function Pager({ page, pages, pageSize, onPage, onPageSize }) {
  const { t } = useI18n();
  const nums = useMemo(() => {
    const set = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
    const out = [];
    let last = 0;
    for (const n of [...set].sort((a, b) => a - b)) { if (n - last > 1) out.push('…' + n); out.push(n); last = n; }
    return out;
  }, [page, pages]);
  return (
    <div className="cl-pager">
      <label className="ctl">
        {t('cl.perPage')}
        <select className="cl-input" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <div className="ctl" role="navigation" aria-label={t('cl.pagination')}>
        <button type="button" className="cl-pg" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('common.prev')}><ChevronLeft size={15} /></button>
        {nums.map((n) => (typeof n === 'string'
          ? <span key={n} className="cl-muted">…</span>
          : <button key={n} type="button" className="cl-pg" aria-current={n === page ? 'page' : undefined} onClick={() => onPage(n)}>{n}</button>))}
        <button type="button" className="cl-pg" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t('common.next')}><ChevronRight size={15} /></button>
      </div>
    </div>
  );
}
