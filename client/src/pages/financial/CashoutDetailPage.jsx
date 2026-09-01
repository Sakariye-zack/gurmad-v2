import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Wallet2, Printer, Upload, CheckCircle2, XCircle, Ban, FileDown } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, ConfirmDialog, Modal, useToast, StatCard } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { apiClient } from '../../lib/apiClient.js';
import {
  useCashout, useApproveCashout, useRejectCashout, useVoidCashout, useUploadAttachment, useResolveShortage,
} from '../../hooks/useCashouts.js';

const STATUS_MAP = { pending: 'warning', approved: 'success', rejected: 'danger', voided: 'info' };
const DOC_TYPE_LABELS = {
  signed_cashout_form: 'Signed Cashout Form', deposit_slip: 'Deposit Slip', cash_handover_evidence: 'Cash Handover Evidence',
  receipt: 'Receipt', shortage_explanation: 'Shortage Explanation', approval_document: 'Approval Document', other: 'Other Supporting Document',
};

export default function CashoutDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useCashout(id);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const approveMut = useApproveCashout(id);
  const rejectMut = useRejectCashout(id);
  const voidMut = useVoidCashout(id);
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const cashout = data?.data;

  if (isLoading) return <LoadingState label="Loading cashout…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!cashout) return null;

  async function handleDownloadDocx() {
    setDownloading(true);
    try {
      await apiClient.downloadAuthorizedFile(`/v2/cashouts/${id}/document.docx`, `${cashout.cashout_number}.docx`);
    } catch (err) {
      toast.error(err.message || 'Failed to download document.');
    } finally {
      setDownloading(false);
    }
  }

  async function handleApprove() {
    try { await approveMut.mutateAsync(); toast.success('Cashout approved.'); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }
  async function handleReject(reason) {
    try { await rejectMut.mutateAsync(reason); toast.success('Cashout rejected.'); setRejectOpen(false); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }
  async function handleVoid(reason) {
    try { await voidMut.mutateAsync(reason); toast.success('Cashout voided.'); setVoidOpen(false); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }
  function handlePrint() {
    window.print();
  }

  const recon = cashout.reconciliation || {};

  return (
    <div>
      {/* Print isolation: hide everything except the document region when
          printing/exporting to PDF. Browser "Print to PDF" is the Download
          PDF mechanism (a deliberate technical choice — see Implementation
          Report §4 — not a new server-side PDF-generation dependency). */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .cashout-print-document, .cashout-print-document * { visibility: visible; }
          .cashout-print-document { position: absolute; left: 0; top: 0; width: 100%; padding: 24px; color: #000; background: #fff; }
          .cashout-print-document .doc-hairline { border-color: #000 !important; }
        }
      `}</style>

      <button onClick={() => navigate('/financial/cashouts')} style={backLinkStyle} className="no-print">
        <ArrowLeft size={14} /> Back to Cashouts
      </button>

      <PageHeader
        icon={Wallet2}
        title={cashout.cashout_number}
        subtitle={`${cashout.zone_name} · ${new Date(cashout.period_start).toLocaleDateString()} – ${new Date(cashout.period_end).toLocaleDateString()}`}
        actions={
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <Button variant="secondary" icon={Printer} onClick={handlePrint}>Print / Download PDF</Button>
            <Button variant="secondary" icon={FileDown} onClick={handleDownloadDocx} disabled={downloading}>{downloading ? 'Preparing…' : 'Download Word (.docx)'}</Button>
            <RoleGate roles={['admin', 'head_of_cashiers']}>
              <Button variant="secondary" icon={Upload} onClick={() => setUploadOpen(true)}>Upload Signed Copy</Button>
            </RoleGate>
            {cashout.status === 'pending' && (
              <RoleGate roles={['admin', 'gudoomiye']}>
                <Button variant="secondary" icon={CheckCircle2} onClick={handleApprove} disabled={approveMut.isPending}>Approve</Button>
                <Button variant="danger" icon={XCircle} onClick={() => setRejectOpen(true)}>Reject</Button>
              </RoleGate>
            )}
            {cashout.status !== 'approved' && cashout.status !== 'voided' && (
              <RoleGate roles={['admin']}>
                <Button variant="danger" icon={Ban} onClick={() => setVoidOpen(true)}>Void</Button>
              </RoleGate>
            )}
          </div>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px', marginBottom: '20px' }} className="no-print">
        <StatCard label="Status" value={<StatusBadge status={cashout.status} map={STATUS_MAP} />} />
        <StatCard label="Expected" value={`$${parseFloat(cashout.expected_amount).toFixed(2)}`} />
        <StatCard label="Actual" value={`$${parseFloat(cashout.actual_amount).toFixed(2)}`} />
        <StatCard label="Shortage" value={`$${parseFloat(cashout.shortage).toFixed(2)}`} accent={parseFloat(cashout.shortage) > 0 ? 'var(--danger)' : 'var(--success)'} />
        <StatCard label="Surplus" value={`$${parseFloat(cashout.surplus).toFixed(2)}`} accent={parseFloat(cashout.surplus) > 0 ? 'var(--info)' : 'var(--success)'} />
      </div>

      {/* ============ OFFICIAL CASHOUT DOCUMENT ============ */}
      <Card className="cashout-print-document" style={{ padding: '28px', marginBottom: '20px' }}>
        {/* 1. Document Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid var(--brand)', paddingBottom: '16px', marginBottom: '16px' }} className="doc-hairline">
          <div>
            <div style={{ fontSize: '20px', fontWeight: 900, color: 'var(--brand)' }}>GURMAD</div>
            <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '2px' }}>Cashout &amp; Cash Reconciliation</div>
          </div>
          <div style={{ textAlign: 'right', fontSize: '12px' }}>
            <div><strong>Cashout No.</strong> {cashout.cashout_number}</div>
            <div><strong>Date</strong> {new Date(cashout.created_at).toLocaleDateString()}</div>
            <div><strong>Time</strong> {new Date(cashout.created_at).toLocaleTimeString()}</div>
            <div><strong>Zone</strong> {cashout.zone_name}</div>
          </div>
        </div>

        {/* 2. Collection Summary */}
        <DocSection title="Collection Summary">
          <DetailGrid items={[
            { label: 'Customers', value: recon.customerCount ?? '—', className: 'tabular-nums' },
            { label: 'Transactions', value: recon.transactionCount ?? '—', className: 'tabular-nums' },
            { label: 'Expected Amount', value: `$${parseFloat(cashout.expected_amount).toFixed(2)}`, className: 'tabular-nums' },
            { label: 'Amount Being Cashed Out', value: `$${parseFloat(cashout.actual_amount).toFixed(2)}`, className: 'tabular-nums' },
            { label: 'Currency', value: 'USD' },
          ]} />
        </DocSection>

        {/* 3. Collection Source Breakdown */}
        <DocSection title="Collection Source Breakdown">
          {(recon.sourceBreakdown || []).length === 0 && <EmptyLine text="No linked collection events in this period." />}
          {(recon.sourceBreakdown || []).map((s) => (
            <BreakdownRow key={s.source} label={s.source === 'unlinked' ? 'Not linked to a collection event' : `${s.source.charAt(0).toUpperCase()}${s.source.slice(1)} collections`} value={s.total} />
          ))}
        </DocSection>

        {/* 4. Payment Method Breakdown */}
        <DocSection title="Payment Method Breakdown">
          {(recon.methodBreakdown || []).length === 0 && <EmptyLine text="No recorded payments in this period." />}
          {(recon.methodBreakdown || []).map((m) => (
            <BreakdownRow key={m.method} label={m.method.toUpperCase()} value={m.total} />
          ))}
        </DocSection>

        {/* 5. Reconciliation */}
        <DocSection title="Reconciliation">
          <DetailGrid items={[
            { label: 'System Expected Amount', value: `$${parseFloat(cashout.expected_amount).toFixed(2)}`, className: 'tabular-nums' },
            { label: 'Physical/Received Amount', value: `$${parseFloat(cashout.actual_amount).toFixed(2)}`, className: 'tabular-nums' },
            { label: 'Difference', value: `$${Math.abs(parseFloat(cashout.expected_amount) - parseFloat(cashout.actual_amount)).toFixed(2)}`, className: 'tabular-nums' },
            { label: 'Difference Type', value: parseFloat(cashout.shortage) > 0 ? 'Shortage' : parseFloat(cashout.surplus) > 0 ? 'Surplus' : 'Exact Match' },
          ]} />
          {cashout.shortage_reason && <p style={{ margin: '10px 0 0', fontSize: '13px' }}><strong>Shortage reason:</strong> {cashout.shortage_reason}</p>}
          {cashout.remarks && <p style={{ margin: '6px 0 0', fontSize: '13px' }}><strong>Remarks:</strong> {cashout.remarks}</p>}
        </DocSection>

        {/* 6. Accountability */}
        <DocSection title="Accountability">
          <DetailGrid items={[
            { label: 'Cashier (User ID)', value: `#${cashout.cashier_id}` },
            { label: 'Head of Cashiers (User ID)', value: `#${cashout.head_of_cashiers_id}` },
            { label: 'Prepared by', value: `#${cashout.created_by}` },
            { label: 'Approved by', value: cashout.approved_by ? `#${cashout.approved_by}` : 'Not yet approved' },
          ]} />
        </DocSection>

        {/* 7. Signatures */}
        <DocSection title="Signatures">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px', marginTop: '10px' }}>
            <SignatureBlock label="Cashier Signature" />
            <SignatureBlock label="Head of Cashiers Signature" />
            <SignatureBlock label="Collector Acknowledgement" />
          </div>
        </DocSection>

        <div style={{ marginTop: '24px', paddingTop: '10px', borderTop: '1px solid var(--border)', fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }} className="doc-hairline">
          GURMAD Waste Management — System-generated Cashout document — {cashout.cashout_number}
        </div>
      </Card>
      {/* ============ END DOCUMENT ============ */}

      <div className="no-print">
        <span style={sectionLabelStyle}>Cashier Shortage</span>
        <Card style={{ padding: '16px', marginBottom: '20px' }}>
          {cashout.shortage_record ? (
            <ShortagePanel cashoutId={id} shortage={cashout.shortage_record} />
          ) : (
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>No shortage — nothing to reconcile.</p>
          )}
        </Card>

        {cashout.debt && (
          <>
            <span style={sectionLabelStyle}>Linked Customer Debt</span>
            <Card style={{ padding: '16px', marginBottom: '20px' }}>
              <p style={{ margin: '0 0 10px', fontSize: '12px', color: 'var(--text-muted)' }}>
                A genuine customer-owed debt independently associated with this cashout — separate from any cashier shortage above.
              </p>
              <DetailGrid items={[
                { label: 'Debt amount', value: `$${parseFloat(cashout.debt.amount).toFixed(2)}` },
                { label: 'Status', value: <StatusBadge status={cashout.debt.status} map={{ unpaid: 'danger', paid: 'success' }} /> },
              ]} />
            </Card>
          </>
        )}

        <span style={sectionLabelStyle}>Generated &amp; Signed Documents</span>
        <Card style={{ padding: '16px', marginBottom: '20px' }}>
          <p style={{ margin: '0 0 10px', fontSize: '13px', color: 'var(--text-muted)' }}>
            The system-generated document above (printable/exportable) is always preserved as-is. Uploaded signed copies never overwrite it — each upload is a new attachment below.
          </p>
        </Card>

        <span style={sectionLabelStyle}>Supporting Attachments</span>
        {(cashout.attachments || []).length === 0 && (
          <Card style={{ padding: '16px', marginBottom: '20px' }}><p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>No attachments uploaded yet.</p></Card>
        )}
        {(cashout.attachments || []).length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
            {cashout.attachments.map((a) => (
              <AttachmentRow key={a.id} attachment={a} cashoutId={id} />
            ))}
          </div>
        )}

        <span style={sectionLabelStyle}>Approval Timeline</span>
        <Card style={{ padding: '16px' }}>
          <DetailGrid items={[
            { label: 'Created', value: new Date(cashout.created_at).toLocaleString() },
            ...(cashout.approved_at ? [{ label: cashout.status === 'rejected' ? 'Rejected' : 'Approved', value: new Date(cashout.approved_at).toLocaleString() }] : []),
            ...(cashout.rejection_reason ? [{ label: 'Rejection reason', value: cashout.rejection_reason }] : []),
            ...(cashout.voided_at ? [{ label: 'Voided', value: new Date(cashout.voided_at).toLocaleString() }, { label: 'Void reason', value: cashout.voided_reason }] : []),
          ]} />
        </Card>
      </div>

      <ConfirmDialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onConfirm={() => handleReject(document.getElementById('reject-reason')?.value || '')}
        title="Reject this cashout?"
        message={<div><p style={{ margin: '0 0 8px' }}>A reason is required.</p><input id="reject-reason" placeholder="Reason for rejection" style={inputStyle} /></div>}
        confirmLabel="Reject"
        danger
        isLoading={rejectMut.isPending}
      />
      <ConfirmDialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        onConfirm={() => handleVoid(document.getElementById('void-reason')?.value || '')}
        title="Void this cashout?"
        message={<div><p style={{ margin: '0 0 8px' }}>Only allowed before approval — the record and its history are preserved. A reason is required.</p><input id="void-reason" placeholder="Reason for voiding" style={inputStyle} /></div>}
        confirmLabel="Void Cashout"
        danger
        isLoading={voidMut.isPending}
      />
      <UploadAttachmentModal open={uploadOpen} onClose={() => setUploadOpen(false)} cashoutId={id} />
    </div>
  );
}

function DocSection({ title, children }) {
  return (
    <div style={{ marginBottom: '18px' }}>
      <div style={{ fontSize: '12px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--brand)', marginBottom: '8px' }}>{title}</div>
      {children}
    </div>
  );
}
function BreakdownRow({ label, value }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '13px', borderBottom: '1px dashed var(--border)' }}>
      <span>{label}</span>
      <span className="tabular-nums" style={{ fontWeight: 700 }}>${value.toFixed(2)}</span>
    </div>
  );
}
function EmptyLine({ text }) {
  return <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{text}</span>;
}
function SignatureBlock({ label }) {
  return (
    <div>
      <div style={{ height: '48px', borderBottom: '1px solid var(--text)' }} />
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>{label}</div>
    </div>
  );
}

// Cashier Shortage — accountability/reconciliation liability, explicitly
// NOT a Customer Debt (architecture decision). Resolution is manual and
// audited only — no automatic recovery mechanism (salary deduction, auto-
// debt, etc.) is offered here.
function ShortagePanel({ cashoutId, shortage }) {
  const [resolveOpen, setResolveOpen] = useState(false);
  const resolveMut = useResolveShortage(cashoutId);
  const toast = useToast();

  async function handleResolve(resolvedAmount, notes) {
    try {
      await resolveMut.mutateAsync({ resolved_amount: parseFloat(resolvedAmount), resolution_notes: notes });
      toast.success('Shortage marked resolved.');
      setResolveOpen(false);
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    }
  }

  return (
    <>
      <DetailGrid items={[
        { label: 'Shortage Amount', value: `$${parseFloat(shortage.shortage_amount).toFixed(2)}` },
        { label: 'Cashier Responsible', value: `#${shortage.cashier_id}` },
        { label: 'Status', value: <StatusBadge status={shortage.status} map={{ unpaid: 'danger', paid: 'success' }} /> },
        { label: 'Reason', value: shortage.reason },
        ...(shortage.status === 'paid' ? [
          { label: 'Resolved Amount', value: `$${parseFloat(shortage.resolved_amount).toFixed(2)}` },
          { label: 'Resolved At', value: new Date(shortage.resolved_at).toLocaleString() },
          { label: 'Resolution Notes', value: shortage.resolution_notes },
        ] : []),
      ]} />
      {shortage.status === 'unpaid' && (
        <RoleGate roles={['admin', 'head_of_cashiers']}>
          <div style={{ marginTop: '12px' }}>
            <Button variant="secondary" onClick={() => setResolveOpen(true)}>Mark Resolved</Button>
          </div>
        </RoleGate>
      )}
      <Modal
        open={resolveOpen}
        onClose={() => setResolveOpen(false)}
        title="Resolve Cashier Shortage"
        footer={<>
          <Button variant="secondary" onClick={() => setResolveOpen(false)}>Cancel</Button>
          <Button onClick={() => handleResolve(document.getElementById('resolved-amount')?.value, document.getElementById('resolution-notes')?.value)} disabled={resolveMut.isPending}>
            {resolveMut.isPending ? 'Saving…' : 'Mark Resolved'}
          </Button>
        </>}
      >
        <p style={{ margin: '0 0 10px', fontSize: '13px', color: 'var(--text-muted)' }}>
          Record what was actually recovered from the cashier. This does not trigger any automatic payroll deduction or accounting entry — it only records the resolution.
        </p>
        <label style={{ display: 'block', marginBottom: '10px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>Amount recovered</span>
          <input id="resolved-amount" type="number" min="0" step="0.01" defaultValue={shortage.shortage_amount} style={inputStyle} />
        </label>
        <label style={{ display: 'block' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>Resolution notes (required)</span>
          <input id="resolution-notes" placeholder="e.g. Cashier repaid in cash on..." style={inputStyle} />
        </label>
      </Modal>
    </>
  );
}

function AttachmentRow({ attachment, cashoutId }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  async function handleView() {
    setLoading(true);
    try {
      const url = await apiClient.fetchAuthorizedFileUrl(`/v2/cashouts/${cashoutId}/attachments/${attachment.id}/file`);
      window.open(url, '_blank');
    } catch (err) {
      toast.error(err.message || 'Failed to open attachment.');
    } finally {
      setLoading(false);
    }
  }
  return (
    <Card style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <strong>{DOC_TYPE_LABELS[attachment.document_type] || attachment.document_type}</strong>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{attachment.original_filename} · {new Date(attachment.uploaded_at).toLocaleString()}</div>
      </div>
      <Button variant="secondary" onClick={handleView} disabled={loading}>{loading ? 'Loading…' : 'View'}</Button>
    </Card>
  );
}

function UploadAttachmentModal({ open, onClose, cashoutId }) {
  const [file, setFile] = useState(null);
  const [documentType, setDocumentType] = useState('signed_cashout_form');
  const [error, setError] = useState('');
  const uploadMut = useUploadAttachment(cashoutId);
  const toast = useToast();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!file) { setError('Choose a file first.'); return; }
    try {
      await uploadMut.mutateAsync({ file, documentType });
      toast.success('Attachment uploaded.');
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  if (!open) return null;
  return (
    <Modal
      open
      onClose={uploadMut.isPending ? () => {} : onClose}
      title="Upload Signed Copy / Supporting Document"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={uploadMut.isPending}>Cancel</Button>
        <Button type="submit" form="upload-form" disabled={uploadMut.isPending}>{uploadMut.isPending ? 'Uploading…' : 'Upload'}</Button>
      </>}
    >
      <form id="upload-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>PDF, JPG, or PNG only — a photo taken on a phone works. This never overwrites the system-generated document above.</span>
        <label style={fieldStyle}>
          <span style={labelStyle}>Document type</span>
          <select value={documentType} onChange={(e) => setDocumentType(e.target.value)} style={inputStyle}>
            {Object.entries(DOC_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>File</span>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" capture="environment" onChange={(e) => setFile(e.target.files?.[0] || null)} style={inputStyle} />
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
const sectionLabelStyle = {
  display: 'block', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--text-muted)', margin: '0 0 10px',
};
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit', marginTop: '4px',
};
