import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeftRight, Download, Search, CalendarDays, CalendarRange, Smartphone, Filter } from 'lucide-react';
import { PageHeader, Button, Card, DataTable, StatusBadge, Pagination, useToast } from '../../components/ui/index.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useTransactions, useTransactionsSummary, downloadTransactionsCsv } from '../../hooks/useFinancial.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { fmtByCurrency } from '../../lib/money.js';
import { PAYMENT_STATUS_MAP, fmtMoney, methodLabel, paymentChannelLabel, recordedByLabel, fmtDateTime } from './financeUtils.js';
import './finance.css';

// Transactions — read-only ledger of every payment (GET /payments/transactions).
// Scope is decided server-side: cashier = own payments, gudoomiye / zone
// accountant = their district, admin = all. Reversal stays on the invoice page.
const PAGE_SIZE = 25;
const METHOD_COLORS = { cash: '#4caf3f', slsh: '#2e7d32', zaad: '#f5a623', edahab: '#2563a8' };
const EMPTY = { date_from: '', date_to: '', method: '', currency: '', channel: '', status: '' };

export default function TransactionsPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [filters, setFilters] = useState(EMPTY);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const h = setTimeout(() => { setQ(search.trim().length >= 2 ? search.trim() : ''); setPage(1); }, 300);
    return () => clearTimeout(h);
  }, [search]);

  const query = { ...filters, q };
  const list = useTransactions({ ...query, page, page_size: PAGE_SIZE });
  const sum = useTransactionsSummary(query);
  const rows = list.data?.data || [];
  const meta = list.data?.meta || { total: 0, page: 1, page_size: PAGE_SIZE };
  const s = sum.data?.data;
  const role = (user?.role || '').toLowerCase();
  const scopeNote = role === 'cashier' ? t('fr.tx.ownOnly') : ['gudoomiye', 'zone_accountant'].includes(role) ? t('fr.tx.zoneOnly') : null;
  const anyFilter = q || Object.values(filters).some(Boolean);

  const set = (k) => (e) => { setFilters((f) => ({ ...f, [k]: e.target.value })); setPage(1); };
  const preset = (kind) => {
    if (!s) return;
    if (kind === 'today') setFilters((f) => ({ ...f, date_from: s.date, date_to: s.date }));
    else if (kind === 'month') setFilters((f) => ({ ...f, date_from: `${s.period}-01`, date_to: s.date }));
    else setFilters((f) => ({ ...f, date_from: '', date_to: '' }));
    setPage(1);
  };
  const activePreset = s && filters.date_from === s.date && filters.date_to === s.date ? 'today'
    : s && filters.date_from === `${s.period}-01` && filters.date_to === s.date ? 'month'
      : !filters.date_from && !filters.date_to ? 'all' : null;

  async function exportCsv() {
    setExporting(true);
    try { await downloadTransactionsCsv(query); } catch (err) { toast.error(err.message); } finally { setExporting(false); }
  }

  return (
    <div>
      <PageHeader
        icon={ArrowLeftRight}
        title={t('nav.transactions')}
        subtitle={scopeNote ? `${t('fr.tx.subtitle')} ${scopeNote}` : t('fr.tx.subtitle')}
        actions={<Button variant="secondary" icon={Download} onClick={exportCsv} disabled={exporting}>{t('fr.tx.export')}</Button>}
      />

      <div className="fin-stats">
        <PeriodCard icon={CalendarDays} label={t('fr.tx.today')} block={s?.today} />
        <PeriodCard icon={CalendarRange} label={t('fr.tx.month')} block={s?.month} />
        <MethodCard block={s?.month} />
        <Card className="fin-card-pad" style={{ borderLeft: '3px solid var(--info)' }}>
          <div className="fin-card-k"><Filter size={13} style={{ verticalAlign: '-2px' }} /> {t('fr.tx.filtered')}</div>
          <div className="fin-card-v">{s ? fmtByCurrency(s.filtered.by_currency) : '—'}</div>
          <div className="fin-card-s">
            {s ? `${t('fr.tx.payments', undefined, { n: s.filtered.count })} · ${t('fr.tx.usdTotal', undefined, { amount: fmtMoney(s.filtered.total_usd, 'USD') })}` : ''}
          </div>
          {s && s.filtered.reversed_count > 0 && (
            <div className="fin-card-s" style={{ color: 'var(--danger)' }}>{t('fr.tx.reversedInfo', undefined, { n: s.filtered.reversed_count, amount: fmtMoney(s.filtered.reversed_usd, 'USD') })}</div>
          )}
        </Card>
      </div>
      <div className="fin-note" style={{ margin: '-8px 0 14px' }}>{t('fr.tx.receivedNote')}</div>

      <Card style={{ padding: '14px', marginBottom: '14px' }}>
        <div className="fin-tx-bar">
          <div className="fin-chip-row" role="group">
            {['today', 'month', 'all'].map((k) => (
              <button key={k} type="button" className="fin-chip" aria-pressed={activePreset === k} onClick={() => preset(k)} disabled={!s && k !== 'all'}>
                {k === 'today' ? t('fr.bill.ageToday') : k === 'month' ? t('fr.tx.thisMonth') : t('fr.bill.all')}
              </button>
            ))}
          </div>
          {anyFilter && <button type="button" className="fin-linkbtn" onClick={() => { setFilters(EMPTY); setSearch(''); setQ(''); setPage(1); }}>{t('fr.tx.clear')}</button>}
        </div>
        <div className="fin-tx-filters">
          <div className="fin-search">
            <Search size={15} />
            <input className="fin-input" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('fr.tx.search')} aria-label={t('fr.tx.search')} />
          </div>
          <label className="fin-field"><span>{t('fr.tx.from')}</span><input className="fin-input" type="date" value={filters.date_from} onChange={set('date_from')} /></label>
          <label className="fin-field"><span>{t('fr.tx.to')}</span><input className="fin-input" type="date" value={filters.date_to} onChange={set('date_to')} /></label>
          <label className="fin-field"><span>{t('fr.tx.col.method')}</span>
            <select className="fin-input" value={filters.method} onChange={set('method')}>
              <option value="">{t('fr.tx.allMethods')}</option>
              {['cash', 'zaad', 'edahab', 'slsh', 'debt'].map((m) => <option key={m} value={m}>{methodLabel(t, m)}</option>)}
            </select>
          </label>
          <label className="fin-field"><span>{t('fr.pay.currency')}</span>
            <select className="fin-input" value={filters.currency} onChange={set('currency')}>
              <option value="">{t('fr.tx.allCurrencies')}</option>
              <option value="USD">USD</option>
              <option value="SLSH">SLSH</option>
            </select>
          </label>
          <label className="fin-field"><span>{t('fr.tx.col.channel')}</span>
            <select className="fin-input" value={filters.channel} onChange={set('channel')}>
              <option value="">{t('fr.tx.allChannels')}</option>
              <option value="staff">{t('fr.channel.staff')}</option>
              <option value="portal">{t('fr.channel.portal')}</option>
            </select>
          </label>
          <label className="fin-field"><span>{t('fr.tx.col.status')}</span>
            <select className="fin-input" value={filters.status} onChange={set('status')}>
              <option value="">{t('fr.tx.allStatuses')}</option>
              <option value="recorded">{t('fr.tx.recorded')}</option>
              <option value="reversed">{t('fr.tx.reversed')}</option>
            </select>
          </label>
        </div>
      </Card>

      <div className="fin-note" style={{ marginBottom: '8px' }}>{list.data ? t('fr.tx.total', undefined, { n: meta.total }) : ''}</div>
      <DataTable
        loading={list.isLoading}
        error={list.error?.message}
        onRetry={list.refetch}
        isEmpty={!list.isLoading && !list.error && rows.length === 0}
        emptyTitle={t('fr.tx.empty')}
        columns={[
          { label: t('fr.tx.col.date') }, { label: t('fr.tx.col.invoice') }, { label: t('fr.tx.col.customer') },
          { label: t('fr.tx.col.method') }, { label: t('fr.tx.col.channel') }, { label: t('fr.tx.col.amount'), align: 'right' },
          { label: t('fr.tx.col.usd'), align: 'right' }, { label: t('fr.tx.col.by') }, { label: t('fr.tx.col.status') },
        ]}
      >
        {rows.map((p) => (
          <tr key={p.id} className={`fin-tx-row${p.status === 'reversed' ? ' reversed' : ''}`} onClick={() => navigate(`/financial/invoices/${p.invoice_id}`)}
            tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/financial/invoices/${p.invoice_id}`); }}>
            <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(p.created_at)}</td>
            <td><strong>{p.invoice_number}</strong></td>
            <td>{p.customer_name}<div className="fin-note">{p.customer_number}</div></td>
            <td>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontWeight: 700 }}>
                <i style={{ width: 8, height: 8, borderRadius: 2, background: METHOD_COLORS[p.method] || 'var(--text-muted)', display: 'inline-block' }} />
                {methodLabel(t, p.method)}
              </span>
              {p.reference_code && <div className="fin-note" style={{ wordBreak: 'break-all' }}>{p.reference_code}</div>}
            </td>
            <td>{p.channel === 'portal_zaad' ? <span><Smartphone size={12} style={{ verticalAlign: '-2px' }} /> {t('fr.channel.portal')}</span> : paymentChannelLabel(t, p)}</td>
            <td className="fin-money" style={{ textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700 }}>{fmtMoney(p.amount, p.currency)}</td>
            <td className="fin-money" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtMoney(p.amount_usd, 'USD')}</td>
            <td>{recordedByLabel(t, p)}</td>
            <td><StatusBadge status={p.status} map={PAYMENT_STATUS_MAP} /></td>
          </tr>
        ))}
      </DataTable>
      <Pagination page={meta.page} pageSize={meta.page_size} total={meta.total} onPageChange={setPage} />
    </div>
  );
}

function PeriodCard({ icon: Icon, label, block }) {
  const { t } = useI18n();
  return (
    <Card className="fin-card-pad" style={{ borderLeft: '3px solid var(--brand)' }}>
      <div className="fin-card-k"><Icon size={13} style={{ verticalAlign: '-2px' }} /> {label}</div>
      <div className="fin-card-v">{block ? fmtByCurrency(block.by_currency) : '—'}</div>
      {block && (
        <>
          <div className="fin-card-s">{t('fr.tx.payments', undefined, { n: block.count })} · {t('fr.tx.usdTotal', undefined, { amount: fmtMoney(block.total_usd, 'USD') })}</div>
          {block.by_channel.portal > 0.004 && <div className="fin-card-s">{t('fr.tx.portalShare', undefined, { amount: fmtMoney(block.by_channel.portal, 'USD') })}</div>}
        </>
      )}
    </Card>
  );
}

function MethodCard({ block }) {
  const { t } = useI18n();
  const entries = ['cash', 'slsh', 'zaad', 'edahab'].map((m) => [m, Number(block?.by_method?.[m] || 0)]);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  return (
    <Card className="fin-card-pad" style={{ borderLeft: '3px solid var(--accent)' }}>
      <div className="fin-card-k"><Smartphone size={13} style={{ verticalAlign: '-2px' }} /> {t('fr.tx.zaadVsCash')}</div>
      <div className="fin-mbar" role="img" aria-label={entries.map(([m, v]) => `${methodLabel(t, m)} ${fmtMoney(v, 'USD')}`).join(', ')}>
        {total > 0 && entries.map(([m, v]) => (v > 0 ? <div key={m} style={{ width: `${(v / total) * 100}%`, background: METHOD_COLORS[m] }} /> : null))}
      </div>
      <div className="fin-mlegend">
        {entries.map(([m, v]) => (
          <React.Fragment key={m}>
            <span><i style={{ background: METHOD_COLORS[m] }} />{methodLabel(t, m)}</span>
            <span className="fin-money" style={{ textAlign: 'right' }}>{fmtMoney(v, 'USD')}{total > 0 ? ` · ${Math.round((v / total) * 100)}%` : ''}</span>
          </React.Fragment>
        ))}
      </div>
    </Card>
  );
}
