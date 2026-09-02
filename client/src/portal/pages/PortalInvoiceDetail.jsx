import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Eye, X } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState } from '../../components/ui/index.js';
import { portalApiClient } from '../apiClient.js';

// Rebuild — Implementation Spec §11/§23 (OD-5/Invoice Preview): adds an
// inline HTML preview alongside the existing, UNCHANGED .docx download —
// same ownership-checked route pattern, same 404 privacy behavior.
export default function PortalInvoiceDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [previewHtml, setPreviewHtml] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);

  function load() {
    setLoading(true);
    setError(null);
    // A cross-customer id here comes back 404 from the server (OD-7) —
    // rendered identically to "doesn't exist", never leaking that another
    // customer's invoice exists.
    portalApiClient.get(`/invoices/${id}`)
      .then((res) => setInvoice(res.data))
      .catch((err) => setError(err))
      .finally(() => setLoading(false));
  }

  useEffect(load, [id]);

  function openPreview() {
    setPreviewHtml('');
    setPreviewError(null);
    setPreviewLoading(true);
    portalApiClient.get(`/invoices/${id}/preview`)
      .then((res) => setPreviewHtml(res.data.html))
      .catch((err) => setPreviewError(err.message || 'Failed to load preview.'))
      .finally(() => setPreviewLoading(false));
  }

  if (loading) return <LoadingState label="Loading invoice…" />;
  if (error) return <ErrorState message={error.status === 404 ? 'Invoice not found.' : error.message} onRetry={load} />;
  if (!invoice) return null;

  return (
    <div>
      <button onClick={() => navigate('/portal/invoices')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Invoices
      </button>
      <PageHeader
        title={invoice.invoice_number}
        subtitle={new Date(invoice.created_at).toLocaleString()}
        actions={
          <div style={{ display: 'flex', gap: '8px' }}>
            <Button variant="secondary" icon={Eye} onClick={openPreview}>Preview</Button>
            <Button variant="secondary" icon={Download} onClick={() => portalApiClient.downloadAuthorizedFile(`/invoices/${invoice.id}/document.docx`, `${invoice.invoice_number}.docx`)}>
              Download
            </Button>
          </div>
        }
      />
      <DetailGrid items={[
        { label: 'Total', value: `${invoice.currency} ${parseFloat(invoice.invoice_total).toFixed(2)}` },
        { label: 'Discount', value: `${invoice.currency} ${parseFloat(invoice.discount_amount).toFixed(2)}` },
        { label: 'Status', value: <StatusBadge status={invoice.status} /> },
        { label: 'Paid', value: `$${invoice.balance.paid.toFixed(2)}` },
        { label: 'Outstanding', value: `$${invoice.balance.outstanding.toFixed(2)}` },
      ]} />

      {previewHtml !== null && (
        <Card style={{ padding: '16px', marginTop: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <h3 style={{ margin: 0, fontSize: '14px' }}>Document Preview</h3>
            <button onClick={() => setPreviewHtml(null)} aria-label="Close preview" style={closeBtnStyle}><X size={16} /></button>
          </div>
          {previewLoading ? (
            <LoadingState label="Loading preview…" />
          ) : previewError ? (
            <ErrorState message={previewError} onRetry={openPreview} />
          ) : (
            <iframe
              title="Invoice preview"
              srcDoc={previewHtml}
              style={{ width: '100%', height: '520px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}
              sandbox=""
            />
          )}
        </Card>
      )}

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: '14px' }}>Payment History</h3>
        {invoice.payments.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>No payments recorded yet.</p>
        ) : (
          <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
            <tbody>
              {invoice.payments.map((p, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 0' }}>{p.currency} {parseFloat(p.amount).toFixed(2)}</td>
                  <td style={{ padding: '8px 0', textTransform: 'uppercase' }}>{p.method}</td>
                  <td style={{ padding: '8px 0' }}>{new Date(p.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};

const closeBtnStyle = {
  display: 'flex', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
};
