import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  HandCoins, Plus, Download, Search, X, Info, Wallet, Hourglass, AlarmClock, Users, CalendarCheck, CalendarX, Coins,
  ChevronUp, ChevronDown, ChevronLeft, ChevronRight, ChevronRight as Expand, MoreVertical, MessageSquarePlus, CreditCard, Pencil, Ban,
  ExternalLink, List, UserRound,
} from 'lucide-react';
import { Button, LoadingState, ErrorState, useToast } from '../../components/ui/index.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { useDebtsPage, useDebtsSummary, exportDebtsCsv } from '../../hooks/useFinancial.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useGroups, useRoutesForGroup, useAllRoutes } from '../../hooks/useGroups.js';
import { useGroupZones } from '../../hooks/useGroupZones.js';
import { fmtMoney } from '../../lib/money.js';
import { groupLabel, districtLabel } from '../../lib/hierarchy.js';
import { fmtDate, fmtDateTime } from './financeUtils.js';
import {
  AgeChip, StateChip, SourceChip, PromiseCell, SuspensionChip, PhoneLinks, MoneyPair, pathText, isOpen, COLLECT_ROLES, CREATE_ROLES,
} from './debtsUi.jsx';
import DebtDrawer from './DebtDrawer.jsx';
import { FollowupModal, WriteOffModal, EditDebtModal, SettleModal, CreateDebtModal } from './DebtModals.jsx';
import '../customers/customers.css';
import './finance.css';
import './debts.css';

// Debts V2 — the debts register. Every figure comes from the server
// (GET /v2/debts, /v2/debts/summary, /v2/debts/:id); this page only filters,
// formats and opens the actions. Totals are per currency, never mixed, and
// count the debts register only (see the note at the top of the page).
const EMPTY = { q: '', status: 'open', source: '', currency: '', age: '', promise: '', zone_id: '', group_id: '', group_zone_id: '', route_id: '', amount_min: '', amount_max: '', customer_id: '' };
const PAGE_SIZES = [25, 50, 100];
const ROUTE_VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'collector'];

export default function DebtsView() {
  const { t } = useI18n();
  const toast = useToast();
  const { user } = useAuth();
  const role = (user?.role || '').toLowerCase();
  const canCollect = COLLECT_ROLES.includes(role);
  const canCreate = CREATE_ROLES.includes(role);
  const [searchParams, setSearchParams] = useSearchParams();
  const drawerId = searchParams.get('debt') && /^\d+$/.test(searchParams.get('debt')) ? Number(searchParams.get('debt')) : null;

  const [view, setView] = useState('debts');
  const [base, setBaseRaw] = useState(() => {
    const f = { ...EMPTY };
    const cid = searchParams.get('customer_id');
    if (cid && /^\d+$/.test(cid)) f.customer_id = cid;
    return f;
  });
  const [search, setSearch] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sort, setSort] = useState({ key: 'created_at', dir: 'desc' });
  const [csort, setCsort] = useState({ key: 'oldest', dir: 'desc' });
  const [modal, setModal] = useState(null); // { kind, debt?, target? }
  const [exporting, setExporting] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());

  useEffect(() => {
    const h = setTimeout(() => { setDebouncedQ(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(h);
  }, [search]);
  const setBase = (updater) => { setBaseRaw(updater); setPage(1); setExpanded(new Set()); };
  const set = (patch) => setBase((f) => ({ ...f, ...patch }));
  const filters = useMemo(() => ({ ...base, q: debouncedQ }), [base, debouncedQ]);

  const listQ = useDebtsPage(filters, view === 'customer'
    ? { page, pageSize, sort: csort.key, dir: csort.dir, view: 'customer' }
    : { page, pageSize, sort: sort.key, dir: sort.dir });
  const summaryQ = useDebtsSummary();
  const s = summaryQ.data?.data;
  const rows = listQ.data?.data || [];
  const meta = listQ.data?.meta || { total: 0, pages: 1 };

  // hierarchy filter sources — same cascade as the Customers list
  const { data: zonesData } = useZonesList();
  const districts = zonesData?.data || [];
  const { data: groupsData } = useGroups({ limit: 200 });
  const allGroups = groupsData?.data || [];
  const groups = allGroups.filter((g) => !base.zone_id || String(g.zone_id) === base.zone_id || String(g.id) === base.group_id);
  const { data: gzData } = useGroupZones(base.group_id || undefined);
  const groupZones = base.group_id ? (gzData?.data || []) : [];
  const { data: routesData } = useRoutesForGroup(base.group_id || undefined);
  const { data: allRoutesData } = useAllRoutes(ROUTE_VIEW_ROLES.includes(role));
  const allRoutes = allRoutesData?.data || [];
  const subZones = base.group_id
    ? (routesData?.data || []).filter((r) => !base.group_zone_id || String(r.group_zone_id) === base.group_zone_id)
    : allRoutes.filter((r) => !base.zone_id || String(r.zone_id) === base.zone_id);
  const onGroup = (v) => { const g = allGroups.find((x) => String(x.id) === v); set({ group_id: v, group_zone_id: '', route_id: '', ...(g ? { zone_id: String(g.zone_id) } : {}) }); };
  const onDistrict = (v) => set({ zone_id: v, group_id: '', group_zone_id: '', route_id: '' });
  const onSubZone = (v) => {
    if (!v || base.group_id) { set({ route_id: v }); return; }
    const r = allRoutes.find((x) => String(x.id) === v);
    set({ route_id: v, group_zone_id: '', ...(r ? { group_id: String(r.group_id), zone_id: String(r.zone_id) } : {}) });
  };

  // removable chips
  const nameOf = (list, id, fn) => { const x = list.find((i) => String(i.id) === String(id)); return x ? fn(x) : `#${id}`; };
  const chips = [];
  if (filters.q) chips.push({ k: 'q', label: `“${filters.q}”`, clear: () => { setSearch(''); setDebouncedQ(''); } });
  if (base.status) chips.push({ k: 'status', label: t(`dv.st.${base.status}`) });
  if (base.source) chips.push({ k: 'source', label: t(`dv.src.${base.source}`) });
  if (base.currency) chips.push({ k: 'currency', label: base.currency });
  if (base.age) chips.push({ k: 'age', label: t(`dv.age.${base.age}`) });
  if (base.promise) chips.push({ k: 'promise', label: `${t('dv.f.promise')}: ${t(`dv.pr.${base.promise}`)}` });
  if (base.zone_id) chips.push({ k: 'zone_id', label: nameOf(districts, base.zone_id, (z) => districtLabel(z.name)), clear: () => onDistrict('') });
  if (base.group_id) chips.push({ k: 'group_id', label: nameOf(allGroups, base.group_id, (g) => groupLabel(g.code, g.name)), clear: () => set({ group_id: '', group_zone_id: '', route_id: '' }) });
  if (base.group_zone_id) chips.push({ k: 'group_zone_id', label: nameOf(groupZones, base.group_zone_id, (z) => z.name || z.code), clear: () => set({ group_zone_id: '', route_id: '' }) });
  if (base.route_id) chips.push({ k: 'route_id', label: nameOf([...subZones, ...allRoutes], base.route_id, (r) => r.name || r.code) });
  if (base.amount_min) chips.push({ k: 'amount_min', label: `≥ ${base.amount_min}` });
  if (base.amount_max) chips.push({ k: 'amount_max', label: `≤ ${base.amount_max}` });
  if (base.customer_id) chips.push({ k: 'customer_id', label: rows[0]?.customer_name && view === 'debts' ? rows[0].customer_name : `${t('dv.col.customer')} #${base.customer_id}` });
  const anyFilter = chips.length > 0;
  const clearAll = () => { setSearch(''); setDebouncedQ(''); setBase({ ...EMPTY, status: '' }); };

  const openDrawer = (id) => { const n = new URLSearchParams(searchParams); n.set('debt', String(id)); setSearchParams(n, { replace: false }); };
  const closeDrawer = () => { const n = new URLSearchParams(searchParams); n.delete('debt'); setSearchParams(n, { replace: true }); };
  const amountText = (d) => fmtMoney(d.remaining, d.currency);
  const onAction = (kind, d) => {
    if (kind === 'collect' || kind === 'details') { openDrawer(d.id); return; }
    if (kind === 'followup') {
      setModal({ kind, target: { customer_id: d.customer_id, customer_name: d.customer_name, phone: d.phone, whatsapp: d.whatsapp, debt_id: d.id, currency: d.currency, amountText: amountText(d) } });
      return;
    }
    setModal({ kind, debt: d });
  };
  const followCustomer = (c) => setModal({ kind: 'followup', target: {
    customer_id: c.customer_id, customer_name: c.customer_name, phone: c.phone, whatsapp: c.whatsapp, currency: c.totals.SLSH > 0.4 && !(c.totals.USD > 0.004) ? 'SLSH' : 'USD',
    amountText: [c.totals.USD > 0.004 ? fmtMoney(c.totals.USD, 'USD') : null, c.totals.SLSH > 0.4 ? fmtMoney(c.totals.SLSH, 'SLSH') : null].filter(Boolean).join(' + '),
  } });

  async function onExport() {
    setExporting(true);
    try { await exportDebtsCsv(filters, { sort: sort.key, dir: sort.dir }); } catch (e) { toast.error(e.message); } finally { setExporting(false); }
  }
  const quick = (patch, v = 'debts') => { setView(v); setSearch(''); setDebouncedQ(''); setBase({ ...EMPTY, ...patch }); };
  const toggleSort = (key) => setSort((c) => (c.key === key ? { key, dir: c.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'customer' ? 'asc' : 'desc' }));
  const toggleExpand = (id) => setExpanded((cur) => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div>
      <header className="dv-hero">
        <div>
          <h1><HandCoins size={24} /> {t('dv.title')}</h1>
          <p>{t('dv.subtitle')}</p>
        </div>
        <div className="acts">
          <Button variant="secondary" icon={Download} onClick={onExport} disabled={exporting || !meta.total || view !== 'debts'}>{exporting ? t('dv.exporting') : t('dv.export')}</Button>
          {canCreate && <Button icon={Plus} onClick={() => setModal({ kind: 'create' })}>{t('dv.create')}</Button>}
        </div>
      </header>

      <div className="dv-note" role="note">
        <Info size={16} />
        <div><strong>{t('dv.note.title')}</strong>{t('dv.note.body')}</div>
      </div>

      <div className="cl-stats dv-stats">
        <StatMoney accent="var(--danger)" icon={Wallet} label={t('dv.card.outstanding')} pair={s?.outstanding} sub={s ? t('dv.card.outstandingSub', undefined, { n: s.open_count }) : ''}
          pressed={view === 'debts' && base.status === 'open' && !base.age && !base.promise} onClick={() => quick({ status: 'open' })} />
        <StatMoney accent="var(--warning)" icon={Hourglass} label={t('dv.card.over60')} pair={s?.over_60} sub={s ? t('dv.card.debtsN', undefined, { n: s.over_60_count }) : ''}
          pressed={base.age === 'over_60'} onClick={() => quick({ status: 'open', age: 'over_60' })} />
        <StatMoney accent="var(--danger)" icon={AlarmClock} label={t('dv.card.over90')} pair={s?.over_90} sub={s ? t('dv.card.debtsN', undefined, { n: s.over_90_count }) : ''}
          pressed={base.age === '90_plus'} onClick={() => quick({ status: 'open', age: '90_plus' })} />
        <StatCount accent="var(--info)" icon={Users} label={t('dv.card.customers')} value={s?.customers_owing} sub={t('dv.card.customersSub')}
          pressed={view === 'customer'} onClick={() => quick({ status: 'open' }, 'customer')} />
        <StatMoney accent="var(--brand)" icon={Coins} label={t('dv.card.collected')} pair={s?.collected_this_month} sub={s ? t('dv.card.collectedSub', undefined, { n: s.collected_count }) : ''} />
        <StatCount accent="var(--warning)" icon={CalendarCheck} label={t('dv.card.dueToday')} value={s?.promises_due_today} sub={t('dv.card.promisesSub')}
          pressed={base.promise === 'due_today'} onClick={() => quick({ status: 'open', promise: 'due_today' })} />
        <StatCount accent="var(--danger)" icon={CalendarX} label={t('dv.card.broken')} value={s?.broken_promises} sub={t('dv.card.promisesSub')}
          pressed={base.promise === 'broken'} onClick={() => quick({ status: 'open', promise: 'broken' })} />
      </div>

      <div className="cl-filters dv-filters">
        <label className="cl-search">
          <Search size={15} />
          <input className="cl-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('dv.searchPh')} aria-label={t('dv.searchPh')} />
        </label>
        <select className="cl-input" value={base.status} onChange={(e) => set({ status: e.target.value })} aria-label={t('dv.f.status')}>
          <option value="">{t('dv.f.anyStatus')}</option>
          {['open', 'unpaid', 'partial', 'paid', 'written_off'].map((k) => <option key={k} value={k}>{t(`dv.st.${k}`)}</option>)}
        </select>
        <select className="cl-input" value={base.source} onChange={(e) => set({ source: e.target.value })} aria-label={t('dv.f.source')}>
          <option value="">{t('dv.f.anySource')}</option>
          <option value="auto">{t('dv.src.auto')}</option>
          <option value="manual">{t('dv.src.manual')}</option>
        </select>
        <select className="cl-input" value={base.currency} onChange={(e) => set({ currency: e.target.value })} aria-label={t('dv.f.currency')}>
          <option value="">{t('dv.f.anyCurrency')}</option>
          <option value="USD">USD</option>
          <option value="SLSH">SLSH</option>
        </select>
        <select className="cl-input" value={base.age} onChange={(e) => set({ age: e.target.value })} aria-label={t('dv.f.age')}>
          <option value="">{t('dv.f.anyAge')}</option>
          {['0_30', '31_60', '61_90', '90_plus', 'over_60'].map((k) => <option key={k} value={k}>{t(`dv.age.${k}`)}</option>)}
        </select>
        <select className="cl-input" value={base.promise} onChange={(e) => set({ promise: e.target.value })} aria-label={t('dv.f.promise')}>
          <option value="">{t('dv.f.anyPromise')}</option>
          {['due_today', 'broken', 'upcoming', 'none'].map((k) => <option key={k} value={k}>{t(`dv.pr.${k}`)}</option>)}
        </select>
        {districts.length > 1 && (
          <select className="cl-input" value={base.zone_id} onChange={(e) => onDistrict(e.target.value)} aria-label={t('map.f.district')}>
            <option value="">{t('map.f.all_districts')}</option>
            {districts.map((z) => <option key={z.id} value={String(z.id)}>{districtLabel(z.name)}</option>)}
          </select>
        )}
        <select className="cl-input" value={base.group_id} onChange={(e) => onGroup(e.target.value)} aria-label={t('map.f.group')}>
          <option value="">{t('map.all_groups')}</option>
          {groups.map((g) => <option key={g.id} value={String(g.id)}>{groupLabel(g.code, g.name)}</option>)}
        </select>
        <select className="cl-input" value={base.group_zone_id} onChange={(e) => set({ group_zone_id: e.target.value, route_id: '' })} disabled={!base.group_id} aria-label={t('map.f.zone')}>
          <option value="">{t('map.f.all_zones')}</option>
          {groupZones.map((z) => <option key={z.id} value={String(z.id)}>{z.name || z.code}</option>)}
        </select>
        <select className="cl-input" value={base.route_id} onChange={(e) => onSubZone(e.target.value)} aria-label={t('map.f.subzone')}>
          <option value="">{t('map.f.all_subzones')}</option>
          {subZones.map((r) => <option key={r.id} value={String(r.id)}>{base.group_id ? (r.name || r.code) : `${r.name || r.code} — ${groupLabel(r.group_code, r.group_name)}`}</option>)}
        </select>
        <div className="dv-amounts" title={t('dv.f.amountHint')}>
          <input className="cl-input" type="number" min="0" inputMode="decimal" value={base.amount_min} onChange={(e) => set({ amount_min: e.target.value })} placeholder={t('dv.f.amountMin')} aria-label={t('dv.f.amountMin')} />
          <input className="cl-input" type="number" min="0" inputMode="decimal" value={base.amount_max} onChange={(e) => set({ amount_max: e.target.value })} placeholder={t('dv.f.amountMax')} aria-label={t('dv.f.amountMax')} />
        </div>
      </div>
      <div className="cl-chiprow">
        {chips.map((c) => (
          <span key={c.k} className="cl-fchip">
            {c.label}
            <button type="button" aria-label={t('dv.removeFilter', undefined, { f: c.label })} onClick={c.clear || (() => set({ [c.k]: '' }))}><X size={13} /></button>
          </span>
        ))}
        {anyFilter && <button type="button" className="cl-clear" onClick={clearAll}>{t('dv.clearAll')}</button>}
      </div>

      <div className="cl-card">
        <div className="cl-toolbar">
          <div className="dv-viewtoggle" role="group" aria-label={t('dv.view.debts')}>
            <button type="button" aria-pressed={view === 'debts'} onClick={() => { setView('debts'); setPage(1); }}><List size={14} /> {t('dv.view.debts')}</button>
            <button type="button" aria-pressed={view === 'customer'} onClick={() => { setView('customer'); setPage(1); setExpanded(new Set()); }}><UserRound size={14} /> {t('dv.view.customers')}</button>
          </div>
          <span className="count">{meta.total ? t('dv.showing', undefined, { from: (page - 1) * pageSize + 1, to: Math.min(page * pageSize, meta.total), total: meta.total.toLocaleString('en-US') }) : ''}</span>
          <label className="sort">
            {t('dv.sortBy')}
            {view === 'debts' ? (
              <select className="cl-input" value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [key, dir] = e.target.value.split(':'); setSort({ key, dir }); }}>
                <option value="created_at:desc">{t('dv.sort.newest')}</option>
                <option value="age:desc">{t('dv.sort.oldest')}</option>
                <option value="amount:desc">{t('dv.sort.amount')}</option>
                <option value="customer:asc">{t('dv.sort.customer')}</option>
                <option value="promise:asc">{t('dv.sort.promise')}</option>
              </select>
            ) : (
              <select className="cl-input" value={`${csort.key}:${csort.dir}`} onChange={(e) => { const [key, dir] = e.target.value.split(':'); setCsort({ key, dir }); }}>
                <option value="oldest:desc">{t('dv.sort.oldest')}</option>
                <option value="usd:desc">{t('dv.sort.amount')} (USD)</option>
                <option value="slsh:desc">{t('dv.sort.amount')} (SLSH)</option>
                <option value="count:desc">{t('dv.sort.count')}</option>
                <option value="customer:asc">{t('dv.sort.customer')}</option>
                <option value="last_followup:desc">{t('dv.sort.followup')}</option>
              </select>
            )}
          </label>
        </div>

        {listQ.isLoading && <LoadingState label={t('dv.loading')} />}
        {listQ.error && <ErrorState message={listQ.error.message} onRetry={listQ.refetch} />}
        {!listQ.isLoading && !listQ.error && rows.length === 0 && (
          <div className="cl-empty">
            <HandCoins size={28} />
            <strong>{anyFilter ? t('dv.empty.filtered') : t('dv.empty.title')}</strong>
            {!anyFilter && <span>{t('dv.empty.body')}</span>}
            {anyFilter && <Button variant="secondary" onClick={clearAll}>{t('dv.clearAll')}</Button>}
          </div>
        )}

        {!listQ.isLoading && !listQ.error && rows.length > 0 && view === 'debts' && (<>
          <div className="cl-table-wrap">
            <table className="cl-table">
              <thead>
                <tr>
                  <th><SortBtn k="customer" sort={sort} onSort={toggleSort}>{t('dv.col.customer')}</SortBtn></th>
                  <th>{t('dv.col.debt')}</th>
                  <th><SortBtn k="age" sort={sort} onSort={toggleSort}>{t('dv.col.age')}</SortBtn></th>
                  <th className="r">{t('dv.col.amount')}</th>
                  <th className="r">{t('dv.col.paid')}</th>
                  <th className="r"><SortBtn k="amount" sort={sort} onSort={toggleSort}>{t('dv.col.remaining')}</SortBtn></th>
                  <th><SortBtn k="status" sort={sort} onSort={toggleSort}>{t('dv.col.status')}</SortBtn></th>
                  <th><SortBtn k="promise" sort={sort} onSort={toggleSort}>{t('dv.col.promise')}</SortBtn></th>
                  <th aria-label={t('dv.act.more', undefined, { id: '' })} />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => <DebtRow key={d.id} d={d} canCollect={canCollect} role={role} userId={user?.id} onAction={onAction} />)}
              </tbody>
            </table>
          </div>
          <div className="cl-cards">
            {rows.map((d) => <DebtCard key={d.id} d={d} canCollect={canCollect} role={role} userId={user?.id} onAction={onAction} />)}
          </div>
        </>)}

        {!listQ.isLoading && !listQ.error && rows.length > 0 && view === 'customer' && (<>
          <div className="cl-table-wrap">
            <table className="cl-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }} />
                  <th>{t('dv.col.customer')}</th>
                  <th className="r">{t('dv.col.totals')}</th>
                  <th className="r">{t('dv.col.count')}</th>
                  <th>{t('dv.col.oldest')}</th>
                  <th>{t('dv.col.lastFollowup')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <React.Fragment key={c.customer_id}>
                    <tr onClick={() => toggleExpand(c.customer_id)} aria-expanded={expanded.has(c.customer_id)}>
                      <td><button type="button" className="dv-expander" aria-label={expanded.has(c.customer_id) ? t('dv.collapse') : t('dv.expand')} onClick={(e) => { e.stopPropagation(); toggleExpand(c.customer_id); }}>
                        {expanded.has(c.customer_id) ? <ChevronDown size={14} /> : <Expand size={14} />}
                      </button></td>
                      <td><CustomerCell row={c} /></td>
                      <td className="r"><MoneyPair usd={c.totals.USD} slsh={c.totals.SLSH} className="dv-amt dv-rem" /></td>
                      <td className="r dv-amt">{c.open_count}{c.debt_count !== c.open_count ? <span className="cl-muted"> / {c.debt_count}</span> : null}</td>
                      <td>{c.oldest_age !== null ? <AgeChip days={c.oldest_age} bucket={c.oldest_age <= 30 ? '0_30' : c.oldest_age <= 60 ? '31_60' : c.oldest_age <= 90 ? '61_90' : '90_plus'} /> : '—'}
                        <div className="cl-chips">
                          {c.broken_promises > 0 && <span className="cl-chip danger">{t('dv.pr.broken')} · {c.broken_promises}</span>}
                          {c.promises_due_today > 0 && <span className="cl-chip warning">{t('dv.pr.due_today')} · {c.promises_due_today}</span>}
                        </div>
                      </td>
                      <td className="cl-sub">{c.last_followup_at ? fmtDateTime(c.last_followup_at) : '—'}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="dv-row-acts"><button type="button" className="dv-btn" onClick={() => followCustomer(c)}><MessageSquarePlus size={14} /> {t('dv.act.followup')}</button></div>
                      </td>
                    </tr>
                    {expanded.has(c.customer_id) && (
                      <tr className="dv-subrow"><td colSpan={7}><div className="inner"><CustomerDebts filters={filters} customerId={c.customer_id} canCollect={canCollect} role={role} userId={user?.id} onAction={onAction} /></div></td></tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="cl-cards">
            {rows.map((c) => (
              <div key={c.customer_id} className="cl-mcard" onClick={() => toggleExpand(c.customer_id)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') toggleExpand(c.customer_id); }}>
                <div className="top">
                  <div style={{ minWidth: 0 }}><CustomerCell row={c} /></div>
                  <div className="bal"><MoneyPair usd={c.totals.USD} slsh={c.totals.SLSH} className="dv-amt dv-rem" /></div>
                </div>
                <div className="bottom" onClick={(e) => e.stopPropagation()}>
                  <span className="cl-sub">{c.open_count} · {c.oldest_age !== null ? t('dv.ageDays', undefined, { n: c.oldest_age }) : ''}</span>
                  <button type="button" className="dv-btn" onClick={() => followCustomer(c)}><MessageSquarePlus size={14} /> {t('dv.act.followup')}</button>
                </div>
                {expanded.has(c.customer_id) && <div onClick={(e) => e.stopPropagation()} style={{ marginTop: '8px' }}><CustomerDebts filters={filters} customerId={c.customer_id} canCollect={canCollect} role={role} userId={user?.id} onAction={onAction} compact /></div>}
              </div>
            ))}
          </div>
        </>)}

        {!listQ.isLoading && !listQ.error && rows.length > 0 && (
          <Pager page={page} pages={meta.pages || 1} pageSize={pageSize} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
        )}
      </div>

      {drawerId && <DebtDrawer debtId={drawerId} onClose={closeDrawer} onAction={onAction} />}
      {modal?.kind === 'followup' && <FollowupModal target={modal.target} onClose={() => setModal(null)} />}
      {modal?.kind === 'writeoff' && <WriteOffModal debt={modal.debt} onClose={() => setModal(null)} />}
      {modal?.kind === 'edit' && <EditDebtModal debt={modal.debt} onClose={() => setModal(null)} />}
      {modal?.kind === 'settle' && <SettleModal debt={modal.debt} onClose={() => setModal(null)} />}
      {modal?.kind === 'create' && <CreateDebtModal onClose={() => setModal(null)} />}
    </div>
  );
}

function StatMoney({ accent, icon: Icon, label, pair, sub, pressed, onClick }) {
  const { t } = useI18n();
  const usd = Number(pair?.USD || 0);
  const slsh = Number(pair?.SLSH || 0);
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} className={`cl-stat${onClick ? '' : ' static'}`} style={{ '--accent-c': accent }} aria-pressed={onClick ? !!pressed : undefined} onClick={onClick}>
      <span className="k"><Icon size={14} /> {label}</span>
      <span className="dv-stat-money">
        {!pair ? <span className="v">—</span> : (usd <= 0.004 && slsh <= 0.4) ? <span className="v">{t('dv.none')}</span> : (<>
          {usd > 0.004 && <span className="v">{fmtMoney(usd, 'USD')}</span>}
          {slsh > 0.4 && <span className={usd > 0.004 ? 'v2' : 'v'}>{fmtMoney(slsh, 'SLSH')}</span>}
        </>)}
      </span>
      <span className="s">{sub}</span>
    </Tag>
  );
}

function StatCount({ accent, icon: Icon, label, value, sub, pressed, onClick }) {
  return (
    <button type="button" className="cl-stat" style={{ '--accent-c': accent }} aria-pressed={!!pressed} onClick={onClick}>
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

function CustomerCell({ row }) {
  const path = pathText(row);
  return (
    <div onClick={(e) => e.stopPropagation()}>
      <Link className="dv-cust-link" to={`/customers/${row.customer_id}`}>
        <div className="cl-num">{row.customer_number}</div>
        <div className="cl-name">{row.customer_name}</div>
      </Link>
      {row.business_name && <div className="cl-biz">{row.business_name}</div>}
      {path && <div className="cl-sub">{path}</div>}
      <PhoneLinks row={row} />
      <div className="cl-chips"><SuspensionChip s={row.suspension} /></div>
    </div>
  );
}

function DebtInfo({ d }) {
  const { t } = useI18n();
  return (
    <div>
      <div className="cl-chips" style={{ marginTop: 0 }}>
        <SourceChip row={d} />
        {d.invoice_id
          ? <Link className="dv-inv" to={`/financial/invoices/${d.invoice_id}`} onClick={(e) => e.stopPropagation()}>{d.invoice_number || `#${d.invoice_id}`}</Link>
          : <span className="cl-sub">{t('dv.standalone')}</span>}
        {d.invoice_voided && <span className="cl-chip">{t('dv.invoiceVoided')}</span>}
      </div>
      {d.description && <div className="dv-desc">{d.description}</div>}
    </div>
  );
}

function DebtRow({ d, canCollect, role, userId, onAction }) {
  return (
    <tr onClick={() => onAction('details', d)}>
      <td><CustomerCell row={d} /></td>
      <td><DebtInfo d={d} /></td>
      <td><div className="cl-sub">{fmtDate(d.created_at)}</div><AgeChip days={d.age_days} bucket={d.age_bucket} /></td>
      <td className="r"><div className="dv-amt">{fmtMoney(d.amount, d.currency)}</div><div className="dv-cur">{d.currency}</div></td>
      <td className="r dv-amt">{d.paid_amount === null ? <span className="cl-muted">—</span> : fmtMoney(d.paid_amount, d.currency)}</td>
      <td className="r"><span className={`dv-amt dv-rem${d.remaining > 0 ? '' : ' zero'}`}>{fmtMoney(d.remaining, d.currency)}</span></td>
      <td><StateChip state={d.state} /></td>
      <td><PromiseCell row={d} /></td>
      <td onClick={(e) => e.stopPropagation()}><RowActions d={d} canCollect={canCollect} role={role} userId={userId} onAction={onAction} /></td>
    </tr>
  );
}

function DebtCard({ d, canCollect, role, userId, onAction }) {
  const { t } = useI18n();
  return (
    <div className="cl-mcard" role="button" tabIndex={0} onClick={() => onAction('details', d)} onKeyDown={(e) => { if (e.key === 'Enter') onAction('details', d); }}>
      <div className="top">
        <div style={{ minWidth: 0 }}><CustomerCell row={d} /></div>
        <div className="bal">
          <div className={`dv-amt dv-rem${d.remaining > 0 ? '' : ' zero'}`}>{fmtMoney(d.remaining, d.currency)}</div>
          <div className="cl-sub">{t('dv.col.amount')}: {fmtMoney(d.amount, d.currency)}</div>
        </div>
      </div>
      <div className="meta"><DebtInfo d={d} /></div>
      <div className="cl-chips">
        <StateChip state={d.state} />
        <AgeChip days={d.age_days} bucket={d.age_bucket} />
        {d.promise_state !== 'none' && <span className={`cl-chip ${d.promise_state === 'broken' ? 'danger' : d.promise_state === 'due_today' ? 'warning' : 'info'}`}>{t(`dv.pr.${d.promise_state}`)} · {d.promise_date}</span>}
      </div>
      <div className="bottom" onClick={(e) => e.stopPropagation()}>
        <span className="cl-sub">#{d.id} · {fmtDate(d.created_at)}</span>
        <RowActions d={d} canCollect={canCollect} role={role} userId={userId} onAction={onAction} />
      </div>
    </div>
  );
}

function RowActions({ d, canCollect, role, userId, onAction }) {
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
  const collectable = isOpen(d) && canCollect && d.collect_target !== 'manual_invoice';
  const run = (kind) => () => { setOpen(false); onAction(kind, d); };
  const toggle = () => { if (!open && ref.current) setUp(ref.current.getBoundingClientRect().bottom > window.innerHeight - 230); setOpen((o) => !o); };
  return (
    <div className="dv-row-acts">
      {collectable && <button type="button" className="dv-btn primary" onClick={() => onAction('collect', d)}><CreditCard size={14} /> {t('dv.act.collectShort')}</button>}
      <div className="cl-actions" ref={ref}>
        <button type="button" className="cl-menu-btn" aria-haspopup="menu" aria-expanded={open} aria-label={t('dv.act.more', undefined, { id: d.id })} onClick={toggle}><MoreVertical size={16} /></button>
        {open && (
          <div className={`cl-menu${up ? ' up' : ''}`} role="menu">
            <button type="button" role="menuitem" onClick={run('details')}><ExternalLink size={14} /> {t('dv.act.details')}</button>
            <button type="button" role="menuitem" onClick={run('followup')}><MessageSquarePlus size={14} /> {t('dv.act.followup')}</button>
            {(role === 'admin' || (['cashier', 'gudoomiye'].includes(role) && d.created_by === userId)) && <button type="button" role="menuitem" onClick={run('edit')}><Pencil size={14} /> {t('dv.act.edit')}</button>}
            {role === 'admin' && isOpen(d) && <button type="button" role="menuitem" className="pay" onClick={run('writeoff')}><Ban size={14} /> {t('dv.act.writeOff')}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

// Expanded "By customer" row: that customer's debts under the same filters.
function CustomerDebts({ filters, customerId, canCollect, role, userId, onAction, compact = false }) {
  const { t } = useI18n();
  const q = useDebtsPage({ ...filters, customer_id: String(customerId) }, { page: 1, pageSize: 100, sort: 'age', dir: 'desc' });
  const list = q.data?.data || [];
  if (q.isLoading) return <LoadingState label={t('common.loading')} />;
  if (q.error) return <ErrorState message={q.error.message} onRetry={q.refetch} />;
  return (
    <table className="dv-subtable">
      <tbody>
        {list.map((d) => (
          <tr key={d.id} onClick={() => onAction('details', d)} style={{ cursor: 'pointer' }}>
            <td><DebtInfo d={d} /></td>
            {!compact && <td><AgeChip days={d.age_days} bucket={d.age_bucket} /></td>}
            <td className="r"><span className={`dv-amt dv-rem${d.remaining > 0 ? '' : ' zero'}`}>{fmtMoney(d.remaining, d.currency)}</span></td>
            {!compact && <td><StateChip state={d.state} /></td>}
            <td onClick={(e) => e.stopPropagation()}><RowActions d={d} canCollect={canCollect} role={role} userId={userId} onAction={onAction} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
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
        {t('dv.perPage')}
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
