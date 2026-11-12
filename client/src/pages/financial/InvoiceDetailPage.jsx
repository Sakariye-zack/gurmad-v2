import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Receipt, XCircle, FileDown, Printer, Wallet, Undo2 } from 'lucide-react';
import { Button, Card, StatusBadge, LoadingState, ErrorState, ConfirmDialog, Modal, useToast, StatCard } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { apiClient } from '../../lib/apiClient.js';
import { useInvoice, useVoidInvoice, useReversePayment } from '../../hooks/useFinancial.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import InvoiceDocument, { LOGO_URL } from './InvoiceDocument.jsx';
import {
  STATUS_MAP, PAYMENT_STATUS_MAP, fmtMoney, invCurrency, otherCurrency, secondaryBlock, rateText, methodLabel,
  recordedByLabel, fmtDateTime, periodLabel,
} from './financeUtils.js';
import './finance.css';

// Wait (bounded) until every image in `root` has loaded or failed, so the
// company logo is on the page before the print dialog snapshots it.
async function waitForImages(root, timeoutMs = 4000) {
  const preload = new Promise((resolve) => { const i = new Image(); i.onload = resolve; i.onerror = resolve; i.src = LOGO_URL; });
  const imgs = root ? Array.from(root.querySelectorAll('img')) : [];
  const each = imgs.map((img) => (img.complete
    ? (img.decode ? img.decode().catch(() => {}) : Promise.resolve())
    : new Promise((resolve) => { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true }); })));
  await Promise.race([Promise.all([preload, ...each]), new Promise((r) => setTimeout(r, timeoutMs))]);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

export default function InvoiceDetailPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useInvoice(id);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [reverseFor, setReverseFor] = useState(null);
  const [reverseReason, setReverseReason] = useState('');
  const [reverseError, setReverseError] = useState('');
  const voidInvoice = useVoidInvoice(id);
  const reversePayment = useReversePayment(id);
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const [printing, setPrinting] = useState(false);
  const invoice = data?.data;

  if (isLoading) return <LoadingState label={t('portal.invoice.loading')} />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!invoice) return null;

  async function handlePrint() {
    setPrinting(true);
    try {
      await waitForImages(document.querySelector('.invdoc-print-root'));
      window.print();
    } finally {
      setPrinting(false);
    }
  }

  async function handleDownloadDocx() {
    setDownloading(true);
    try {
      await apiClient.downloadAuthorizedFile(`/v2/invoices/${id}/document.docx`, `${invoice.invoice_number}.docx`);
    } catch (err) {
      toast.error(err.message || t('fin.failed_to_download_document'));
    } finally {
      setDownloading(false);
    }
  }

  async function handleVoid() {
    if (!voidReason.trim()) { toast.error(t('fr.inv.reasonRequired')); return; }
    try { await voidInvoice.mutateAsync(voidReason.trim()); toast.success(t('fin.invoice_voided')); setVoidOpen(false); setVoidReason(''); }
    catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }

  async function handleReverse() {
    setReverseError('');
    if (!reverseReason.trim()) { setReverseError(t('fr.inv.reasonRequired')); return; }
    try {
      const result = await reversePayment.mutateAsync({ id: reverseFor.id, reason: reverseReason.trim() });
      toast.success(t('fin.payment_reversed'));
      (result.warnings || []).forEach((w) => toast.error(w));
      setReverseFor(null);
      setReverseReason('');
    } catch (err) { setReverseError(err.message || t('common.somethingWrong')); }
  }

  const balance = invoice.balance || {};
  const cur = invCurrency(invoice);
  const other = otherCurrency(cur);
  const sec = secondaryBlock(balance, cur);
  const rate = rateText(balance);
  const net = Number(balance.netTotal || 0);
  const grossSec = sec && net > 0 ? sec.netTotal * (parseFloat(invoice.invoice_total) / net) : null;
  const owed = Number(balance.outstanding || 0);
  const canPay = invoice.status === 'unpaid' || invoice.status === 'partial';
  const autoBadge = invoice.auto_generated
    ? (invoice.billing_period ? t('inv.auto_badge_month', undefined, { month: periodLabel(invoice.billing_period) }) : t('inv.auto_badge_daily'))
    : null;

  return (
    <div>
      <button onClick={() => navigate('/financial/invoices')} style={backLinkStyle}>
        <ArrowLeft size={14} /> {t('portal.invoice.back')}
      </button>

      <div className="inv-hero">
        <div style={{ minWidth: 0 }}>
          <h1>
            <Receipt size={24} color="var(--brand)" /> {invoice.invoice_number}
            <StatusBadge status={invoice.status} map={STATUS_MAP} />
            {autoBadge && <span style={autoBadgeStyle}>{autoBadge}</span>}
          </h1>
          <div className="who">
            <Link to={`/customers/${invoice.customer_id}`}>{invoice.customer_name}</Link>
            <span style={{ color: 'var(--brand)', fontWeight: 700, marginLeft: '8px' }}>{invoice.customer_number}</span>
          </div>
          {invoice.customer_path && <div className="path">{invoice.customer_path}</div>}
        </div>
        <div className="inv-actions">
          {canPay && (
            <RoleGate roles={['admin', 'cashier']}>
              <Button icon={Wallet} onClick={() => navigate(`/billing?invoice=${invoice.id}`)}>{t('fr.inv.payNow')}</Button>
            </RoleGate>
          )}
          <Button variant="secondary" icon={Printer} onClick={handlePrint} disabled={printing} title={t('fr.inv.printHint')}>
            {printing ? t('fr.inv.preparing') : t('fin.print_download_pdf')}
          </Button>
          <Button variant="secondary" icon={FileDown} onClick={handleDownloadDocx} disabled={downloading}>{downloading ? t('fin.preparing') : t('fin.download_word_docx')}</Button>
          {invoice.status !== 'voided' && (
            <RoleGate roles={['admin']}>
              <Button variant="danger" icon={XCircle} onClick={() => setVoidOpen(true)}>{t('fin.void_invoice')}</Button>
            </RoleGate>
          )}
        </div>
      </div>

      <div className="inv-layout">
        <div className="inv-preview">
          <InvoiceDocument invoice={invoice} />
        </div>

        <div className="inv-side">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <StatCard label={t('fin.invoice_total')} value={<span style={{ fontSize: '20px' }}>{fmtMoney(invoice.invoice_total, cur)}</span>} sub={grossSec !== null ? `≈ ${fmtMoney(grossSec, other)}` : undefined} />
            <StatCard label={t('fr.pay.paid')} value={<span style={{ fontSize: '20px' }}>{fmtMoney(balance.paid, cur)}</span>} sub={sec ? `≈ ${fmtMoney(sec.paid, other)}` : undefined} accent="var(--success)" />
          </div>
          <StatCard
            label={t('fr.inv.balanceDue')}
            value={fmtMoney(owed, cur)}
            sub={[sec ? `≈ ${fmtMoney(sec.outstanding, other)}` : null, rate ? t('fr.pay.rate', undefined, { rate }) : null].filter(Boolean).join(' · ') || undefined}
            accent={owed > 0.004 ? 'var(--danger)' : 'var(--success)'}
          />

          <Card style={{ padding: '16px' }}>
            <span className="fin-section-label">{t('fr.inv.payments')}</span>
            {invoice.payments.length === 0 && <div className="fin-note">{t('fr.inv.noPayments')}</div>}
            <div className="fin-paylist">
              {invoice.payments.map((p) => (
                <div key={p.id}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }} className={p.status === 'reversed' ? 'fin-struck' : undefined}>
                      {fmtMoney(p.amount, p.currency)} · {p.channel === 'portal_zaad' ? t('fr.portalZaad') : methodLabel(t, p.method)}
                    </div>
                    <div className="ref">
                      {fmtDateTime(p.created_at)}{p.reference_code ? ` · ${p.reference_code}` : ''} · {recordedByLabel(t, p)}
                      {p.status === 'reversed' && p.reversed_reason ? ` · ${p.reversed_reason}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', flexShrink: 0 }}>
                    <StatusBadge status={p.status} map={PAYMENT_STATUS_MAP} />
                    {p.status === 'recorded' && (
                      <RoleGate roles={['admin']}>
                        <button type="button" className="fin-linkbtn" onClick={() => { setReverseFor(p); setReverseReason(''); setReverseError(''); }}>
                          <Undo2 size={12} style={{ verticalAlign: '-2px' }} /> {t('fin.reverse')}
                        </button>
                      </RoleGate>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card style={{ padding: '16px', fontSize: '13px' }}>
            <span className="fin-section-label">{t('fr.inv.details')}</span>
            <dl style={dlStyle}>
              <dt>{t('fin.created')}</dt><dd>{fmtDateTime(invoice.created_at)}{invoice.created_by_name ? ` · ${invoice.created_by_name}` : ''}</dd>
              <dt>{t('fr.inv.collectionEvent')}</dt><dd>{invoice.visit?.batch_code || (invoice.batch_customer_id ? `#${invoice.batch_customer_id}` : t('fin.walk_in_not_linked'))}</dd>
              <dt>{t('fr.inv.linkedDebt')}</dt><dd>{invoice.debt ? <StatusBadge status={invoice.debt.status} map={{ unpaid: 'danger', paid: 'success' }} /> : t('fr.inv.none')}</dd>
              {invoice.status === 'voided' && (<>
                <dt>{t('fin.voided_reason')}</dt><dd>{invoice.voided_reason}</dd>
                <dt>{t('fin.voided_at')}</dt><dd>{fmtDateTime(invoice.voided_at)}</dd>
              </>)}
            </dl>
          </Card>
        </div>
      </div>

      {/* The only thing that prints (see finance.css @media print). */}
      {createPortal(<div className="invdoc-print-root"><InvoiceDocument invoice={invoice} /></div>, document.body)}

      <ConfirmDialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        onConfirm={handleVoid}
        title={t('fin.void_this_invoice')}
        message={
          <div>
            <p style={{ margin: '0 0 8px' }}>{t('fin.the_invoice_row_and_its')}</p>
            <input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder={t('fin.reason_for_voiding')} className="fin-input" />
          </div>
        }
        confirmLabel={t('fin.void_invoice')}
        danger
        isLoading={voidInvoice.isPending}
      />

      <Modal
        open={!!reverseFor}
        onClose={() => setReverseFor(null)}
        title={t('fr.inv.reverseTitle')}
        footer={<>
          <Button variant="secondary" onClick={() => setReverseFor(null)} disabled={reversePayment.isPending}>{t('common.cancel')}</Button>
          <Button variant="danger" icon={Undo2} onClick={handleReverse} disabled={reversePayment.isPending}>{t('fr.inv.reverseConfirm')}</Button>
        </>}
      >
        {reverseFor && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ fontWeight: 800 }}>{fmtMoney(reverseFor.amount, reverseFor.currency)} · {methodLabel(t, reverseFor.method)} · {fmtDateTime(reverseFor.created_at)}</div>
            <div className="fin-note">{t('fr.inv.reverseHelp')}</div>
            <label className="fin-field">
              <span>{t('fr.inv.reversePrompt')}</span>
              <input className="fin-input" value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} autoFocus />
            </label>
            {reverseError && <span className="fin-err">{reverseError}</span>}
          </div>
        )}
      </Modal>
    </div>
  );
}

const autoBadgeStyle = {
  padding: '2px 8px', borderRadius: '999px', background: 'var(--success-bg)',
  color: 'var(--brand)', fontSize: '11px', fontWeight: 800,
};
const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
const dlStyle = { margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 12px' };
