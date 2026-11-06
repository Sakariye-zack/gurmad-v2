import React, { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Receipt, XCircle, FileDown, Printer } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, ConfirmDialog, useToast, StatCard } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { apiClient } from '../../lib/apiClient.js';
import { useInvoice, useVoidInvoice, useReversePayment } from '../../hooks/useFinancial.js';
import { useCompanyName } from '../../hooks/useSettings.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

const STATUS_MAP = { unpaid: 'danger', partial: 'warning', paid: 'success', voided: 'info' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 'USD' -> $12.00, 'SLSH' -> SLSH 30,000
function fmtMoney(n, cur) {
  const v = Number(n || 0);
  return cur === 'SLSH' ? `SLSH ${Math.round(v).toLocaleString('en-US')}` : `$${v.toFixed(2)}`;
}
const periodLabel = (p) => { const m = /^(\d{4})-(\d{2})$/.exec(p || ''); return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ''; };
const dayLabel = (iso) => `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

export default function InvoiceDetailPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useInvoice(id);
  const [voidOpen, setVoidOpen] = useState(false);
  const voidInvoice = useVoidInvoice(id);
  const reversePayment = useReversePayment(id);
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const invoice = data?.data;
  // System name — user-requested ('meel kasta oo magaca system ku ka soo
  // muuqanayo waa in aan markan update gareeyo'). The printed/PDF
  // letterhead is exactly the kind of surface a hardcoded name matters
  // most on — a customer-facing document.
  const { data: companyNameData } = useCompanyName();
  const companyName = companyNameData?.data?.company_name || 'GURMAD';

  if (isLoading) return <LoadingState label={t('portal.invoice.loading')} />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!invoice) return null;

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

  async function handleVoid(reason) {
    try { await voidInvoice.mutateAsync(reason); toast.success(t('fin.invoice_voided')); setVoidOpen(false); }
    catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }

  async function handleReverse(paymentId) {
    const reason = window.prompt('Reason for reversing this payment?');
    if (!reason) return;
    try {
      const result = await reversePayment.mutateAsync({ id: paymentId, reason });
      toast.success(t('fin.payment_reversed'));
      if (result.data.warnings || result.warnings) {
        (result.warnings || []).forEach((w) => toast.error(w));
      }
    } catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }

  const balance = invoice.balance || {};
  // Agreed (invoice) currency is the primary figure; the other currency is secondary, shown only when a rate exists.
  const cur = invoice.currency === 'SLSH' ? 'SLSH' : 'USD';
  const other = cur === 'SLSH' ? 'USD' : 'SLSH';
  const secBlock = balance.rate ? (other === 'USD' ? balance.usd : balance.slsh) : null;
  const secLine = (v) => (secBlock ? `≈ ${fmtMoney(v, other)}` : undefined);
  const net = Number(balance.netTotal || 0);
  const grossSec = secBlock && net > 0 ? secBlock.netTotal * (parseFloat(invoice.invoice_total) / net) : 0;
  const rateText = balance.rate ? t('inv.rate_line', undefined, { rate: Number(balance.rate.rate).toLocaleString('en-US', { maximumFractionDigits: 2 }) }) : null;
  const autoBadge = invoice.auto_generated
    ? (invoice.billing_period ? t('inv.auto_badge_month', undefined, { month: periodLabel(invoice.billing_period) }) : t('inv.auto_badge_daily'))
    : null;
  const workedDays = Array.isArray(invoice.worked_days) ? invoice.worked_days : null;

  return (
    <div>
      <button onClick={() => navigate('/financial/invoices')} style={backLinkStyle}>
        <ArrowLeft size={14} /> {t('portal.invoice.back')}
      </button>

      <PageHeader
        icon={Receipt}
        title={invoice.invoice_number}
        subtitle={<span>{invoice.customer_name} ({invoice.customer_number}){autoBadge && <span style={autoBadgeStyle}>{autoBadge}</span>}</span>}
        actions={
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <Button variant="secondary" icon={Printer} onClick={() => window.print()}>{t('fin.print_download_pdf')}</Button>
            <Button variant="secondary" icon={FileDown} onClick={handleDownloadDocx} disabled={downloading}>{downloading ? t('fin.preparing') : t('fin.download_word_docx')}</Button>
            {invoice.status !== 'voided' && (
              <RoleGate roles={['admin']}>
                <Button variant="danger" icon={XCircle} onClick={() => setVoidOpen(true)}>{t('fin.void_invoice')}</Button>
              </RoleGate>
            )}
          </div>
        }
      />

      <style>{`
        @media print {
          body * { visibility: hidden; }
          .invoice-print-document, .invoice-print-document * { visibility: visible; }
          .invoice-print-document { position: absolute; left: 0; top: 0; width: 100%; padding: 24px; color: #000; background: #fff; }
        }
      `}</style>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px', marginBottom: '20px' }} className="no-print">
        <StatCard label={t('fin.invoice_total')} value={fmtMoney(invoice.invoice_total, cur)} sub={secLine(grossSec)} icon={Receipt} />
        <StatCard label={t('status.paid')} value={fmtMoney(balance.paid, cur)} sub={secLine(secBlock?.paid)} accent="var(--success)" />
        <StatCard label={t('portal.invoice.outstanding')} value={fmtMoney(balance.outstanding, cur)} sub={secLine(secBlock?.outstanding)} accent={balance.outstanding > 0 ? 'var(--danger)' : 'var(--success)'} />
        <StatCard label={t('common.status')} value={<StatusBadge status={invoice.status} map={STATUS_MAP} />} />
      </div>
      {rateText && (
        <div className="no-print" style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '-8px 0 16px' }}>
          {t('inv.exchange_rate')}: <strong>{rateText}</strong>
        </div>
      )}

      <Card className="invoice-print-document" style={{ padding: '24px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid var(--brand)', paddingBottom: '16px', marginBottom: '16px' }}>
          <div>
            <div style={{ fontSize: '20px', fontWeight: 900, color: 'var(--brand)' }}>{companyName}</div>
            <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '2px' }}>{t('fin.invoice')}</div>
          </div>
          <div style={{ textAlign: 'right', fontSize: '12px' }}>
            <div><strong>{t('fin.invoice_no')}</strong> {invoice.invoice_number}</div>
            <div><strong>{t('common.date')}</strong> {new Date(invoice.created_at).toLocaleDateString()}</div>
            <div><strong>{t('fin.customer')}</strong> {invoice.customer_name} ({invoice.customer_number})</div>
          </div>
        </div>
        <DetailGrid items={[
          { label: t('fin.customer'), value: <Link to={`/customers/${invoice.customer_id}`}>{invoice.customer_name}</Link> },
          { label: t('portal.invoice.discount'), value: fmtMoney(invoice.discount_amount, invoice.currency) },
          { label: t('fin.created'), value: new Date(invoice.created_at).toLocaleString() },
          { label: t('fin.collection_event'), value: invoice.batch_customer_id ? t('fin.m.batchCustomer', undefined, { id: invoice.batch_customer_id }) : t('fin.walk_in_not_linked') },
          { label: t('fin.linked_debt'), value: invoice.debt ? <StatusBadge status={invoice.debt.status} map={{ unpaid: 'danger', paid: 'success' }} /> : 'None' },
          ...(invoice.status === 'voided' ? [
            { label: t('fin.voided_reason'), value: invoice.voided_reason },
            { label: t('fin.voided_at'), value: new Date(invoice.voided_at).toLocaleString() },
          ] : []),
        ]} />
      </Card>

      {workedDays && (
        <>
          <span style={sectionLabelStyle}>{t('inv.service_days')}{invoice.billing_period ? ` — ${periodLabel(invoice.billing_period)}` : ''}</span>
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', marginBottom: '20px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                  {[t('inv.week'), t('inv.dates')].map((h) => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {workedDays.map((wk) => (
                  <tr key={wk.week} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={cellStyle}>{t('inv.week_n', undefined, { n: wk.week })} <span style={{ color: 'var(--text-muted)' }}>({wk.range})</span></td>
                    <td style={cellStyle}>{wk.dates.length ? wk.dates.map(dayLabel).join(', ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <span style={sectionLabelStyle}>{t('portal.invoice.paymentHistory')}</span>
      {invoice.payments.length === 0 && (
        <Card style={{ padding: '16px' }}><p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>{t('portal.invoice.noPayments')}</p></Card>
      )}
      {invoice.payments.length > 0 && (
        <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                {[t('common.amount'), t('common.method'), t('fin.usd_value'), t('common.status'), t('common.date'), ''].map((h) => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoice.payments.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={cellStyle} className="tabular-nums">{fmtMoney(p.amount, p.currency)}</td>
                  <td style={{ ...cellStyle, textTransform: 'capitalize' }}>{t('method.' + p.method, p.method)}</td>
                  <td style={cellStyle} className="tabular-nums">${parseFloat(p.amount_usd).toFixed(2)}</td>
                  <td style={cellStyle}><StatusBadge status={p.status} map={{ recorded: 'success', reversed: 'danger' }} /></td>
                  <td style={cellStyle}>{new Date(p.created_at).toLocaleString()}</td>
                  <td style={cellStyle}>
                    {p.status === 'recorded' && (
                      <RoleGate roles={['admin']}>
                        <Button variant="secondary" onClick={() => handleReverse(p.id)} disabled={reversePayment.isPending}>{t('fin.reverse')}</Button>
                      </RoleGate>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        onConfirm={() => handleVoid(document.getElementById('void-reason')?.value || '')}
        title={t('fin.void_this_invoice')}
        message={
          <div>
            <p style={{ margin: '0 0 8px' }}>{t('fin.the_invoice_row_and_its')}</p>
            <input id="void-reason" placeholder={t('fin.reason_for_voiding')} style={inputStyle} />
          </div>
        }
        confirmLabel={t('fin.void_invoice')}
        danger
        isLoading={voidInvoice.isPending}
      />
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const autoBadgeStyle = {
  marginLeft: '8px', padding: '2px 8px', borderRadius: '999px', background: 'var(--brand-soft, rgba(61,170,53,0.12))',
  color: 'var(--brand)', fontSize: '11px', fontWeight: 800, verticalAlign: 'middle',
};
const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
const sectionLabelStyle = {
  display: 'block', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--text-muted)', margin: '0 0 10px',
};
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit', marginTop: '8px',
};
