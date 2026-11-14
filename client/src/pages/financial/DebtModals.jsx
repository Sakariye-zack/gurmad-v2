import React, { useState } from 'react';
import { Copy, MessageCircle, Phone, MapPin, MessageSquare, MoreHorizontal } from 'lucide-react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { useAddFollowup, useWriteOffDebt, useUpdateDebt, useSettleDebt, useCreateDebt } from '../../hooks/useFinancial.js';
import { useCustomers } from '../../hooks/useCustomers.js';
import { fmtMoney } from '../../lib/money.js';
import { whatsappHref } from '../../lib/phone.js';
import { reminderText, copyText } from './debtsUi.jsx';

const KINDS = [
  { key: 'call', icon: Phone }, { key: 'visit', icon: MapPin }, { key: 'message', icon: MessageSquare }, { key: 'other', icon: MoreHorizontal },
];
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Quick "Log follow-up": kind, note, optional promise (date + amount in the
// debt's currency) and a copy-ready Somali + English reminder for WhatsApp.
// target = { customer_id, customer_name, phone, whatsapp, debt_id?, currency, amountText }
export function FollowupModal({ target, onClose }) {
  const { t } = useI18n();
  const toast = useToast();
  const add = useAddFollowup();
  const [kind, setKind] = useState('call');
  const [note, setNote] = useState('');
  const [promiseDate, setPromiseDate] = useState('');
  const [promiseAmount, setPromiseAmount] = useState('');
  const [error, setError] = useState('');
  const cur = target.currency || 'USD';
  const text = reminderText(t, target.customer_name, target.amountText || '');
  const wa = whatsappHref(target.whatsapp || target.phone);

  async function onCopy() {
    const ok = await copyText(text);
    if (ok) toast.success(t('dv.fu.copied')); else toast.error(t('common.somethingWrong'));
  }
  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!note.trim() && !promiseDate) { setError(t('dv.fu.needOne')); return; }
    try {
      await add.mutateAsync({
        customer_id: target.customer_id, ...(target.debt_id ? { debt_id: target.debt_id } : {}), kind, note: note.trim() || undefined,
        ...(promiseDate ? { promise_date: promiseDate } : {}),
        ...(promiseDate && promiseAmount ? { promise_amount: Number(promiseAmount), promise_currency: cur } : {}),
      });
      toast.success(t('dv.fu.saved'));
      onClose(true);
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal open onClose={add.isPending ? () => {} : () => onClose(false)} title={t('dv.fu.title')} maxWidth="560px"
      footer={<>
        <Button variant="secondary" onClick={() => onClose(false)} disabled={add.isPending}>{t('common.cancel')}</Button>
        <Button type="submit" form="dv-fu-form" disabled={add.isPending}>{add.isPending ? t('common.saving') : t('dv.fu.save')}</Button>
      </>}>
      <form id="dv-fu-form" className="cl-form" onSubmit={submit}>
        <div className="cl-note">{t('dv.fu.for', undefined, { name: target.customer_name })}{target.amountText ? ` · ${target.amountText}` : ''}</div>
        <div className="cl-field">
          <span>{t('dv.fu.kind')}</span>
          <div className="fin-seg dv-kinds" role="group" aria-label={t('dv.fu.kind')}>
            {KINDS.map(({ key, icon: Icon }) => (
              <button key={key} type="button" aria-pressed={kind === key} onClick={() => setKind(key)}><Icon size={16} /> {t(`dv.fu.kind.${key}`)}</button>
            ))}
          </div>
        </div>
        <label className="cl-field">
          <span>{t('dv.fu.note')}</span>
          <textarea className="cl-input dv-textarea" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('dv.fu.notePh')} />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <label className="cl-field">
            <span>{t('dv.fu.promiseDate')}</span>
            <input className="cl-input" type="date" min={todayIso()} value={promiseDate} onChange={(e) => setPromiseDate(e.target.value)} />
          </label>
          <label className="cl-field">
            <span>{t('dv.fu.promiseAmount', undefined, { currency: cur })}</span>
            <input className="cl-input" type="number" inputMode="decimal" min="0" step={cur === 'SLSH' ? '1' : '0.01'} value={promiseAmount}
              disabled={!promiseDate} onChange={(e) => setPromiseAmount(e.target.value)} />
          </label>
        </div>
        <div className="cl-field">
          <span>{t('dv.fu.reminder')}</span>
          <div className="dv-reminder">{text}</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <Button type="button" variant="secondary" icon={Copy} onClick={onCopy}>{t('dv.fu.copy')}</Button>
            {wa && <a className="dv-btn" href={`${wa}?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer"><MessageCircle size={14} /> {t('dv.fu.openWa')}</a>}
          </div>
        </div>
        {error && <span className="cl-err" role="alert">{error}</span>}
      </form>
    </Modal>
  );
}

export function WriteOffModal({ debt, onClose }) {
  const { t } = useI18n();
  const toast = useToast();
  const wo = useWriteOffDebt();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const auto = debt.source === 'auto_invoice';
  async function submit(e) {
    e.preventDefault();
    if (!reason.trim()) { setError(t('dv.wo.reason')); return; }
    try {
      await wo.mutateAsync({ id: debt.id, reason: reason.trim() });
      toast.success(t('dv.wo.done'));
      onClose(true);
    } catch (err) { setError(err.message || t('common.somethingWrong')); }
  }
  return (
    <Modal open onClose={wo.isPending ? () => {} : () => onClose(false)} title={t('dv.wo.title', undefined, { id: debt.id })}
      footer={<>
        <Button variant="secondary" onClick={() => onClose(false)} disabled={wo.isPending}>{t('common.cancel')}</Button>
        {!auto && <Button type="submit" form="dv-wo-form" variant="danger" disabled={wo.isPending || !reason.trim()}>{t('dv.wo.confirm')}</Button>}
      </>}>
      {auto ? (
        <div className="fin-alert soft"><p style={{ margin: 0 }}>{t('dv.wo.auto', undefined, { inv: debt.invoice_number || `#${debt.invoice_id}` })}</p></div>
      ) : (
        <form id="dv-wo-form" className="cl-form" onSubmit={submit}>
          <div className="fin-alert soft"><p style={{ margin: 0 }}>{t('dv.wo.body', undefined, { amount: fmtMoney(debt.remaining, debt.currency) })}</p></div>
          <label className="cl-field">
            <span>{t('dv.wo.reason')}</span>
            <textarea className="cl-input dv-textarea" maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {error && <span className="cl-err" role="alert">{error}</span>}
        </form>
      )}
    </Modal>
  );
}

export function EditDebtModal({ debt, onClose }) {
  const { t } = useI18n();
  const toast = useToast();
  const upd = useUpdateDebt();
  const [desc, setDesc] = useState(debt.description || '');
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    try {
      await upd.mutateAsync({ id: debt.id, description: desc.trim() });
      toast.success(t('dv.ed.saved'));
      onClose(true);
    } catch (err) { setError(err.message || t('common.somethingWrong')); }
  }
  return (
    <Modal open onClose={upd.isPending ? () => {} : () => onClose(false)} title={t('dv.ed.title')}
      footer={<>
        <Button variant="secondary" onClick={() => onClose(false)} disabled={upd.isPending}>{t('common.cancel')}</Button>
        <Button type="submit" form="dv-ed-form" disabled={upd.isPending}>{t('dv.ed.save')}</Button>
      </>}>
      <form id="dv-ed-form" className="cl-form" onSubmit={submit}>
        <div className="cl-note">{t('dv.ed.note')}</div>
        <label className="cl-field">
          <span>{t('dv.new.description')}</span>
          <input className="cl-input" maxLength={500} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </label>
        {error && <span className="cl-err" role="alert">{error}</span>}
      </form>
    </Modal>
  );
}

// Legacy settle — only offered for a MANUAL debt linked to an invoice, after
// the money was taken on that invoice in Billing. Records no payment.
export function SettleModal({ debt, onClose }) {
  const { t } = useI18n();
  const toast = useToast();
  const settle = useSettleDebt();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    try {
      await settle.mutateAsync({ id: debt.id, settlement_override_reason: reason.trim() || undefined });
      toast.success(t('dv.st.done'));
      onClose(true);
    } catch (err) { setError(err.message || t('common.somethingWrong')); }
  }
  return (
    <Modal open onClose={settle.isPending ? () => {} : () => onClose(false)} title={t('dv.st.confirmTitle', undefined, { id: debt.id })}
      footer={<>
        <Button variant="secondary" onClick={() => onClose(false)} disabled={settle.isPending}>{t('common.cancel')}</Button>
        <Button type="submit" form="dv-st-form" disabled={settle.isPending}>{t('dv.act.settle')}</Button>
      </>}>
      <form id="dv-st-form" className="cl-form" onSubmit={submit}>
        <div className="fin-alert soft"><p style={{ margin: 0 }}>{t('dv.st.confirmBody')}</p></div>
        <label className="cl-field">
          <span>{t('dv.st.reason')}</span>
          <input className="cl-input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        {error && <span className="cl-err" role="alert">{error}</span>}
      </form>
    </Modal>
  );
}

export function CreateDebtModal({ onClose }) {
  const { t } = useI18n();
  const toast = useToast();
  const create = useCreateDebt();
  const [customerId, setCustomerId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const { data: customersData } = useCustomers({});
  const customers = customersData?.data || [];
  async function submit(e) {
    e.preventDefault();
    setError('');
    const amt = Number(amount);
    if (!customerId) { setError(t('dv.err.customer')); return; }
    if (!Number.isFinite(amt) || amt <= 0) { setError(t('dv.err.amount')); return; }
    try {
      await create.mutateAsync({ customer_id: Number(customerId), amount: amt, currency, description: description.trim() || undefined });
      toast.success(t('dv.new.done'));
      onClose(true);
    } catch (err) { setError(err.message || t('common.somethingWrong')); }
  }
  return (
    <Modal open onClose={create.isPending ? () => {} : () => onClose(false)} title={t('dv.new.title')}
      footer={<>
        <Button variant="secondary" onClick={() => onClose(false)} disabled={create.isPending}>{t('common.cancel')}</Button>
        <Button type="submit" form="dv-new-form" disabled={create.isPending}>{create.isPending ? t('common.saving') : t('dv.new.save')}</Button>
      </>}>
      <form id="dv-new-form" className="cl-form" onSubmit={submit}>
        <div className="cl-note">{t('dv.new.body')}</div>
        <label className="cl-field">
          <span>{t('dv.new.customer')}</span>
          <select className="cl-input" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">{t('dv.new.pick')}</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_number} — {c.business_name || c.name}</option>)}
          </select>
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '10px' }}>
          <label className="cl-field">
            <span>{t('dv.new.amount')}</span>
            <input className="cl-input" type="number" inputMode="decimal" min="0" step={currency === 'SLSH' ? '1' : '0.01'} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="cl-field">
            <span>{t('dv.f.currency')}</span>
            <select className="cl-input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="USD">USD</option>
              <option value="SLSH">SLSH</option>
            </select>
          </label>
        </div>
        <label className="cl-field">
          <span>{t('dv.new.description')}</span>
          <input className="cl-input" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {error && <span className="cl-err" role="alert">{error}</span>}
      </form>
    </Modal>
  );
}
