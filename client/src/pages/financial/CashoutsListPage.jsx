import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wallet2, Plus, FileCheck2, Search, Clock, AlertTriangle, Landmark, Banknote, Hourglass } from 'lucide-react';
import { PageHeader, Button, LoadingState, ErrorState } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useCashouts, useCashoutSummary, useUncoveredPayments, useCashiers } from '../../hooks/useCashouts.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { fmtDate, fmtDateTime } from './financeUtils.js';
import { fmtMoney, fmtPair, varianceOf, ageDays } from './cashoutUtils.js';
import { StatusChip, DepositChip, VarianceChip, NeedsAdminChip, Person } from './CashoutBits.jsx';
import CashoutFormModal from './CashoutFormModal.jsx';
import './cashout.css';

const STATUSES = ['pending', 'approved', 'rejected', 'voided'];
const DEPOSIT_STATUSES = ['not_deposited', 'partial', 'deposited', 'verified', 'variance', 'not_required'];
const EMPTY_FILTERS = { status: '', q: '', zone_id: '', cashier_id: '', date_from: '', date_to: '', deposit_status: '', needs_admin: '', has_shortage: '' };

export default function CashoutsListPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const role = (user?.role || '').toLowerCase();
  const canCreate = role === 'admin' || role === 'head_of_cashiers';
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [form, setForm] = useState(null); // null | prefill object
  const q = filters.q.trim().length >= 2 ? filters.q.trim() : '';
  const { data, isLoading, error, refetch } = useCashouts({ ...filters, q });
  const summary = useCashoutSummary();
  const uncovered = useUncoveredPayments();
  const { data: zonesData } = useZonesList();
  const cashiersQ = useCashiers();
  const cashouts = data?.data || [];
  const s = summary.data?.data;
  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const toggle = (patch) => setFilters((f) => {
    const same = Object.entries(patch).every(([k, v]) => f[k] === v);
    return { ...EMPTY_FILTERS, q: f.q, ...(same ? {} : patch) };
  });
  const active = (patch) => Object.entries(patch).every(([k, v]) => filters[k] === v);
  const zones = zonesData?.data || [];
  const cashierOptions = canCreate ? (cashiersQ.data?.data || []) : [];
  const anyFilter = Object.entries(filters).some(([, v]) => v);

  return (
    <div>
      <PageHeader
        icon={Wallet2}
        title={t('nav.cashout')}
        subtitle={t('co2.list.subtitle')}
        actions={canCreate && <Button icon={Plus} onClick={() => setForm({})}>{t('fin.new_cashout')}</Button>}
      />

      <div className="co-stats">
        <button type="button" className="co-stat" style={{ '--accent-c': 'var(--brand)' }} onClick={() => setFilters(EMPTY_FILTERS)}>
          <span className="k"><Banknote size={14} /> {t('co2.list.receivedMonth')}</span>
          <span className="v">{s ? fmtMoney(s.received_this_month.USD, 'USD') : '—'}</span>
          <span className="s">{s ? `+ ${fmtMoney(s.received_this_month.SLSH, 'SLSH')}` : ''}</span>
        </button>
        <button type="button" className="co-stat" style={{ '--accent-c': 'var(--warning)' }} aria-pressed={active({ status: 'pending' })} onClick={() => toggle({ status: 'pending' })}>
          <span className="k"><Hourglass size={14} /> {t('fin.pending_approval')}</span>
          <span className="v">{s ? s.pending : '—'}</span>
          <span className="s">{t('co2.list.awaiting')}</span>
        </button>
        <button type="button" className="co-stat" style={{ '--accent-c': 'var(--danger)' }} aria-pressed={active({ has_shortage: '1' })} onClick={() => toggle({ has_shortage: '1' })}>
          <span className="k"><AlertTriangle size={14} /> {t('fin.with_shortage')}</span>
          <span className="v">{s ? s.with_shortage : '—'}</span>
          <span className="s">{s ? t('co2.list.needAdminN', undefined, { n: s.needs_admin }) : ''}</span>
        </button>
        <button type="button" className="co-stat" style={{ '--accent-c': 'var(--info)' }} aria-pressed={active({ status: 'approved', deposit_status: 'not_deposited' })} onClick={() => toggle({ status: 'approved', deposit_status: 'not_deposited' })}>
          <span className="k"><Landmark size={14} /> {t('co2.list.notDeposited')}</span>
          <span className="v">{s ? s.not_deposited : '—'}</span>
          <span className="s">{t('co2.list.notDepositedHint')}</span>
        </button>
      </div>

      <UncoveredPanel query={uncovered} canCreate={canCreate} onCashOut={(row) => setForm({
        cashierId: row.cashier_id, zoneId: row.zone_id, periodStart: row.suggested_start,
        // never past "now": a cashout cannot cover time that has not happened yet
        periodEnd: row.suggested_end && new Date(row.suggested_end) < new Date() ? row.suggested_end : new Date(),
      })} />

      <div className="co-filters">
        <label className="co-search">
          <Search size={15} />
          <input className="co-input" value={filters.q} onChange={(e) => set({ q: e.target.value })} placeholder={t('co2.list.search')} aria-label={t('co2.list.search')} />
        </label>
        {(role === 'admin' || role === 'head_of_cashiers') && (
          <select className="co-input" value={filters.zone_id} onChange={(e) => set({ zone_id: e.target.value })} aria-label={t('co2.district')}>
            <option value="">{t('co2.list.allDistricts')}</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        )}
        {cashierOptions.length > 0 && (
          <select className="co-input" value={filters.cashier_id} onChange={(e) => set({ cashier_id: e.target.value })} aria-label={t('fin.cashier')}>
            <option value="">{t('co2.list.allCashiers')}</option>
            {cashierOptions.map((c) => <option key={c.id} value={c.id}>{c.full_name || c.username}</option>)}
          </select>
        )}
        <select className="co-input" value={filters.deposit_status} onChange={(e) => set({ deposit_status: e.target.value })} aria-label={t('co2.deposit')}>
          <option value="">{t('co2.list.anyDeposit')}</option>
          {DEPOSIT_STATUSES.map((d) => <option key={d} value={d}>{t(`co2.dep.${d}`)}</option>)}
        </select>
        <input type="date" className="co-input" value={filters.date_from} onChange={(e) => set({ date_from: e.target.value })} aria-label={t('co2.list.from')} title={t('co2.list.from')} />
        <input type="date" className="co-input" value={filters.date_to} onChange={(e) => set({ date_to: e.target.value })} aria-label={t('co2.list.to')} title={t('co2.list.to')} />
      </div>
      <div className="co-chiprow">
        <button type="button" className="co-fchip" aria-pressed={!filters.status} onClick={() => set({ status: '' })}>{t('co2.list.all')}</button>
        {STATUSES.map((st) => (
          <button key={st} type="button" className="co-fchip" aria-pressed={filters.status === st} onClick={() => set({ status: filters.status === st ? '' : st })}>{t(`status.${st}`)}</button>
        ))}
        {anyFilter && <button type="button" className="co-fchip" onClick={() => setFilters(EMPTY_FILTERS)}>{t('co2.list.clear')}</button>}
      </div>

      <div className="co-card">
        {isLoading && <LoadingState label={t('common.loading')} />}
        {error && <ErrorState message={error.message} onRetry={refetch} />}
        {!isLoading && !error && cashouts.length === 0 && <div className="co-empty">{anyFilter ? t('co2.list.noMatch') : t('fin.no_cashouts_yet')}</div>}
        {!isLoading && !error && cashouts.length > 0 && (<>
          <div className="co-table-wrap">
            <table className="co-table">
              <thead>
                <tr>
                  <th>{t('fin.cashout_no')}</th><th>{t('fin.cashier')}</th><th className="r">{t('dash.expected')}</th><th className="r">{t('co2.received')}</th>
                  <th>{t('co2.result')}</th><th>{t('common.status')}</th><th>{t('co2.deposit')}</th><th aria-label={t('fin.signed')} />
                </tr>
              </thead>
              <tbody>
                {cashouts.map((co) => (
                  <tr key={co.id} onClick={() => navigate(`/financial/cashouts/${co.id}`)}>
                    <td>
                      <div className="co-num">{co.cashout_number}</div>
                      <div className="co-period">{fmtDate(co.period_start)} – {fmtDate(co.period_end)}</div>
                    </td>
                    <td><Person small name={co.cashier_name || co.cashier_username || `#${co.cashier_id}`} id={co.cashier_id} sub={co.zone_name} /></td>
                    <td className="r co-money">{expectedText(co)}</td>
                    <td className="r co-money">{receivedText(co)}</td>
                    <td><ResultCell co={co} /></td>
                    <td><span style={{ display: 'inline-flex', gap: '6px', flexWrap: 'wrap' }}><StatusChip status={co.status} />{co.needs_admin && co.status === 'pending' && <NeedsAdminChip />}</span></td>
                    <td>{co.deposit_status ? <DepositChip status={co.deposit_status} /> : <span className="co-muted">—</span>}</td>
                    <td>{co.has_signed_document ? <FileCheck2 size={16} color="var(--success)" aria-label={t('fin.signed')} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="co-cards">
            {cashouts.map((co) => (
              <button type="button" key={co.id} className="co-mcard" onClick={() => navigate(`/financial/cashouts/${co.id}`)}>
                <div className="row">
                  <Person small name={co.cashier_name || co.cashier_username || `#${co.cashier_id}`} id={co.cashier_id} sub={`${co.cashout_number} · ${co.zone_name || ''}`} />
                  <span className="co-money" style={{ fontWeight: 800 }}>{receivedText(co)}</span>
                </div>
                <div className="co-period" style={{ marginTop: '6px' }}>{fmtDate(co.period_start)} – {fmtDate(co.period_end)}</div>
                <div className="chips">
                  <StatusChip status={co.status} />
                  {co.needs_admin && co.status === 'pending' && <NeedsAdminChip />}
                  <ResultCell co={co} />
                  {co.deposit_status && <DepositChip status={co.deposit_status} />}
                </div>
              </button>
            ))}
          </div>
        </>)}
      </div>

      <CashoutFormModal open={!!form} prefill={form} onClose={() => setForm(null)} />
    </div>
  );
}

function expectedText(co) {
  const b = co.breakdown;
  if (b?.totals) return fmtPair({ USD: b.totals.USD.expected, SLSH: b.totals.SLSH.expected }, fmtMoney(0, 'USD'));
  return fmtMoney(co.expected_amount, 'USD');
}
function receivedText(co) {
  const b = co.breakdown;
  if (b?.mode === 'counted') return fmtPair({ USD: b.totals.USD.actual, SLSH: b.totals.SLSH.actual }, fmtMoney(0, 'USD'));
  return fmtMoney(co.actual_amount, 'USD');
}
function ResultCell({ co }) {
  const v = varianceOf(co);
  const amt = v === 'shortage' ? Number(co.control_shortage_usd ?? co.shortage) : v === 'surplus' ? Number(co.surplus) : 0;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      <VarianceChip status={v} />
      {amt > 0.004 && <span className={`co-money ${v === 'shortage' ? 'co-neg' : 'co-pos'}`}>{fmtMoney(amt, 'USD')}</span>}
    </span>
  );
}

function UncoveredPanel({ query, canCreate, onCashOut }) {
  const { t } = useI18n();
  const rows = query.data?.data || [];
  if (query.isLoading || query.error || rows.length === 0) return null;
  return (
    <div className="co-card co-unc">
      <div className="co-card-head">
        <h3><Clock size={16} color="var(--warning)" /> {t('co2.unc.title')}</h3>
        <span className="co-note">{t('co2.unc.hint')}</span>
      </div>
      <div className="co-unc-list">
        {rows.map((r) => {
          const days = ageDays(r.oldest_at);
          return (
            <div key={r.cashier_id} className="co-unc-row">
              <Person name={r.cashier_name} id={r.cashier_id} sub={[r.zone, r.role !== 'cashier' ? r.role : null].filter(Boolean).join(' · ')} />
              <div>
                <div className="co-unc-amt">{fmtPair(r.amounts)}</div>
                <div className="co-unc-meta">≈ {fmtMoney(r.usd_equiv, 'USD')}</div>
              </div>
              <div className="co-unc-cnt">
                <div className="co-unc-meta">{t('co2.unc.payments', undefined, { n: r.payment_count })}</div>
                <div className={`co-unc-meta${days > 2 ? ' co-old' : ''}`} title={fmtDateTime(r.oldest_at)}>{t('co2.unc.oldest', undefined, { d: days })}</div>
                {r.stranded_count > 0 && <div className="co-unc-meta co-old" title={t('co2.unc.stranded', undefined, { n: r.stranded_count })}>{t('co2.unc.strandedShort', undefined, { n: r.stranded_count })}</div>}
              </div>
              <div>
                {canCreate && r.role === 'cashier' && (
                  <RoleGate roles={['admin', 'head_of_cashiers']}>
                    <Button variant="secondary" onClick={() => onCashOut(r)}>{t('co2.unc.cashOut')}</Button>
                  </RoleGate>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
