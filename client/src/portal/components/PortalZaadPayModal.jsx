import React, { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Smartphone } from 'lucide-react';
import { Modal, Button, StatusBadge } from '../../components/ui/index.js';
import { portalApiClient } from '../apiClient.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { fmtMoney } from '../../lib/money.js';

// WAAFI's API_PURCHASE call is synchronous: the server answers only after the
// customer approves/declines on their phone (~60 s worst case), so the client
// waits well beyond that before giving up.
const ZAAD_CLIENT_TIMEOUT_MS = 120 * 1000;

const ERROR_KEYS = {
  ZAAD_DECLINED: 'portal.zaad.err.declined',
  TIMEOUT: 'portal.zaad.err.unknown',
  PAYMENT_UNKNOWN: 'portal.zaad.err.unknown',
  PAYMENT_UNCONFIRMED: 'portal.zaad.err.unconfirmed',
  PHONE_NOT_REGISTERED: 'portal.zaad.err.phoneNotRegistered',
  ACCOUNT_ARCHIVED: 'portal.zaad.err.archived',
  TOO_MANY_ATTEMPTS: 'portal.zaad.err.tooMany',
  TOO_MANY_ATTEMPTS_PHONE: 'portal.zaad.err.tooMany',
  IN_PROGRESS: 'portal.zaad.err.inProgress',
  OVERPAYMENT: 'portal.zaad.err.overpay',
  NOT_CONFIGURED: 'portal.zaad.err.notConfigured',
  ALREADY_PAID: 'portal.zaad.err.alreadyPaid',
  GATEWAY_ERROR: 'portal.zaad.err.gateway',
};

// Props: invoice { id, invoice_number, currency }, outstanding (number, in
// invoice currency), defaultPhone, onClose(), onPaid(receipt).
export default function PortalZaadPayModal({ invoice, outstanding, defaultPhone, onClose, onPaid }) {
  const { t } = useI18n();
  const currency = invoice.currency === 'SLSH' ? 'SLSH' : 'USD';
  // floor (never above what is owed); SLSH is whole shillings
  const maxAmount = currency === 'SLSH' ? Math.floor(Number(outstanding) + 1e-6) : Math.floor(Number(outstanding) * 100 + 1e-6) / 100;
  const [amount, setAmount] = useState(String(maxAmount));
  const [phone, setPhone] = useState(defaultPhone || '');
  const [phones, setPhones] = useState(defaultPhone ? [defaultPhone] : []);
  const [phase, setPhase] = useState('form'); // form | waiting | success
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState(null);

  // Payments can only go to the customer's own registered numbers.
  useEffect(() => {
    let alive = true;
    portalApiClient.get('/me').then((r) => {
      if (!alive || !r.data) return;
      const list = [...new Set([r.data.phone, r.data.alternate_phone, r.data.whatsapp].filter((p) => p && String(p).replace(/\D/g, '').length >= 7))];
      setPhones(list);
      setPhone((p) => p || list[0] || '');
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  function errorText(err) {
    if (err.code === 'RECONCILIATION_REQUIRED') return t('portal.zaad.err.reconcile', undefined, { tx: err.details?.transaction_id || '' });
    const key = ERROR_KEYS[err.code];
    if (key) return t(key);
    if (err.status === 504 || err.status === 408) return t('portal.zaad.err.unknown');
    return t('portal.zaad.err.generic');
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > maxAmount + 0.001 || (currency === 'SLSH' && !Number.isInteger(amt))) { setError(t('portal.zaad.err.amount')); return; }
    if (phone.replace(/\D/g, '').length < 7) { setError(t('portal.zaad.err.phone')); return; }
    setPhase('waiting');
    try {
      const res = await portalApiClient.post(`/invoices/${invoice.id}/pay-zaad`, { amount: amt, phone: phone.trim() }, { timeoutMs: ZAAD_CLIENT_TIMEOUT_MS });
      setReceipt(res.data);
      setPhase('success');
      onPaid?.(res.data);
    } catch (err) {
      setError(errorText(err));
      setPhase('form');
      // a reconciliation case did take money; refresh so the customer sees current state
      if (err.code === 'RECONCILIATION_REQUIRED' || err.code === 'PAYMENT_UNKNOWN' || err.code === 'TIMEOUT') onPaid?.(null);
    }
  }

  const waiting = phase === 'waiting';
  const footer = phase === 'success'
    ? <Button onClick={onClose}>{t('portal.zaad.done')}</Button>
    : <>
        <Button variant="secondary" onClick={onClose} disabled={waiting}>{t('common.cancel')}</Button>
        <Button type="submit" form="portal-zaad-form" disabled={waiting}>{waiting ? t('portal.zaad.waiting') : t('portal.zaad.send')}</Button>
      </>;

  return (
    <Modal open onClose={waiting ? () => {} : onClose} title={t('portal.zaad.title', undefined, { invoice: invoice.invoice_number })} footer={footer}>
      {phase === 'success' && receipt ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center', textAlign: 'center' }}>
          <CheckCircle2 size={44} color="var(--success)" />
          <h3 style={{ margin: 0 }}>{t('portal.zaad.success')}</h3>
          <p style={{ margin: 0, fontSize: '13px' }}>
            {t('portal.zaad.successBody', undefined, { amount: fmtMoney(receipt.amount, receipt.currency), invoice: receipt.invoice_number })}
          </p>
          <dl style={receiptStyle}>
            <dt style={dtStyle}>{t('portal.zaad.txId')}</dt><dd style={ddStyle}>{receipt.transaction_id}</dd>
            <dt style={dtStyle}>{t('portal.zaad.newStatus')}</dt><dd style={ddStyle}><StatusBadge status={receipt.invoice_status} /></dd>
            <dt style={dtStyle}>{t('portal.zaad.remaining')}</dt><dd style={ddStyle}>{fmtMoney(receipt.outstanding, receipt.outstanding_currency)}</dd>
          </dl>
        </div>
      ) : (
        <form id="portal-zaad-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', fontSize: '13px', color: 'var(--text-muted)' }}>
            <Smartphone size={18} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span>{t('portal.zaad.explain')}</span>
          </div>
          <p style={{ margin: 0, fontSize: '13px', fontWeight: 700 }}>{t('portal.zaad.outstanding', undefined, { amount: fmtMoney(maxAmount, currency) })}</p>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('portal.zaad.amount', undefined, { currency })}</span>
            <input type="number" min={currency === 'SLSH' ? 1 : 0.01} step={currency === 'SLSH' ? 1 : 0.01} max={maxAmount} value={amount} onChange={(e) => setAmount(e.target.value)} style={inputStyle} disabled={waiting} />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('portal.zaad.phone')}</span>
            <select value={phone} onChange={(e) => setPhone(e.target.value)} style={inputStyle} disabled={waiting || phones.length === 0}>
              {phones.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          {waiting && (
            <div role="status" style={{ display: 'flex', gap: '10px', alignItems: 'center', fontSize: '13px' }}>
              <Loader2 size={20} className="spin" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
              <span>{t('portal.zaad.waitingHint')}</span>
            </div>
          )}
          {error && <span role="alert" style={{ fontSize: '12px', color: 'var(--danger)' }}>{error}</span>}
        </form>
      )}
      <style>{'@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>
    </Modal>
  );
}

const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '6px' };
const labelStyle = { fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' };
const inputStyle = { padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontSize: '14px', background: 'var(--surface)', color: 'var(--text)' };
const receiptStyle = { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', margin: '4px 0 0', fontSize: '13px', textAlign: 'left' };
const dtStyle = { color: 'var(--text-muted)', fontWeight: 700 };
const ddStyle = { margin: 0, wordBreak: 'break-all' };
