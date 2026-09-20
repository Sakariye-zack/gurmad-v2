import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Wallet2, Printer, Upload, CheckCircle2, XCircle, Ban, FileDown, Eye, List, Trash2 } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, ConfirmDialog, Modal, useToast, StatCard } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { apiClient } from '../../lib/apiClient.js';
import {
  useCashout, useApproveCashout, useRejectCashout, useVoidCashout, useUploadAttachment, useResolveShortage, useVoidAttachment,
  useCashoutTransactions,
} from '../../hooks/useCashouts.js';
import { useCompanyName } from '../../hooks/useSettings.js';

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
  // User-requested (Phase 10 — 'iga qurxi... priviewna iigu soo dar'):
  // 'Print / Download PDF' previously went straight to the browser's
  // print dialog with no chance to look the document over first.
  const [previewOpen, setPreviewOpen] = useState(false);
  // User-requested ('meelahan sawirka labad ku jirana ku wada link
  // garee' — link the Collection Summary / breakdown sections): they're
  // category totals, not individually-linkable entities, so 'link' means
  // a real drill-down into the payment rows that back those numbers.
  const [transactionsOpen, setTransactionsOpen] = useState(false);
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
  function handleOpenPreview() {
    setPreviewOpen(true);
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
            <Button variant="secondary" icon={Eye} onClick={handleOpenPreview}>Preview / Print</Button>
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
      <CashoutDocument cashout={cashout} recon={recon} className="cashout-print-document" onViewTransactions={() => setTransactionsOpen(true)} />
      {/* ============ END DOCUMENT ============ */}

      {/* Print Preview — user-requested ('priviewna iigu soo dar'): a
          look-before-you-print step. Renders the SAME document a second
          time, styled as a page on a neutral backdrop; deliberately
          lacks the 'cashout-print-document' class so it never competes
          with the real one for @media print visibility — clicking Print
          in here still prints only the original, correctly-scoped copy. */}
      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="Document Preview"
        maxWidth="820px"
        footer={<>
          <Button variant="secondary" onClick={() => setPreviewOpen(false)}>Close</Button>
          <Button icon={Printer} onClick={handlePrint}>Print</Button>
        </>}
      >
        <div style={{ background: 'var(--bg)', padding: '20px', borderRadius: 'var(--radius-md)', maxHeight: '65vh', overflowY: 'auto' }}>
          <CashoutDocument cashout={cashout} recon={recon} paperMode />
        </div>
      </Modal>

      {/* Transactions drill-down — user-requested ('link garee' the
          Collection Summary / breakdown sections): those are category
          totals, not individually-linkable entities, so 'link' means the
          real payment rows that back them. */}
      <Modal open={transactionsOpen} onClose={() => setTransactionsOpen(false)} title={`Transactions — ${cashout.cashout_number}`}>
        <TransactionsList cashoutId={id} enabled={transactionsOpen} />
      </Modal>

      <div className="no-print">
        <span style={sectionLabelStyle}>Cashier Shortage</span>
        <Card style={{ padding: '16px', marginBottom: '20px' }}>
          {cashout.shortage_record ? (
            <ShortagePanel cashoutId={id} shortage={cashout.shortage_record} cashierName={cashout.cashier_name} />
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

// The official document itself — extracted (Phase 10, 'iga qurxi...
// priviewna iigu soo dar') so the exact same markup can render twice:
// once on the page (class="cashout-print-document", the only copy
// @media print ever shows) and once inside the Preview modal
// (`paperMode`, a plain visual duplicate with no print class — see the
// modal's own comment for why that never causes a double-print).
const STATUS_RIBBON_COLOR = { pending: 'var(--warning)', approved: 'var(--success)', rejected: 'var(--danger)', voided: 'var(--text-muted)' };
function CashoutDocument({ cashout, recon, className, onViewTransactions, paperMode }) {
  // System name — user-requested ('meel kasta oo magaca system ku ka soo
  // muuqanayo waa in aan markan update gareeyo'): this printed/PDF
  // document's own letterhead + footer previously hardcoded 'GURMAD'.
  const { data: companyNameData } = useCompanyName();
  const companyName = companyNameData?.data?.company_name || 'GURMAD';
  const diff = Math.abs(parseFloat(cashout.expected_amount) - parseFloat(cashout.actual_amount));
  const sourceTotal = (recon.sourceBreakdown || []).reduce((s, r) => s + r.total, 0) || 1;
  const methodTotal = (recon.methodBreakdown || []).reduce((s, r) => s + r.total, 0) || 1;
  // paperMode redefines the theme tokens themselves (this app's own
  // documented light-theme values — tokens.css's own light :root block),
  // not literal colors on just the outer Card. Every nested component
  // here (DetailGrid, StatusBadge, ...) styles itself purely through
  // var(--surface)/var(--text)/var(--border), each with its OWN inner
  // Card/box — a literal color/background on only the outer wrapper left
  // every nested box still resolving the app's live (dark-by-default)
  // theme, invisible text on a mismatched dark box inside a white page.
  // Redefining the variables at this ancestor makes the whole subtree
  // consistently light, the way a real printed page always is.
  const doc = (
    <Card
      className={className}
      style={{
        padding: '32px', marginBottom: paperMode ? 0 : '20px', position: 'relative', overflow: 'hidden',
        ...(paperMode ? { maxWidth: '760px', margin: '0 auto', boxShadow: '0 8px 30px rgba(0,0,0,0.25)' } : {}),
      }}
    >
      {/* Status ribbon — a real reconciliation document should announce
          its own state at a glance, the way a paper stamp would; before
          this, status only existed in the StatCard row above (hidden
          when printed via .no-print), so a printed/downloaded copy
          carried no status at all. */}
      <div
        className="doc-hairline"
        style={{
          position: 'absolute', top: '16px', right: '-42px', width: '170px', textAlign: 'center',
          transform: 'rotate(45deg)', background: STATUS_RIBBON_COLOR[cashout.status] || 'var(--text-muted)',
          color: '#fff', fontSize: '11px', fontWeight: 800, letterSpacing: '0.08em', padding: '5px 0',
          textTransform: 'uppercase', boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
        }}
      >
        {cashout.status}
      </div>

      {/* 1. Document Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid var(--brand)', paddingBottom: '16px', marginBottom: '20px' }} className="doc-hairline">
        <div>
          <div style={{ fontSize: '22px', fontWeight: 900, color: 'var(--brand)', letterSpacing: '-0.01em' }}>{companyName}</div>
          <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '2px', color: paperMode ? '#444' : 'var(--text-muted)' }}>Cashout &amp; Cash Reconciliation</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: '12px', lineHeight: 1.7 }}>
          <div><strong>Cashout No.</strong> {cashout.cashout_number}</div>
          <div><strong>Date</strong> {new Date(cashout.created_at).toLocaleDateString()}</div>
          <div><strong>Time</strong> {new Date(cashout.created_at).toLocaleTimeString()}</div>
          <div><strong>Zone</strong> {cashout.zone_name}</div>
        </div>
      </div>

      {/* 2. Collection Summary */}
      <DocSection
        title="Collection Summary"
        action={onViewTransactions && (
          <button onClick={onViewTransactions} className="no-print" style={linkButtonStyle}>
            <List size={12} /> View Transactions
          </button>
        )}
      >
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
        {(recon.sourceBreakdown || []).map((s, i) => (
          <BreakdownRow
            key={s.source}
            label={s.source === 'unlinked' ? 'Not linked to a collection event' : `${s.source.charAt(0).toUpperCase()}${s.source.slice(1)} collections`}
            value={s.total}
            percent={(s.total / sourceTotal) * 100}
            swatchColor={SWATCH_COLORS[i % SWATCH_COLORS.length]}
          />
        ))}
      </DocSection>

      {/* 4. Payment Method Breakdown */}
      <DocSection title="Payment Method Breakdown">
        {(recon.methodBreakdown || []).length === 0 && <EmptyLine text="No recorded payments in this period." />}
        {(recon.methodBreakdown || []).map((m, i) => (
          <BreakdownRow key={m.method} label={m.method.toUpperCase()} value={m.total} percent={(m.total / methodTotal) * 100} swatchColor={SWATCH_COLORS[i % SWATCH_COLORS.length]} />
        ))}
      </DocSection>

      {/* 5. Reconciliation */}
      <DocSection title="Reconciliation">
        <DetailGrid items={[
          { label: 'System Expected Amount', value: `$${parseFloat(cashout.expected_amount).toFixed(2)}`, className: 'tabular-nums' },
          { label: 'Physical/Received Amount', value: `$${parseFloat(cashout.actual_amount).toFixed(2)}`, className: 'tabular-nums' },
          { label: 'Difference', value: `$${diff.toFixed(2)}`, className: 'tabular-nums' },
          {
            label: 'Difference Type',
            value: (
              <span style={{ fontWeight: 700, color: parseFloat(cashout.shortage) > 0 ? 'var(--danger)' : parseFloat(cashout.surplus) > 0 ? 'var(--info)' : 'var(--success)' }}>
                {parseFloat(cashout.shortage) > 0 ? 'Shortage' : parseFloat(cashout.surplus) > 0 ? 'Surplus' : 'Exact Match'}
              </span>
            ),
          },
        ]} />
        {cashout.shortage_reason && <p style={{ margin: '10px 0 0', fontSize: '13px' }}><strong>Shortage reason:</strong> {cashout.shortage_reason}</p>}
        {cashout.remarks && <p style={{ margin: '6px 0 0', fontSize: '13px' }}><strong>Remarks:</strong> {cashout.remarks}</p>}
      </DocSection>

      {/* 6. Accountability — user-reported gap (Phase 10 Billing audit,
           continued sweep): every row here used to read as a bare
           numeric id ('#33'). The backend now joins each name; fall
           back to the id only if a user account was since deleted. */}
      <DocSection title="Accountability">
        <DetailGrid items={[
          { label: 'Cashier', value: cashout.cashier_name || `#${cashout.cashier_id}` },
          { label: 'Head of Cashiers', value: cashout.head_of_cashiers_name || `#${cashout.head_of_cashiers_id}` },
          { label: 'Prepared by', value: cashout.created_by_name || `#${cashout.created_by}` },
          { label: 'Approved by', value: cashout.approved_by ? (cashout.approved_by_name || `#${cashout.approved_by}`) : 'Not yet approved' },
        ]} />
      </DocSection>

      {/* 7. Signatures */}
      <DocSection title="Signatures">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px', marginTop: '10px' }}>
          <SignatureBlock label="Cashier Signature" paperMode={paperMode} />
          <SignatureBlock label="Head of Cashiers Signature" paperMode={paperMode} />
          <SignatureBlock label="Collector Acknowledgement" paperMode={paperMode} />
        </div>
      </DocSection>

      <div style={{ marginTop: '24px', paddingTop: '10px', borderTop: '1px solid var(--border)', fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }} className="doc-hairline">
        {companyName} — System-generated Cashout document — {cashout.cashout_number}
      </div>
    </Card>
  );
  if (!paperMode) return doc;
  // Light-theme token values, verbatim from tokens.css's own :root block
  // — the same palette the rest of this app already uses in light mode,
  // not a one-off invented for this page.
  return (
    <div style={{
      '--bg': '#f4f8f0', '--surface': '#ffffff', '--border': '#dde5d6', '--text': '#1c231d', '--text-muted': '#5b6358',
      '--success': '#4caf3f', '--success-bg': '#e6f5e2', '--warning': '#d6870f', '--warning-bg': '#fbf0dd',
      '--danger': '#b23a3a', '--danger-bg': '#fbe9e7', '--info': '#2563a8', '--info-bg': '#e5eefa',
      color: 'var(--text)',
    }}>
      {doc}
    </div>
  );
}
const SWATCH_COLORS = ['var(--brand)', 'var(--info)', 'var(--warning)', 'var(--success)', 'var(--danger)'];
const linkButtonStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none',
  color: 'var(--brand)', fontSize: '11px', fontWeight: 700, cursor: 'pointer', padding: 0,
};

function TransactionsList({ cashoutId, enabled }) {
  const { data, isLoading, error } = useCashoutTransactions(cashoutId, enabled);
  const rows = data?.data || [];
  if (isLoading) return <LoadingState label="Loading transactions…" />;
  if (error) return <p style={{ color: 'var(--danger)', fontSize: '13px' }}>{error.message}</p>;
  if (rows.length === 0) return <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>No transactions recorded in this period.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '50vh', overflowY: 'auto' }}>
      {rows.map((r) => (
        <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: '13px' }}>{r.invoice_number} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>— {r.customer_name} ({r.customer_number})</span></div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{new Date(r.created_at).toLocaleString()} · <span style={{ textTransform: 'uppercase' }}>{r.method}</span></div>
          </div>
          <div className="tabular-nums" style={{ fontWeight: 800 }}>{r.currency} {parseFloat(r.amount).toFixed(2)}</div>
        </div>
      ))}
    </div>
  );
}

function DocSection({ title, action, children }) {
  return (
    <div style={{ marginBottom: '18px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ fontSize: '12px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--brand)' }}>{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}
// swatchColor/percent (Phase 10, 'iga qurxi') — a bare number-only row
// read as a raw data dump, not a real reconciliation document. A small
// color swatch (matching CashoutDocument's SWATCH_COLORS) plus a
// proportional fill bar makes each category's share of the total legible
// at a glance, the way an actual accounting breakdown table would.
function BreakdownRow({ label, value, percent, swatchColor }) {
  return (
    <div style={{ padding: '6px 0', borderBottom: '1px dashed var(--border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
          {swatchColor && <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: swatchColor, flexShrink: 0 }} />}
          {label}
        </span>
        <span className="tabular-nums" style={{ fontWeight: 700 }}>${value.toFixed(2)}</span>
      </div>
      {percent != null && (
        <div style={{ height: '3px', borderRadius: '2px', background: 'var(--border)', marginTop: '5px', overflow: 'hidden' }}>
          <div style={{ height: '100%', width: `${Math.min(100, percent)}%`, background: swatchColor || 'var(--brand)' }} />
        </div>
      )}
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
function ShortagePanel({ cashoutId, shortage, cashierName }) {
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
        { label: 'Cashier Responsible', value: cashierName || `#${shortage.cashier_id}` },
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

// User-requested gap-audit sweep ('gabis kale... iga baadh iyo wax iga
// dhiman'): useVoidAttachment() already existed in useCashouts.js, fully
// wired to the backend (DELETE .../attachments/:attachmentId, admin-only
// — it VOIDS, never hard-deletes: voided_at/voided_by/voided_reason set,
// the row and its file are preserved), but nothing here ever called it —
// a wrongly-uploaded or duplicate attachment had no way to be removed
// from view at all.
function AttachmentRow({ attachment, cashoutId }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const voidMut = useVoidAttachment(cashoutId);

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
  async function handleVoid(reason) {
    try {
      await voidMut.mutateAsync({ attachmentId: attachment.id, reason });
      toast.success('Attachment removed.');
      setVoidOpen(false);
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    }
  }

  return (
    <>
      <Card style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong>{DOC_TYPE_LABELS[attachment.document_type] || attachment.document_type}</strong>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{attachment.original_filename} · {new Date(attachment.uploaded_at).toLocaleString()}</div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button variant="secondary" onClick={handleView} disabled={loading}>{loading ? 'Loading…' : 'View'}</Button>
          <RoleGate roles={['admin']}>
            <Button variant="danger" icon={Trash2} onClick={() => setVoidOpen(true)}>Remove</Button>
          </RoleGate>
        </div>
      </Card>
      <ConfirmDialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        onConfirm={() => handleVoid(document.getElementById(`void-attachment-reason-${attachment.id}`)?.value || '')}
        title="Remove this attachment?"
        message={<div>
          <p style={{ margin: '0 0 8px' }}>
            The file itself is preserved (voided, not deleted) — it stops showing here and in the document count. A reason is required.
          </p>
          <input id={`void-attachment-reason-${attachment.id}`} placeholder="Reason for removal" style={inputStyle} />
        </div>}
        confirmLabel="Remove"
        danger
        isLoading={voidMut.isPending}
      />
    </>
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
