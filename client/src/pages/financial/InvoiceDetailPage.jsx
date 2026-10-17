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

  return (
    <div>
      <button onClick={() => navigate('/financial/invoices')} style={backLinkStyle}>
        <ArrowLeft size={14} /> {t('portal.invoice.back')}
      </button>

      <PageHeader
        icon={Receipt}
        title={invoice.invoice_number}
        subtitle={`${invoice.customer_name} (${invoice.customer_number})`}
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
        <StatCard label={t('fin.invoice_total')} value={`${invoice.currency} ${parseFloat(invoice.invoice_total).toFixed(2)}`} icon={Receipt} />
        <StatCard label={t('status.paid')} value={`$${(balance.paid ?? 0).toFixed?.(2) ?? balance.paid}`} accent="var(--success)" />
        <StatCard label={t('portal.invoice.outstanding')} value={`$${(balance.outstanding ?? 0).toFixed?.(2) ?? balance.outstanding}`} accent={balance.outstanding > 0 ? 'var(--danger)' : 'var(--success)'} />
        <StatCard label={t('common.status')} value={<StatusBadge status={invoice.status} map={STATUS_MAP} />} />
      </div>

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
          { label: t('portal.invoice.discount'), value: `${invoice.currency} ${parseFloat(invoice.discount_amount).toFixed(2)}` },
          { label: t('fin.created'), value: new Date(invoice.created_at).toLocaleString() },
          { label: t('fin.collection_event'), value: invoice.batch_customer_id ? t('fin.m.batchCustomer', undefined, { id: invoice.batch_customer_id }) : t('fin.walk_in_not_linked') },
          { label: t('fin.linked_debt'), value: invoice.debt ? <StatusBadge status={invoice.debt.status} map={{ unpaid: 'danger', paid: 'success' }} /> : 'None' },
          ...(invoice.status === 'voided' ? [
            { label: t('fin.voided_reason'), value: invoice.voided_reason },
            { label: t('fin.voided_at'), value: new Date(invoice.voided_at).toLocaleString() },
          ] : []),
        ]} />
      </Card>

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
                  <td style={cellStyle} className="tabular-nums">{p.currency} {parseFloat(p.amount).toFixed(2)}</td>
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
