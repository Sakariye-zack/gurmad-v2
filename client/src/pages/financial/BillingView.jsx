import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Wallet, Search, Receipt, Smartphone, Banknote, Coins, CheckCircle2, AlertTriangle, X, ExternalLink, Clock,
} from 'lucide-react';
import { PageHeader, Button, StatusBadge, LoadingState, useToast, StatCard } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useOpenInvoices, useInvoice, useRecordPayment, useRequestZaadPayment } from '../../hooks/useFinancial.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { fmtByCurrency } from '../../lib/money.js';
import {
  STATUS_MAP, PAYMENT_STATUS_MAP, fmtMoney, invCurrency, otherCurrency, secondaryBlock, rateText, convert,
  methodLabel, recordedByLabel, ageDays, ageLabel, fmtDateTime, zaadErrorInfo,
} from './financeUtils.js';
import './finance.css';

// Billing — the cashier's money-collection workspace. Deliberately NOT a
// duplicate Invoice management page (approved architecture): it only selects
// an outstanding invoice and records a payment against it. Every balance
// shown comes from the server (getInvoiceBalance); the server alone sizes,
// validates and records payments (POST /payments, POST /payments/zaad-request).
const LIST_CHUNK = 60;

export default function BillingView() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('invoice') ? Number(searchParams.get('invoice')) : null;
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [curFilter, setCurFilter] = useState('all');
  const [limit, setLimit] = useState(LIST_CHUNK);

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(q.trim().length >= 2 ? q.trim() : ''), 300);
    return () => clearTimeout(h);
  }, [q]);

  const { data, isLoading, error, refetch } = useOpenInvoices(debouncedQ);
  const all = useMemo(() => (data?.data || []).filter((i) => i.status === 'unpaid' || i.status === 'partial'), [data]);
  const filtered = all.filter((i) => (statusFilter === 'all' || i.status === statusFilter) && (curFilter === 'all' || invCurrency(i) === curFilter));
  const counts = { all: all.length, unpaid: all.filter((i) => i.status === 'unpaid').length, partial: all.filter((i) => i.status === 'partial').length };
  const owedBy = all.reduce((acc, i) => { acc[invCurrency(i)] += Number(i.balance?.outstanding || 0); return acc; }, { USD: 0, SLSH: 0 });

  const select = (id) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('invoice', String(id)); else next.delete('invoice');
    setSearchParams(next, { replace: true });
  };

  // Lock page scroll while the mobile bottom sheet is open.
  useEffect(() => {
    if (!selectedId || !window.matchMedia('(max-width: 900px)').matches) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [selectedId]);

  return (
    <div>
      <PageHeader icon={Wallet} title={t('nav.billing')} subtitle={t('fr.bill.subtitle')} />

      <div className="fin-stats">
        <StatCard label={t('fr.bill.outstanding')} value={error ? '—' : counts.all} icon={Receipt} />
        <StatCard label={t('fr.bill.unpaid')} value={error ? '—' : counts.unpaid} icon={Receipt} accent="var(--danger)" />
        <StatCard label={t('fr.bill.partial')} value={error ? '—' : counts.partial} icon={Receipt} accent="var(--warning)" />
        <StatCard
          label={t('fr.bill.owedTotal')}
          value={error || isLoading ? '—' : <span style={{ fontSize: owedBy.USD > 0.004 && owedBy.SLSH > 0.4 ? '17px' : undefined }}>{fmtByCurrency(owedBy)}</span>}
          icon={Coins}
          accent="var(--accent)"
        />
      </div>

      <div className={`fin-bill-grid${selectedId ? ' has-selection' : ''}`}>
        <section className="fin-bill-list" aria-label={t('fr.bill.outstanding')}>
          <div className="fin-bill-tools">
            <div className="fin-search">
              <Search size={15} />
              <input className="fin-input" type="search" value={q} onChange={(e) => { setQ(e.target.value); setLimit(LIST_CHUNK); }} placeholder={t('fr.bill.search')} aria-label={t('fr.bill.search')} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
              <div className="fin-chip-row" role="group" aria-label={t('common.status')}>
                {['all', 'unpaid', 'partial'].map((k) => (
                  <button key={k} type="button" className="fin-chip" aria-pressed={statusFilter === k} onClick={() => { setStatusFilter(k); setLimit(LIST_CHUNK); }}>
                    {t(`fr.bill.${k}`)} <span className="fin-chip-count">{counts[k]}</span>
                  </button>
                ))}
              </div>
              <div className="fin-chip-row" role="group" aria-label={t('fr.pay.currency')}>
                {['all', 'USD', 'SLSH'].map((k) => (
                  <button key={k} type="button" className="fin-chip" aria-pressed={curFilter === k} onClick={() => { setCurFilter(k); setLimit(LIST_CHUNK); }}>
                    {k === 'all' ? t('fr.bill.anyCurrency') : k}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {isLoading && <LoadingState label={t('common.loading')} />}
          {error && <div className="fin-alert"><p style={{ margin: 0 }}>{error.message}</p><button className="fin-linkbtn" onClick={() => refetch()}>{t('fr.zaad.tryAgain')}</button></div>}
          {!isLoading && !error && filtered.length === 0 && (
            <div className="fin-panel-card fin-panel-empty">{all.length === 0 && !debouncedQ ? t('fr.bill.none') : t('fr.bill.noMatch')}</div>
          )}
          <div className="fin-bill-cards">
            {filtered.slice(0, limit).map((inv) => (
              <InvoiceCard key={inv.id} inv={inv} selected={selectedId === inv.id} onSelect={() => select(inv.id)} />
            ))}
          </div>
          {filtered.length > limit && (
            <div style={{ textAlign: 'center', marginTop: '12px' }}>
              <div className="fin-note" style={{ marginBottom: '6px' }}>{t('fr.bill.showing', undefined, { n: limit, total: filtered.length })}</div>
              <Button variant="secondary" onClick={() => setLimit((l) => l + LIST_CHUNK)}>{t('fr.bill.showMore')}</Button>
            </div>
          )}
        </section>

        <div className="fin-sheet-backdrop" onClick={() => select(null)} aria-hidden="true" />
        <aside className="fin-panel" aria-label={t('fr.pay.title')}>
          {selectedId ? (
            <PaymentPanel key={selectedId} invoiceId={selectedId} onRecorded={refetch} onClose={() => select(null)} />
          ) : (
            <div className="fin-panel-card fin-panel-empty">
              <Search size={22} style={{ display: 'block', margin: '0 auto 8px', opacity: 0.6 }} />
              {t('fr.bill.pickInvoice')}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function InvoiceCard({ inv, selected, onSelect }) {
  const { t } = useI18n();
  const cur = invCurrency(inv);
  const owed = inv.balance ? Number(inv.balance.outstanding) : null;
  const sec = secondaryBlock(inv.balance, cur);
  const days = ageDays(inv.created_at);
  return (
    <button type="button" className="fin-inv-card" aria-current={selected} onClick={onSelect}>
      <div className="fin-inv-row">
        <div style={{ minWidth: 0 }}>
          <span className="fin-inv-name">{inv.customer_name}</span>
          <span className="fin-inv-cno">{inv.customer_number}</span>
          {inv.customer_path && <div className="fin-inv-path" title={inv.customer_path}>{inv.customer_path}</div>}
        </div>
        <StatusBadge status={inv.status} map={STATUS_MAP} />
      </div>
      <div className="fin-inv-row" style={{ alignItems: 'flex-end' }}>
        <div className="fin-inv-meta">
          <span><Receipt size={12} style={{ verticalAlign: '-2px' }} /> {inv.invoice_number}</span>
          <span className={days > 30 ? 'fin-age-old' : undefined}><Clock size={12} style={{ verticalAlign: '-2px' }} /> {ageLabel(t, days)}</span>
          <span className="fin-pill">{cur}</span>
        </div>
        <div className="fin-inv-amt">
          <div className="fin-note" style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.04em' }}>{t('fr.bill.owed')}</div>
          <div className="fin-inv-owed">{fmtMoney(owed ?? inv.invoice_total, cur)}</div>
          {sec && owed !== null && <div className="fin-inv-sec">≈ {fmtMoney(sec.outstanding, otherCurrency(cur))}</div>}
        </div>
      </div>
    </button>
  );
}

// Invoices where a ZAAD push ended with an UNKNOWN / reconciliation outcome in
// this browser session. The ZAAD send button stays disabled for them until the
// page is reloaded, so a cashier cannot double-charge a customer by retrying.
const zaadBlocked = new Set();

const METHODS = [
  { key: 'cash', icon: Banknote },
  { key: 'zaad', icon: Smartphone },
  { key: 'edahab', icon: Smartphone },
  { key: 'slsh', icon: Coins },
];

function PaymentPanel({ invoiceId, onRecorded, onClose }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, isLoading, error: loadError, refetch } = useInvoice(invoiceId);
  const recordPayment = useRecordPayment();
  const requestZaad = useRequestZaadPayment();
  const invoice = data?.data;
  const cur = invCurrency(invoice);

  const [method, setMethod] = useState('cash');
  const [zaadManual, setZaadManual] = useState(false);
  const [currency, setCurrency] = useState('USD');
  // Two amounts recorded together in one action (unchanged behaviour): the
  // money actually received (Payment method applies to it) and an optional
  // part recorded as debt (its own payment row, method='debt', which the
  // server's auto-debt tracking reflects on the Debts page).
  const [amountPaid, setAmountPaid] = useState('');
  const [amountDebt, setAmountDebt] = useState('');
  const [phone, setPhone] = useState('');
  const [reference, setReference] = useState('');
  const [formError, setFormError] = useState('');
  const [phase, setPhase] = useState('form'); // form | waiting | success | failed
  const [zaadResult, setZaadResult] = useState(null);
  const [zaadFail, setZaadFail] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef(null);
  const initRef = useRef(false);

  useEffect(() => {
    if (!invoice || initRef.current) return;
    initRef.current = true;
    setCurrency(invCurrency(invoice));
    setPhone(invoice.customer_phone || invoice.customer_whatsapp || invoice.customer_alternate_phone || '');
  }, [invoice]);
  useEffect(() => () => clearInterval(timerRef.current), []);

  if (isLoading) return <div className="fin-panel-card"><LoadingState label={t('portal.invoice.loading')} /></div>;
  if (loadError || !invoice) {
    return (
      <div className="fin-panel-card fin-panel-body">
        <div className="fin-alert"><p style={{ margin: 0 }}>{loadError?.message || t('common.somethingWrong')}</p></div>
        <Button variant="secondary" onClick={onClose}>{t('fr.pay.back')}</Button>
      </div>
    );
  }

  const balance = invoice.balance || {};
  const sec = secondaryBlock(balance, cur);
  const other = otherCurrency(cur);
  const rate = rateText(balance);
  const net = Number(balance.netTotal || 0);
  const grossSec = sec && net > 0 ? sec.netTotal * (parseFloat(invoice.invoice_total) / net) : null;
  const isZaadPush = method === 'zaad' && !zaadManual;
  const blocked = zaadBlocked.has(invoiceId);
  const phones = [...new Set([invoice.customer_phone, invoice.customer_whatsapp, invoice.customer_alternate_phone].filter(Boolean))];
  const paidNum = parseFloat(amountPaid) || 0;
  const debtNum = parseFloat(amountDebt) || 0;
  const equivCur = currency !== cur ? cur : other;
  const equiv = paidNum > 0 ? convert(paidNum, currency, equivCur, balance) : null;

  function chooseMethod(m) {
    setMethod(m);
    setFormError('');
    if (m !== 'zaad') setZaadManual(false);
    if (m === 'slsh') setCurrency('SLSH');
  }

  function fullAmount() {
    const owed = Number(balance.outstanding || 0);
    const v = convert(owed, cur, currency, balance);
    if (v === null) { setFormError(t('fr.zaad.err.noRate')); return; }
    setAmountPaid(currency === 'SLSH' ? String(Math.round(v)) : (Math.round(v * 100) / 100).toFixed(2));
    setAmountDebt('');
  }

  function afterSuccess() {
    refetch();
    onRecorded?.();
  }

  async function handleManual(e) {
    e.preventDefault();
    setFormError('');
    if (paidNum <= 0 && debtNum <= 0) { setFormError(t('fr.pay.enterAmount')); return; }
    if (paidNum < 0 || debtNum < 0) { setFormError(t('fin.amounts_cannot_be_negative')); return; }
    if (method === 'zaad' && paidNum > 0 && !reference.trim()) { setFormError(t('fr.pay.referenceRequired')); return; }
    try {
      // Two rows, one user action — the server still enforces each one
      // individually (row-locked, overpayment-blocked).
      if (paidNum > 0) {
        await recordPayment.mutateAsync({
          invoice_id: invoiceId, amount: paidNum, currency, method,
          ...(method === 'zaad' ? { reference_code: reference.trim() } : {}),
        });
      }
      if (debtNum > 0) await recordPayment.mutateAsync({ invoice_id: invoiceId, amount: debtNum, currency, method: 'debt' });
      toast.success(paidNum > 0 && debtNum > 0 ? t('fr.pay.recordedWithDebt') : debtNum > 0 ? t('fr.pay.recordedDebt') : t('fr.pay.recorded'));
      setAmountPaid('');
      setAmountDebt('');
      setReference('');
      afterSuccess();
    } catch (err) {
      setFormError(err.message || t('common.somethingWrong'));
      refetch(); // one of the two calls may already have succeeded
    }
  }

  async function handleZaad(e) {
    e.preventDefault();
    setFormError('');
    if (blocked) return;
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7) { setFormError(t('fr.zaad.phoneRequired')); return; }
    if (paidNum <= 0) { setFormError(t('fr.pay.enterAmount')); return; }
    setPhase('waiting');
    setElapsed(0);
    const started = Date.now();
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    try {
      const res = await requestZaad.mutateAsync({ invoice_id: invoiceId, phone: phone.trim(), amount: paidNum, currency });
      setZaadResult(res.data);
      setPhase('success');
      setAmountPaid('');
      afterSuccess();
    } catch (err) {
      const info = zaadErrorInfo(t, err);
      if (info.critical) zaadBlocked.add(invoiceId);
      setZaadFail(info);
      setPhase('failed');
      refetch();
    } finally {
      clearInterval(timerRef.current);
    }
  }

  const header = (
    <div className="fin-panel-head">
      <div style={{ minWidth: 0 }}>
        <div className="fin-note" style={{ fontWeight: 700 }}>{invoice.invoice_number} · {invoice.customer_number}</div>
        <h3>{invoice.customer_name}</h3>
        {invoice.customer_path && <div className="fin-note">{invoice.customer_path}</div>}
      </div>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
        <Button variant="secondary" icon={ExternalLink} onClick={() => navigate(`/financial/invoices/${invoiceId}`)} style={{ padding: '7px 10px', fontSize: '12px' }}>
          {t('fr.pay.openInvoice')}
        </Button>
        <button type="button" className="fin-panel-close" onClick={onClose} aria-label={t('fr.pay.back')}
          style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '7px', cursor: 'pointer', color: 'var(--text-muted)' }}>
          <X size={16} />
        </button>
      </div>
    </div>
  );

  const summary = (
    <>
      <div className="fin-sum">
        <div><div className="k">{t('fr.pay.total')}</div><div className="v">{fmtMoney(invoice.invoice_total, cur)}</div>{grossSec !== null && <div className="s">≈ {fmtMoney(grossSec, other)}</div>}</div>
        <div><div className="k">{t('fr.pay.paid')}</div><div className="v" style={{ color: 'var(--success)' }}>{fmtMoney(balance.paid, cur)}</div>{sec && <div className="s">≈ {fmtMoney(sec.paid, other)}</div>}</div>
        <div className={Number(balance.outstanding) > 0 ? 'owed' : undefined}><div className="k">{t('fr.pay.owed')}</div><div className="v">{fmtMoney(balance.outstanding, cur)}</div>{sec && <div className="s">≈ {fmtMoney(sec.outstanding, other)}</div>}</div>
      </div>
      <div className="fin-rate">{rate ? t('fr.pay.rate', undefined, { rate }) : t('fr.pay.noRate')}</div>
    </>
  );

  const recent = (
    <div>
      <span className="fin-section-label">{t('fr.pay.recent')}</span>
      {(invoice.payments || []).length === 0 && <div className="fin-note">{t('fr.pay.noneYet')}</div>}
      <div className="fin-paylist">
        {[...(invoice.payments || [])].reverse().map((p) => (
          <div key={p.id}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700 }} className={p.status === 'reversed' ? 'fin-struck' : undefined}>
                {fmtMoney(p.amount, p.currency)} · {p.channel === 'portal_zaad' ? t('fr.portalZaad') : methodLabel(t, p.method)}
              </div>
              <div className="ref">{fmtDateTime(p.created_at)}{p.reference_code ? ` · ${p.reference_code}` : ''} · {recordedByLabel(t, p)}</div>
            </div>
            <StatusBadge status={p.status} map={PAYMENT_STATUS_MAP} />
          </div>
        ))}
      </div>
    </div>
  );

  let body;
  if (phase === 'waiting') {
    body = (
      <div className="fin-wait" role="status" aria-live="polite">
        <div className="fin-spinner" />
        <div className="fin-wait-title">{t('fr.zaad.waiting')}</div>
        <div className="fin-note">{fmtMoney(paidNum, currency)} → {phone}</div>
        <div className="fin-progress"><div style={{ width: `${Math.min(100, (elapsed / 90) * 100)}%` }} /></div>
        <div className="fin-note">{t('fr.zaad.elapsed', undefined, { s: elapsed })}</div>
        <div className="fin-warn">{t('fr.zaad.waitingSub')}</div>
      </div>
    );
  } else if (phase === 'success' && zaadResult) {
    body = (
      <div className="fin-receipt" role="status">
        <h4><CheckCircle2 size={18} /> {t('fr.zaad.successTitle')}</h4>
        <dl>
          <dt>{t('fr.zaad.txId')}</dt><dd>{zaadResult.reference_code || '—'}</dd>
          <dt>{t('fr.zaad.amount')}</dt><dd>{fmtMoney(zaadResult.amount, zaadResult.currency)}</dd>
          <dt>{t('fr.zaad.newStatus')}</dt><dd><StatusBadge status={zaadResult.invoice_status} map={STATUS_MAP} /></dd>
          <dt>{t('fr.zaad.remaining')}</dt><dd>{fmtMoney(zaadResult.outstanding, zaadResult.outstanding_currency || cur)}</dd>
        </dl>
        <div style={{ display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap' }}>
          <Button onClick={() => { setPhase('form'); setZaadResult(null); }}>{t('fr.zaad.done')}</Button>
          <Button variant="secondary" icon={Receipt} onClick={() => navigate(`/financial/invoices/${invoiceId}`)}>{t('fr.zaad.printReceipt')}</Button>
        </div>
      </div>
    );
  } else if (phase === 'failed' && zaadFail) {
    body = (
      <div className={`fin-alert${zaadFail.critical ? '' : ' soft'}`} role="alert">
        <h4><AlertTriangle size={18} /> {zaadFail.critical ? t('fr.zaad.criticalTitle') : t('fr.zaad.failedTitle')}</h4>
        <p>{zaadFail.message}</p>
        {zaadFail.detail && <div className="detail">{zaadFail.detail}</div>}
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
          {!zaadFail.critical && zaadFail.retry && <Button onClick={() => { setPhase('form'); setZaadFail(null); }}>{t('fr.zaad.tryAgain')}</Button>}
          <Button variant="secondary" onClick={() => { setPhase('form'); setZaadFail(null); }}>{t('fr.zaad.close')}</Button>
        </div>
      </div>
    );
  } else if (invoice.status === 'paid') {
    body = <div className="fin-receipt"><h4 style={{ margin: 0 }}><CheckCircle2 size={18} /> {t('fr.pay.fullyPaid')}</h4></div>;
  } else {
    body = (
      <RoleGate roles={['admin', 'cashier']} fallback={<div className="fin-note">{t('fr.pay.viewOnly')}</div>}>
        <form onSubmit={isZaadPush ? handleZaad : handleManual} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div className="fin-field">
            <span>{t('fr.pay.method')}</span>
            <div className="fin-seg" role="group" aria-label={t('fr.pay.method')}>
              {METHODS.map(({ key, icon: Icon }) => (
                <button key={key} type="button" aria-pressed={method === key} onClick={() => chooseMethod(key)}>
                  <Icon size={18} /> {methodLabel(t, key)}
                </button>
              ))}
            </div>
          </div>

          <div className="fin-field">
            <span>{t('fr.pay.currency')}</span>
            <div className="fin-seg fin-seg-2" role="group" aria-label={t('fr.pay.currency')}>
              {['USD', 'SLSH'].map((c) => (
                <button key={c} type="button" aria-pressed={currency === c} onClick={() => { setCurrency(c); setAmountPaid(''); }}>{c}</button>
              ))}
            </div>
          </div>

          <label className="fin-field">
            <span>{isZaadPush ? t('fr.pay.zaadAmount', undefined, { currency }) : t('fr.pay.amount', undefined, { currency })}</span>
            <div className="fin-amount-row">
              <input className="fin-input" type="number" inputMode="decimal" min="0" step={currency === 'SLSH' ? '1' : '0.01'} value={amountPaid}
                onChange={(e) => setAmountPaid(e.target.value)} placeholder={currency === 'SLSH' ? '0' : '0.00'} />
              <Button type="button" variant="secondary" onClick={fullAmount}>{t('fr.pay.full')}</Button>
            </div>
            {equiv !== null && <span className="fin-hint">{t('fr.pay.equiv', undefined, { amount: fmtMoney(equiv, equivCur) })}</span>}
          </label>

          {isZaadPush ? (
            <div className="fin-zaad-box">
              <label className="fin-field">
                <span>{t('fr.zaad.phone')}</span>
                <input className="fin-input" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="063xxxxxxx" />
                <span className="fin-hint">{t('fr.zaad.phoneHint')}</span>
              </label>
              {phones.length > 1 && (
                <div className="fin-phone-chips">
                  {phones.map((p) => <button key={p} type="button" onClick={() => setPhone(p)}>{p}</button>)}
                </div>
              )}
              {blocked && <div className="fin-warn">{t('fr.zaad.err.unknown')}</div>}
              {formError && <span className="fin-err" role="alert">{formError}</span>}
              <Button type="submit" icon={Smartphone} className="fin-primary-btn" disabled={blocked || requestZaad.isPending}>{t('fr.zaad.send')}</Button>
              <button type="button" className="fin-linkbtn" onClick={() => { setZaadManual(true); setFormError(''); }}>{t('fr.zaad.manualLink')}</button>
            </div>
          ) : (
            <>
              {method === 'zaad' && (
                <div className="fin-zaad-box">
                  <div className="fin-note">{t('fr.zaad.manualMode')}</div>
                  <label className="fin-field">
                    <span>{t('fr.pay.reference')}</span>
                    <input className="fin-input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={50} required={paidNum > 0} />
                  </label>
                  <button type="button" className="fin-linkbtn" onClick={() => { setZaadManual(false); setFormError(''); }}>{t('fr.zaad.useRequest')}</button>
                </div>
              )}
              <label className="fin-field">
                <span>{t('fr.pay.debtPortion', undefined, { currency })}</span>
                <input className="fin-input" type="number" inputMode="decimal" min="0" step={currency === 'SLSH' ? '1' : '0.01'} value={amountDebt}
                  onChange={(e) => setAmountDebt(e.target.value)} placeholder={currency === 'SLSH' ? '0' : '0.00'} />
                <span className="fin-hint">{t('fr.pay.debtHint')}</span>
              </label>
              {(paidNum > 0 || debtNum > 0) && (
                <div className="fin-note">{t('fr.pay.totalAction', undefined, { amount: fmtMoney(paidNum + debtNum, currency) })}</div>
              )}
              {formError && <span className="fin-err" role="alert">{formError}</span>}
              <Button type="submit" className="fin-primary-btn" disabled={recordPayment.isPending}>
                {recordPayment.isPending ? t('fr.pay.recording') : t('fr.pay.record')}
              </Button>
            </>
          )}
        </form>
      </RoleGate>
    );
  }

  return (
    <div className="fin-panel-card">
      {header}
      <div className="fin-panel-body">
        {summary}
        {body}
        {recent}
      </div>
    </div>
  );
}
