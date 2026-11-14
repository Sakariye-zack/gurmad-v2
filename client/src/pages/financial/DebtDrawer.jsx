import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  X, Banknote, Smartphone, Coins, CheckCircle2, AlertTriangle, Receipt, MessageSquarePlus, Pencil, Ban, CheckCheck, ExternalLink,
} from 'lucide-react';
import { Button, LoadingState, ErrorState, StatusBadge, useToast } from '../../components/ui/index.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useDebt, useCollectDebt, useRequestZaadPayment } from '../../hooks/useFinancial.js';
import { fmtMoney } from '../../lib/money.js';
import {
  PAYMENT_STATUS_MAP, convert, exceedsOwed, methodLabel, recordedByLabel, fmtDateTime, fmtDate, zaadErrorInfo,
} from './financeUtils.js';
import { useZaadStore, getZaadEntry, setZaadEntry } from './zaadPendingStore.js';
import { AgeChip, StateChip, SourceChip, SuspensionChip, PhoneLinks, pathText, isOpen, COLLECT_ROLES } from './debtsUi.jsx';

const newKey = () => (window.crypto && typeof window.crypto.randomUUID === 'function'
  ? window.crypto.randomUUID()
  : `k${Date.now()}${Math.random().toString(36).slice(2, 12)}`);

const METHODS = [
  { key: 'cash', icon: Banknote },
  { key: 'zaad', icon: Smartphone },
  { key: 'edahab', icon: Smartphone },
  { key: 'slsh', icon: Coins },
];

// Side drawer (bottom sheet on a phone) for one debt: summary, Collect
// payment, payment history and follow-ups. Every figure comes from
// GET /v2/debts/:id; the server sizes, validates and records every payment
// (POST /v2/debts/:id/collect, or POST /v2/payments/zaad-request with
// debt_id for a ZAAD push on an invoice debt — same guards as Billing).
export default function DebtDrawer({ debtId, onClose, onAction }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const role = (user?.role || '').toLowerCase();
  const { data, isLoading, error, refetch } = useDebt(debtId);
  const debt = data?.data;
  useZaadStore();
  const waiting = debt?.invoice_id ? getZaadEntry(debt.invoice_id)?.phase === 'waiting' : false;

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !waiting) onClose(); };
    document.addEventListener('keydown', esc);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', esc); document.body.style.overflow = prev; };
  }, [onClose, waiting]);

  const close = () => { if (!waiting) onClose(); };
  return (
    <>
      <div className="dv-drawer-backdrop" onClick={close} aria-hidden="true" />
      <aside className="dv-drawer" role="dialog" aria-modal="true" aria-label={t('dv.drawer.title', undefined, { id: debtId })}>
        <div className="dv-drawer-head">
          <div style={{ minWidth: 0 }}>
            <div className="fin-note" style={{ fontWeight: 700 }}>{t('dv.drawer.title', undefined, { id: debtId })}{debt?.customer_number ? ` · ${debt.customer_number}` : ''}</div>
            <h3>{debt ? <Link className="dv-cust-link" to={`/customers/${debt.customer_id}`}>{debt.customer_name}</Link> : '…'}</h3>
            {debt && pathText(debt) && <div className="fin-note">{pathText(debt)}</div>}
          </div>
          <button type="button" className="dv-x" onClick={close} disabled={waiting} aria-label={t('dv.drawer.close')}><X size={16} /></button>
        </div>
        <div className="dv-drawer-body">
          {isLoading && <LoadingState label={t('common.loading')} />}
          {error && <ErrorState message={error.message} onRetry={refetch} />}
          {debt && <DrawerBody debt={debt} role={role} userId={user?.id} onAction={onAction} refetch={refetch} />}
        </div>
      </aside>
    </>
  );
}

function DrawerBody({ debt, role, userId, onAction, refetch }) {
  const { t } = useI18n();
  const cur = debt.currency;
  const auto = debt.source === 'auto_invoice';
  const canCollect = COLLECT_ROLES.includes(role);
  const invLabel = debt.invoice_number || (debt.invoice_id ? `#${debt.invoice_id}` : '');
  return (
    <>
      <div className="dv-chiprow">
        <SourceChip row={debt} />
        <StateChip state={debt.state} />
        <AgeChip days={debt.age_days} bucket={debt.age_bucket} />
        <SuspensionChip s={debt.suspension} />
        {debt.invoice_voided && <span className="cl-chip">{t('dv.invoiceVoided')}</span>}
      </div>
      <PhoneLinks row={debt} />

      <div className="fin-sum">
        <div><div className="k">{t('dv.sum.amount')}</div><div className="v">{fmtMoney(debt.amount, cur)}</div><div className="s">{cur}</div></div>
        <div>
          <div className="k">{auto ? t('dv.sum.autoPaid') : t('dv.sum.paid')}</div>
          {auto
            ? <div className="v" style={{ fontSize: '14px' }}><Link className="dv-inv" to={`/financial/invoices/${debt.invoice_id}`}>{invLabel}</Link></div>
            : <div className="v" style={{ color: 'var(--success)' }}>{debt.paid_amount === null ? '—' : fmtMoney(debt.paid_amount, cur)}</div>}
          {auto && debt.collect?.invoice_outstanding !== undefined && debt.collect?.invoice_outstanding !== null && (
            <div className="s">{fmtMoney(debt.collect.invoice_outstanding, debt.collect.currency)}</div>
          )}
        </div>
        <div className={debt.remaining > 0 ? 'owed' : undefined}><div className="k">{t('dv.sum.remaining')}</div><div className="v">{fmtMoney(debt.remaining, cur)}</div></div>
      </div>

      <div className="dv-meta">
        {debt.description && <div style={{ color: 'var(--text)', fontSize: '13px' }}>{debt.description}</div>}
        <div>{t('dv.created', undefined, { date: fmtDate(debt.created_at), who: debt.created_by_name || '—' })}</div>
        {debt.state === 'written_off' && debt.written_off_reason && <div>{t('dv.writtenOff', undefined, { date: fmtDate(debt.written_off_at), reason: debt.written_off_reason })}</div>}
        {debt.promise_date && <div>{debt.promise_amount ? t('dv.promiseOn', undefined, { amount: fmtMoney(debt.promise_amount, debt.promise_currency || cur), date: debt.promise_date }) : t('dv.promiseDate', undefined, { date: debt.promise_date })}</div>}
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button type="button" className="dv-btn" onClick={() => onAction('followup', debt)}><MessageSquarePlus size={14} /> {t('dv.act.followup')}</button>
        {(role === 'admin' || (['cashier', 'gudoomiye'].includes(role) && debt.created_by === userId)) && (
          <button type="button" className="dv-btn" onClick={() => onAction('edit', debt)}><Pencil size={14} /> {t('dv.act.edit')}</button>
        )}
        {role === 'admin' && isOpen(debt) && !auto && (
          <button type="button" className="dv-btn" onClick={() => onAction('writeoff', debt)}><Ban size={14} /> {t('dv.act.writeOff')}</button>
        )}
        {debt.collect_target === 'manual_invoice' && isOpen(debt) && canCollect && (
          <button type="button" className="dv-btn" onClick={() => onAction('settle', debt)}><CheckCheck size={14} /> {t('dv.act.settle')}</button>
        )}
        {debt.invoice_id && (
          <Link className="dv-btn" to={`/financial/invoices/${debt.invoice_id}`}><ExternalLink size={14} /> {t('dv.act.openInvoice')}</Link>
        )}
      </div>

      {role === 'admin' && isOpen(debt) && auto && <div className="fin-note">{t('dv.wo.auto', undefined, { inv: invLabel })}</div>}

      <section>
        <span className="fin-section-label">{t('dv.c.title')}</span>
        {!isOpen(debt) ? <div className="fin-note">{t('dv.c.closed')}</div>
          : !canCollect ? <div className="fin-note">{t('dv.c.viewOnly')}</div>
            : debt.collect_target === 'manual_invoice' ? <div className="fin-warn">{t('dv.c.manualInvoice', undefined, { inv: invLabel })}</div>
              : <CollectForm key={debt.id} debt={debt} onDone={refetch} />}
      </section>

      <section>
        <span className="fin-section-label">{t('dv.history')}</span>
        {debt.invoice_id && <div className="fin-note" style={{ marginBottom: '6px' }}>{t('dv.history.invoiceNote', undefined, { inv: invLabel })}</div>}
        {debt.payments.length === 0 && <div className="fin-note">{t('dv.history.none')}</div>}
        <div className="fin-paylist">
          {[...debt.payments].reverse().map((p) => (
            <div key={p.id}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700 }} className={p.status === 'reversed' ? 'fin-struck' : undefined}>
                  {fmtMoney(p.amount, p.currency)} · {p.channel === 'portal_zaad' ? t('fr.portalZaad') : methodLabel(t, p.method)}
                  {p.via_this_debt && debt.invoice_id ? <span className="cl-chip info" style={{ marginLeft: '6px' }}>{t('dv.history.viaDebt')}</span> : null}
                  {p.converted_by_payment_id ? <span className="cl-chip" style={{ marginLeft: '6px' }}>{t('dv.conv.converted', undefined, { id: p.converted_by_payment_id })}</span> : null}
                  {p.leftover_of_payment_id ? <span className="cl-chip" style={{ marginLeft: '6px' }}>{t('dv.conv.leftover')}</span> : null}
                </div>
                <div className="ref">{fmtDateTime(p.created_at)}{p.reference_code ? ` · ${p.reference_code}` : ''} · {recordedByLabel(t, p)}</div>
                {p.status === 'reversed' && p.reversed_reason && <div className="ref">{p.reversed_reason}</div>}
              </div>
              <StatusBadge status={p.status} map={PAYMENT_STATUS_MAP} />
            </div>
          ))}
        </div>
      </section>

      <section>
        <span className="fin-section-label">{t('dv.followups')}</span>
        {debt.followups.length === 0 && <div className="fin-note">{t('dv.followups.none')}</div>}
        <div className="dv-fu-list">
          {debt.followups.map((f) => (
            <div key={f.id} className="dv-fu">
              <div className="top"><span>{t(`dv.fu.kind.${f.kind}`)} · {f.created_by_name || '—'}</span><span className="when">{fmtDateTime(f.created_at)}</span></div>
              {f.note && <p>{f.note}</p>}
              {f.promise_date && <p className="fin-note">{f.promise_amount ? t('dv.promiseOn', undefined, { amount: fmtMoney(f.promise_amount, f.promise_currency || cur), date: f.promise_date }) : t('dv.promiseDate', undefined, { date: f.promise_date })}</p>}
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function CollectForm({ debt, onDone }) {
  const { t } = useI18n();
  const toast = useToast();
  const collectM = useCollectDebt();
  const requestZaad = useRequestZaadPayment();
  const info = debt.collect || {};
  const target = info.target;
  const tcur = info.currency || debt.currency; // the currency the server sizes in
  const bal = { outstanding: info.max, rate: info.rate };
  const invoiceId = debt.invoice_id;
  const zaad = invoiceId ? getZaadEntry(invoiceId) : null;
  const [method, setMethod] = useState('cash');
  const [zaadManual, setZaadManual] = useState(target !== 'invoice');
  const [currency, setCurrency] = useState(tcur);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const phones = [...new Set([debt.phone, debt.whatsapp, debt.alternate_phone].filter(Boolean))];
  const [phone, setPhone] = useState(phones[0] || '');
  const [formError, setFormError] = useState('');
  const [done, setDone] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  // A fresh Idempotency-Key per opened form (and after every success): a
  // double tap or a network retry of the same submission can never record
  // the same cash twice — the server replays the first result.
  const idemKey = useRef(newKey());

  useEffect(() => {
    if (zaad?.phase !== 'waiting') return undefined;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [zaad?.phase]);

  const amt = parseFloat(amount) || 0;
  const isPush = target === 'invoice' && method === 'zaad' && !zaadManual;
  const over = amt > 0 && exceedsOwed(amt, currency, bal, tcur);
  const equivCur = currency !== tcur ? tcur : null;
  const equiv = amt > 0 && equivCur ? convert(amt, currency, equivCur, bal) : null;
  const blockedUntil = info.zaad_blocked_until && new Date(info.zaad_blocked_until) > new Date() ? new Date(info.zaad_blocked_until) : null;
  const localCritical = zaad?.phase === 'failed' && zaad.fail?.critical;
  const pushDisabledReason = blockedUntil ? t('fr.zaad.blocked', undefined, { time: blockedUntil.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
    : info.zaad_in_progress ? t('fr.zaad.inProgressFlag') : localCritical ? t('fr.zaad.err.unconfirmed') : null;

  function chooseMethod(m) {
    setMethod(m); setFormError(''); setAmount('');
    if (m !== 'zaad') setZaadManual(target !== 'invoice');
    if (m === 'slsh') setCurrency('SLSH');
  }
  function chooseCurrency(c) { if (method === 'slsh') return; setCurrency(c); setAmount(''); }
  function full() {
    const v = convert(Number(info.max || 0), tcur, currency, bal);
    if (v === null) { setFormError(t('fr.zaad.err.noRate')); return; }
    setAmount(currency === 'SLSH' ? String(Math.round(v)) : (Math.round(v * 100) / 100).toFixed(2));
  }

  async function submitManual(e) {
    e.preventDefault();
    setFormError('');
    if (amt <= 0) { setFormError(t('fr.pay.enterAmount')); return; }
    if ((method === 'zaad' || method === 'edahab') && !reference.trim()) { setFormError(t('fr.pay.referenceRequired')); return; }
    if (over) { setFormError(t('fr.pay.overOwedBlock')); return; }
    try {
      const res = await collectM.mutateAsync({ id: debt.id, idempotencyKey: idemKey.current, amount: amt, currency, method, ...(method === 'zaad' || method === 'edahab' ? { reference_code: reference.trim() } : {}) });
      idemKey.current = newKey();
      const d = res.data?.debt || {};
      setDone({ amount: amt, currency, status: d.status, remaining: d.remaining, remainingCur: d.currency || tcur, ref: reference.trim() });
      setAmount(''); setReference('');
      toast.success(t('dv.c.recorded'));
      onDone?.();
    } catch (err) {
      setFormError(err.message || t('common.somethingWrong'));
    }
  }

  function submitPush(e) {
    e.preventDefault();
    setFormError('');
    if (inFlight.current || pushDisabledReason || getZaadEntry(invoiceId)?.phase === 'waiting') return;
    if (phone.replace(/\D/g, '').length < 7) { setFormError(t('fr.zaad.phoneRequired')); return; }
    if (amt <= 0) { setFormError(t('fr.pay.enterAmount')); return; }
    if (over) { setFormError(t('fr.pay.overOwedBlock')); return; }
    inFlight.current = true;
    const req = { amount: amt, currency, phone: phone.trim() };
    setZaadEntry(invoiceId, { phase: 'waiting', startedAt: Date.now(), ...req });
    // Shared store keyed by invoice: Billing sees the same waiting push.
    requestZaad.mutateAsync({ invoice_id: invoiceId, debt_id: debt.id, phone: req.phone, amount: req.amount, currency: req.currency })
      .then((res) => { setZaadEntry(invoiceId, { phase: 'success', ...req, result: res.data }); setAmount(''); })
      .catch((err) => { setZaadEntry(invoiceId, { phase: 'failed', ...req, fail: zaadErrorInfo(t, err) }); })
      .finally(() => { inFlight.current = false; onDone?.(); });
  }

  if (zaad?.phase === 'waiting') {
    const elapsed = Math.max(0, Math.floor((now - zaad.startedAt) / 1000));
    return (
      <div className="fin-wait" role="status" aria-live="polite">
        <div className="fin-spinner" />
        <div className="fin-wait-title">{t('fr.zaad.waiting')}</div>
        <div className="fin-note">{fmtMoney(zaad.amount, zaad.currency)} → {zaad.phone}</div>
        <div className="fin-progress"><div style={{ width: `${Math.min(100, (elapsed / 90) * 100)}%` }} /></div>
        <div className="fin-note">{t('fr.zaad.elapsed', undefined, { s: elapsed })}</div>
        <div className="fin-warn">{t('fr.zaad.waitingSub')}</div>
      </div>
    );
  }
  if (zaad?.phase === 'success' && zaad.result) {
    const r = zaad.result;
    return (
      <div className="fin-receipt" role="status">
        <h4><CheckCircle2 size={18} /> {t('fr.zaad.successTitle')}</h4>
        <dl>
          <dt>{t('fr.zaad.txId')}</dt><dd>{r.reference_code || '—'}</dd>
          <dt>{t('fr.zaad.amount')}</dt><dd>{fmtMoney(r.amount, r.currency)}</dd>
          <dt>{t('dv.sum.remaining')}</dt><dd>{r.debt ? fmtMoney(r.debt.remaining, r.debt.currency) : '—'}</dd>
        </dl>
        <div style={{ marginTop: '12px' }}><Button onClick={() => setZaadEntry(invoiceId, null)}>{t('fr.zaad.done')}</Button></div>
      </div>
    );
  }
  if (zaad?.phase === 'failed' && zaad.fail && !zaad.dismissed) {
    const f = zaad.fail;
    return (
      <div className={`fin-alert${f.critical ? '' : ' soft'}`} role="alert">
        <h4><AlertTriangle size={18} /> {f.critical ? t('fr.zaad.criticalTitle') : t('fr.zaad.failedTitle')}</h4>
        <p>{f.message}</p>
        {f.detail && <div className="detail">{f.detail}</div>}
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' }}>
          {!f.critical && f.retry && <Button onClick={() => setZaadEntry(invoiceId, null)}>{t('fr.zaad.tryAgain')}</Button>}
          <Button variant="secondary" onClick={() => setZaadEntry(invoiceId, f.critical ? { ...zaad, dismissed: true } : null)}>{t('fr.zaad.close')}</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={isPush ? submitPush : submitManual} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div className="fin-note">{target === 'invoice' ? t('dv.c.invoiceHint', undefined, { inv: debt.invoice_number || `#${invoiceId}` }) : t('dv.c.standaloneHint')}</div>
      {done && (
        <div className="fin-receipt" role="status">
          <h4><Receipt size={16} /> {done.status === 'paid' ? t('dv.c.nowPaid') : t('dv.c.recorded')}</h4>
          <dl>
            <dt>{t('fr.zaad.amount')}</dt><dd>{fmtMoney(done.amount, done.currency)}</dd>
            {done.ref && <><dt>{t('fr.pay.reference')}</dt><dd>{done.ref}</dd></>}
            <dt>{t('dv.sum.remaining')}</dt><dd>{fmtMoney(done.remaining, done.remainingCur)}</dd>
          </dl>
        </div>
      )}
      <div className="fin-field">
        <span>{t('fr.pay.method')}</span>
        <div className="fin-seg" role="group" aria-label={t('fr.pay.method')}>
          {METHODS.map(({ key, icon: Icon }) => (
            <button key={key} type="button" aria-pressed={method === key} onClick={() => chooseMethod(key)}><Icon size={18} /> {methodLabel(t, key)}</button>
          ))}
        </div>
      </div>
      <div className="fin-field">
        <span>{t('fr.pay.currency')}</span>
        <div className="fin-seg fin-seg-2" role="group" aria-label={t('fr.pay.currency')}>
          {['USD', 'SLSH'].map((c) => (
            <button key={c} type="button" aria-pressed={currency === c} disabled={method === 'slsh' && c !== 'SLSH'}
              style={method === 'slsh' && c !== 'SLSH' ? { opacity: 0.45, cursor: 'not-allowed' } : undefined} onClick={() => chooseCurrency(c)}>{c}</button>
          ))}
        </div>
      </div>
      <label className="fin-field">
        <span>{isPush ? t('fr.pay.zaadAmount', undefined, { currency }) : t('fr.pay.amount', undefined, { currency })}</span>
        <div className="fin-amount-row">
          <input className="fin-input" type="number" inputMode="decimal" min="0" step={currency === 'SLSH' ? '1' : '0.01'} value={amount}
            onChange={(e) => setAmount(e.target.value)} placeholder={currency === 'SLSH' ? '0' : '0.00'} />
          <Button type="button" variant="secondary" onClick={full}>{t('fr.pay.full')}</Button>
        </div>
        <span className="fin-hint">{t('dv.c.max', undefined, { amount: fmtMoney(info.max, tcur) })}</span>
        {equiv !== null && <span className="fin-hint">{t('fr.pay.equiv', undefined, { amount: fmtMoney(equiv, equivCur) })}</span>}
        {over && <span className="fin-err">{t('fr.pay.overOwedBlock')}</span>}
      </label>

      {isPush ? (
        <div className="fin-zaad-box">
          <label className="fin-field">
            <span>{t('fr.zaad.phone')}</span>
            <input className="fin-input" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="063xxxxxxx" />
            <span className="fin-hint">{t('fr.zaad.phoneHint')}</span>
          </label>
          {phones.length > 1 && <div className="fin-phone-chips">{phones.map((p) => <button key={p} type="button" onClick={() => setPhone(p)}>{p}</button>)}</div>}
          {pushDisabledReason && <div className="fin-warn">{pushDisabledReason}</div>}
          {formError && <span className="fin-err" role="alert">{formError}</span>}
          <Button type="submit" icon={Smartphone} className="fin-primary-btn" disabled={!!pushDisabledReason || over || requestZaad.isPending}>{t('fr.zaad.send')}</Button>
          <button type="button" className="fin-linkbtn" onClick={() => { setZaadManual(true); setFormError(''); setAmount(''); }}>{t('fr.zaad.manualLink')}</button>
        </div>
      ) : (
        <>
          {method === 'zaad' && (
            <div className="fin-zaad-box">
              <div className="fin-note">{target === 'invoice' ? t('fr.zaad.manualMode') : t('dv.c.noZaadPush')}</div>
              <label className="fin-field">
                <span>{t('fr.pay.reference')}</span>
                <input className="fin-input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={50} required />
              </label>
              {target === 'invoice' && <button type="button" className="fin-linkbtn" onClick={() => { setZaadManual(false); setFormError(''); setAmount(''); }}>{t('fr.zaad.useRequest')}</button>}
            </div>
          )}
          {method === 'edahab' && (
            <div className="fin-zaad-box">
              <label className="fin-field">
                <span>{t('co2.pay.edahabRef')}</span>
                <input className="fin-input" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={50} required />
              </label>
            </div>
          )}
          {formError && <span className="fin-err" role="alert">{formError}</span>}
          <Button type="submit" className="fin-primary-btn" disabled={collectM.isPending || over}>
            {collectM.isPending ? t('fr.pay.recording') : t('fr.pay.record')}
          </Button>
        </>
      )}
    </form>
  );
}
