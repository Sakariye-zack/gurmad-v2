import React, { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { ArrowLeft, Receipt, XCircle } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, ConfirmDialog, useToast, StatCard } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useInvoice, useVoidInvoice, useReversePayment } from '../../hooks/useFinancial.js';

const STATUS_MAP = { unpaid: 'danger', partial: 'warning', paid: 'success', voided: 'info' };

export default function InvoiceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useInvoice(id);
  const [voidOpen, setVoidOpen] = useState(false);
  const voidInvoice = useVoidInvoice(id);
  const reversePayment = useReversePayment(id);
  const toast = useToast();
  const invoice = data?.data;

  if (isLoading) return <LoadingState label="Loading invoice…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!invoice) return null;

  async function handleVoid(reason) {
    try { await voidInvoice.mutateAsync(reason); toast.success('Invoice voided.'); setVoidOpen(false); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }

  async function handleReverse(paymentId) {
    const reason = window.prompt('Reason for reversing this payment?');
    if (!reason) return;
    try {
      const result = await reversePayment.mutateAsync({ id: paymentId, reason });
      toast.success('Payment reversed.');
      if (result.data.warnings || result.warnings) {
        (result.warnings || []).forEach((w) => toast.error(w));
      }
    } catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }

  const balance = invoice.balance || {};

  return (
    <div>
      <button onClick={() => navigate('/financial/invoices')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Invoices
      </button>

      <PageHeader
        icon={Receipt}
        title={invoice.invoice_number}
        subtitle={`${invoice.customer_name} (${invoice.customer_number})`}
        actions={
          invoice.status !== 'voided' && (
            <RoleGate roles={['admin']}>
              <Button variant="danger" icon={XCircle} onClick={() => setVoidOpen(true)}>Void Invoice</Button>
            </RoleGate>
          )
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <StatCard label="Invoice Total" value={`${invoice.currency} ${parseFloat(invoice.invoice_total).toFixed(2)}`} icon={Receipt} />
        <StatCard label="Paid" value={`$${(balance.paid ?? 0).toFixed?.(2) ?? balance.paid}`} accent="var(--success)" />
        <StatCard label="Outstanding" value={`$${(balance.outstanding ?? 0).toFixed?.(2) ?? balance.outstanding}`} accent={balance.outstanding > 0 ? 'var(--danger)' : 'var(--success)'} />
        <StatCard label="Status" value={<StatusBadge status={invoice.status} map={STATUS_MAP} />} />
      </div>

      <div style={{ marginBottom: '20px' }}>
        <DetailGrid items={[
          { label: 'Customer', value: <Link to={`/customers/${invoice.customer_id}`}>{invoice.customer_name}</Link> },
          { label: 'Discount', value: `${invoice.currency} ${parseFloat(invoice.discount_amount).toFixed(2)}` },
          { label: 'Created', value: new Date(invoice.created_at).toLocaleString() },
          { label: 'Collection event', value: invoice.batch_customer_id ? `Batch Customer #${invoice.batch_customer_id}` : 'Walk-in / not linked' },
          { label: 'Linked debt', value: invoice.debt ? <StatusBadge status={invoice.debt.status} map={{ unpaid: 'danger', paid: 'success' }} /> : 'None' },
          ...(invoice.status === 'voided' ? [
            { label: 'Voided reason', value: invoice.voided_reason },
            { label: 'Voided at', value: new Date(invoice.voided_at).toLocaleString() },
          ] : []),
        ]} />
      </div>

      <span style={sectionLabelStyle}>Payment History</span>
      {invoice.payments.length === 0 && (
        <Card style={{ padding: '16px' }}><p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>No payments recorded yet.</p></Card>
      )}
      {invoice.payments.length > 0 && (
        <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
                {['Amount', 'Method', 'USD Value', 'Status', 'Date', ''].map((h) => (
                  <th key={h} style={{ padding: '10px 14px', textAlign: 'left', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoice.payments.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={cellStyle} className="tabular-nums">{p.currency} {parseFloat(p.amount).toFixed(2)}</td>
                  <td style={{ ...cellStyle, textTransform: 'capitalize' }}>{p.method}</td>
                  <td style={cellStyle} className="tabular-nums">${parseFloat(p.amount_usd).toFixed(2)}</td>
                  <td style={cellStyle}><StatusBadge status={p.status} map={{ recorded: 'success', reversed: 'danger' }} /></td>
                  <td style={cellStyle}>{new Date(p.created_at).toLocaleString()}</td>
                  <td style={cellStyle}>
                    {p.status === 'recorded' && (
                      <RoleGate roles={['admin']}>
                        <Button variant="secondary" onClick={() => handleReverse(p.id)} disabled={reversePayment.isPending}>Reverse</Button>
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
        title="Void this invoice?"
        message={
          <div>
            <p style={{ margin: '0 0 8px' }}>The invoice row and its history are preserved — this is not a delete. A reason is required.</p>
            <input id="void-reason" placeholder="Reason for voiding" style={inputStyle} />
          </div>
        }
        confirmLabel="Void Invoice"
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
