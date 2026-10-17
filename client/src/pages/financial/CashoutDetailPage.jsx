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
import { useI18n } from '../../i18n/I18nContext.jsx';

const STATUS_MAP = { pending: 'warning', approved: 'success', rejected: 'danger', voided: 'info' };
const DOC_TYPE_LABELS = {
  signed_cashout_form: 'Signed Cashout Form', deposit_slip: 'Deposit Slip', cash_handover_evidence: 'Cash Handover Evidence',
  receipt: 'Receipt', shortage_explanation: 'Shortage Explanation', approval_document: 'Approval Document', other: 'Other Supporting Document',
};

export default function CashoutDetailPage() {
  const { t } = useI18n();
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

  if (isLoading) return <LoadingState label={t('fin.loading_cashout')} />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!cashout) return null;

  async function handleDownloadDocx() {
    setDownloading(true);
    try {
      await apiClient.downloadAuthorizedFile(`/v2/cashouts/${id}/document.docx`, `${cashout.cashout_number}.docx`);
    } catch (err) {
      toast.error(err.message || t('fin.failed_to_download_document'));
    } finally {
      setDownloading(false);
    }
  }

  async function handleApprove() {
    try { await approveMut.mutateAsync(); toast.success(t('fin.cashout_approved')); }
    catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }
  async function handleReject(reason) {
    try { await rejectMut.mutateAsync(reason); toast.success(t('fin.cashout_rejected')); setRejectOpen(false); }
    catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }
  async function handleVoid(reason) {
    try { await voidMut.mutateAsync(reason); toast.success(t('fin.cashout_voided')); setVoidOpen(false); }
    catch (err) { toast.error(err.message || t('common.somethingWrong')); }
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
        <ArrowLeft size={14} /> {t('fin.back_to_cashouts')}
      </button>

      <PageHeader
        icon={Wallet2}
        title={cashout.cashout_number}
        subtitle={`${cashout.zone_name} · ${new Date(cashout.period_start).toLocaleDateString()} – ${new Date(cashout.period_end).toLocaleDateString()}`}
        actions={
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <Button variant="secondary" icon={Eye} onClick={handleOpenPreview}>{t('fin.preview_print')}</Button>
            <Button variant="secondary" icon={FileDown} onClick={handleDownloadDocx} disabled={downloading}>{downloading ? t('fin.preparing') : t('fin.download_word_docx')}</Button>
            <RoleGate roles={['admin', 'head_of_cashiers']}>
              <Button variant="secondary" icon={Upload} onClick={() => setUploadOpen(true)}>{t('fin.upload_signed_copy')}</Button>
            </RoleGate>
            {cashout.status === 'pending' && (
              <RoleGate roles={['admin', 'gudoomiye']}>
                <Button variant="secondary" icon={CheckCircle2} onClick={handleApprove} disabled={approveMut.isPending}>{t('fin.approve')}</Button>
                <Button variant="danger" icon={XCircle} onClick={() => setRejectOpen(true)}>{t('fin.reject')}</Button>
              </RoleGate>
            )}
            {cashout.status !== 'approved' && cashout.status !== 'voided' && (
              <RoleGate roles={['admin']}>
                <Button variant="danger" icon={Ban} onClick={() => setVoidOpen(true)}>{t('status.void')}</Button>
              </RoleGate>
            )}
          </div>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px', marginBottom: '20px' }} className="no-print">
        <StatCard label={t('common.status')} value={<StatusBadge status={cashout.status} map={STATUS_MAP} />} />
        <StatCard label={t('dash.expected')} value={`$${parseFloat(cashout.expected_amount).toFixed(2)}`} />
        <StatCard label={t('dash.actual')} value={`$${parseFloat(cashout.actual_amount).toFixed(2)}`} />
        <StatCard label={t('dash.shortage')} value={`$${parseFloat(cashout.shortage).toFixed(2)}`} accent={parseFloat(cashout.shortage) > 0 ? 'var(--danger)' : 'var(--success)'} />
        <StatCard label={t('dash.surplus')} value={`$${parseFloat(cashout.surplus).toFixed(2)}`} accent={parseFloat(cashout.surplus) > 0 ? 'var(--info)' : 'var(--success)'} />
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
        title={t('portal.invoice.docPreview')}
        maxWidth="820px"
        footer={<>
          <Button variant="secondary" onClick={() => setPreviewOpen(false)}>{t('common.close')}</Button>
          <Button icon={Printer} onClick={handlePrint}>{t('fin.print')}</Button>
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
      <Modal open={transactionsOpen} onClose={() => setTransactionsOpen(false)} title={t('fin.m.transactionsTitle', undefined, { number: cashout.cashout_number })}>
        <TransactionsList cashoutId={id} enabled={transactionsOpen} />
      </Modal>

      <div className="no-print">
        <span style={sectionLabelStyle}>{t('fin.cashier_shortage')}</span>
        <Card style={{ padding: '16px', marginBottom: '20px' }}>
          {cashout.shortage_record ? (
            <ShortagePanel cashoutId={id} shortage={cashout.shortage_record} cashierName={cashout.cashier_name} />
          ) : (
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>{t('fin.no_shortage_nothing_to_reconcile')}</p>
          )}
        </Card>

        {cashout.debt && (
          <>
            <span style={sectionLabelStyle}>{t('fin.linked_customer_debt')}</span>
            <Card style={{ padding: '16px', marginBottom: '20px' }}>
              <p style={{ margin: '0 0 10px', fontSize: '12px', color: 'var(--text-muted)' }}>
                {t('fin.a_genuine_customer_owed_debt')}
              </p>
              <DetailGrid items={[
                { label: t('fin.debt_amount'), value: `$${parseFloat(cashout.debt.amount).toFixed(2)}` },
                { label: t('common.status'), value: <StatusBadge status={cashout.debt.status} map={{ unpaid: 'danger', paid: 'success' }} /> },
              ]} />
            </Card>
          </>
        )}

        <span style={sectionLabelStyle}>{t('fin.generated_and_signed_documents')}</span>
        <Card style={{ padding: '16px', marginBottom: '20px' }}>
          <p style={{ margin: '0 0 10px', fontSize: '13px', color: 'var(--text-muted)' }}>
            {t('fin.the_system_generated_document_above')}
          </p>
        </Card>

        <span style={sectionLabelStyle}>{t('fin.supporting_attachments')}</span>
        {(cashout.attachments || []).length === 0 && (
          <Card style={{ padding: '16px', marginBottom: '20px' }}><p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>{t('fin.no_attachments_uploaded_yet')}</p></Card>
        )}
        {(cashout.attachments || []).length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
            {cashout.attachments.map((a) => (
              <AttachmentRow key={a.id} attachment={a} cashoutId={id} />
            ))}
          </div>
        )}

        <span style={sectionLabelStyle}>{t('fin.approval_timeline')}</span>
        <Card style={{ padding: '16px' }}>
          <DetailGrid items={[
            { label: t('fin.created'), value: new Date(cashout.created_at).toLocaleString() },
            ...(cashout.approved_at ? [{ label: cashout.status === 'rejected' ? t('status.rejected') : t('status.approved'), value: new Date(cashout.approved_at).toLocaleString() }] : []),
            ...(cashout.rejection_reason ? [{ label: t('fin.rejection_reason'), value: cashout.rejection_reason }] : []),
            ...(cashout.voided_at ? [{ label: t('status.voided'), value: new Date(cashout.voided_at).toLocaleString() }, { label: t('fin.void_reason'), value: cashout.voided_reason }] : []),
          ]} />
        </Card>
      </div>

      <ConfirmDialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        onConfirm={() => handleReject(document.getElementById('reject-reason')?.value || '')}
        title={t('fin.reject_this_cashout')}
        message={<div><p style={{ margin: '0 0 8px' }}>{t('fin.a_reason_is_required')}</p><input id="reject-reason" placeholder={t('fin.reason_for_rejection')} style={inputStyle} /></div>}
        confirmLabel={t('fin.reject')}
        danger
        isLoading={rejectMut.isPending}
      />
      <ConfirmDialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        onConfirm={() => handleVoid(document.getElementById('void-reason')?.value || '')}
        title={t('fin.void_this_cashout')}
        message={<div><p style={{ margin: '0 0 8px' }}>{t('fin.only_allowed_before_approval_the')}</p><input id="void-reason" placeholder={t('fin.reason_for_voiding')} style={inputStyle} /></div>}
        confirmLabel={t('fin.void_cashout')}
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
  const { t } = useI18n();
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
          <div style={{ fontSize: '14px', fontWeight: 700, marginTop: '2px', color: paperMode ? '#444' : 'var(--text-muted)' }}>{t('fin.cashout_and_cash_reconciliation')}</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: '12px', lineHeight: 1.7 }}>
          <div><strong>{t('fin.cashout_no')}</strong> {cashout.cashout_number}</div>
          <div><strong>{t('common.date')}</strong> {new Date(cashout.created_at).toLocaleDateString()}</div>
          <div><strong>{t('fin.time')}</strong> {new Date(cashout.created_at).toLocaleTimeString()}</div>
          <div><strong>{t('common.zone')}</strong> {cashout.zone_name}</div>
        </div>
      </div>

      {/* 2. Collection Summary */}
      <DocSection
        title={t('fin.collection_summary')}
        action={onViewTransactions && (
          <button onClick={onViewTransactions} className="no-print" style={linkButtonStyle}>
            <List size={12} /> {t('fin.view_transactions')}
          </button>
        )}
      >
        <DetailGrid items={[
          { label: t('nav.customers'), value: recon.customerCount ?? '—', className: 'tabular-nums' },
          { label: t('fin.transactions'), value: recon.transactionCount ?? '—', className: 'tabular-nums' },
          { label: t('fin.expected_amount'), value: `$${parseFloat(cashout.expected_amount).toFixed(2)}`, className: 'tabular-nums' },
          { label: t('fin.amount_being_cashed_out'), value: `$${parseFloat(cashout.actual_amount).toFixed(2)}`, className: 'tabular-nums' },
          { label: t('fin.currency'), value: 'USD' },
        ]} />
      </DocSection>

      {/* 3. Collection Source Breakdown */}
      <DocSection title={t('fin.collection_source_breakdown')}>
        {(recon.sourceBreakdown || []).length === 0 && <EmptyLine text="No linked collection events in this period." />}
        {(recon.sourceBreakdown || []).map((s, i) => (
          <BreakdownRow
            key={s.source}
            label={s.source === 'unlinked' ? t('fin.not_linked_to_a_collection') : t('fin.m.sourceCollections', undefined, { source: `${s.source.charAt(0).toUpperCase()}${s.source.slice(1)}` })}
            value={s.total}
            percent={(s.total / sourceTotal) * 100}
            swatchColor={SWATCH_COLORS[i % SWATCH_COLORS.length]}
          />
        ))}
      </DocSection>

      {/* 4. Payment Method Breakdown */}
      <DocSection title={t('fin.payment_method_breakdown')}>
        {(recon.methodBreakdown || []).length === 0 && <EmptyLine text="No recorded payments in this period." />}
        {(recon.methodBreakdown || []).map((m, i) => (
          <BreakdownRow key={m.method} label={m.method.toUpperCase()} value={m.total} percent={(m.total / methodTotal) * 100} swatchColor={SWATCH_COLORS[i % SWATCH_COLORS.length]} />
        ))}
      </DocSection>

      {/* 5. Reconciliation */}
      <DocSection title={t('fin.reconciliation')}>
        <DetailGrid items={[
          { label: t('fin.system_expected_amount'), value: `$${parseFloat(cashout.expected_amount).toFixed(2)}`, className: 'tabular-nums' },
          { label: t('fin.physical_received_amount'), value: `$${parseFloat(cashout.actual_amount).toFixed(2)}`, className: 'tabular-nums' },
          { label: t('fin.difference'), value: `$${diff.toFixed(2)}`, className: 'tabular-nums' },
          {
            label: t('fin.difference_type'),
            value: (
              <span style={{ fontWeight: 700, color: parseFloat(cashout.shortage) > 0 ? 'var(--danger)' : parseFloat(cashout.surplus) > 0 ? 'var(--info)' : 'var(--success)' }}>
                {parseFloat(cashout.shortage) > 0 ? t('dash.shortage') : parseFloat(cashout.surplus) > 0 ? t('dash.surplus') : t('fin.exact_match')}
              </span>
            ),
          },
        ]} />
        {cashout.shortage_reason && <p style={{ margin: '10px 0 0', fontSize: '13px' }}><strong>{t('fin.shortage_reason')}</strong> {cashout.shortage_reason}</p>}
        {cashout.remarks && <p style={{ margin: '6px 0 0', fontSize: '13px' }}><strong>{t('fin.remarks')}</strong> {cashout.remarks}</p>}
      </DocSection>

      {/* 6. Accountability — user-reported gap (Phase 10 Billing audit,
           continued sweep): every row here used to read as a bare
           numeric id ('#33'). The backend now joins each name; fall
           back to the id only if a user account was since deleted. */}
      <DocSection title={t('fin.accountability')}>
        <DetailGrid items={[
          { label: t('fin.cashier'), value: cashout.cashier_name || `#${cashout.cashier_id}` },
          { label: t('fin.head_of_cashiers'), value: cashout.head_of_cashiers_name || `#${cashout.head_of_cashiers_id}` },
          { label: t('fin.prepared_by'), value: cashout.created_by_name || `#${cashout.created_by}` },
          { label: t('fin.approved_by'), value: cashout.approved_by ? (cashout.approved_by_name || `#${cashout.approved_by}`) : t('fin.not_yet_approved') },
        ]} />
      </DocSection>

      {/* 7. Signatures */}
      <DocSection title={t('fin.signatures')}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px', marginTop: '10px' }}>
          <SignatureBlock label={t('fin.cashier_signature')} paperMode={paperMode} />
          <SignatureBlock label={t('fin.head_of_cashiers_signature')} paperMode={paperMode} />
          <SignatureBlock label={t('fin.collector_acknowledgement')} paperMode={paperMode} />
        </div>
      </DocSection>

      <div style={{ marginTop: '24px', paddingTop: '10px', borderTop: '1px solid var(--border)', fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }} className="doc-hairline">
        {companyName} — {t('fin.m.systemDoc')} — {cashout.cashout_number}
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
  const { t } = useI18n();
  const { data, isLoading, error } = useCashoutTransactions(cashoutId, enabled);
  const rows = data?.data || [];
  if (isLoading) return <LoadingState label={t('fin.loading_transactions')} />;
  if (error) return <p style={{ color: 'var(--danger)', fontSize: '13px' }}>{error.message}</p>;
  if (rows.length === 0) return <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>{t('fin.no_transactions_recorded_in_this')}</p>;
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
  const { t } = useI18n();
  const [resolveOpen, setResolveOpen] = useState(false);
  const resolveMut = useResolveShortage(cashoutId);
  const toast = useToast();

  async function handleResolve(resolvedAmount, notes) {
    try {
      await resolveMut.mutateAsync({ resolved_amount: parseFloat(resolvedAmount), resolution_notes: notes });
      toast.success(t('fin.shortage_marked_resolved'));
      setResolveOpen(false);
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <>
      <DetailGrid items={[
        { label: t('fin.shortage_amount'), value: `$${parseFloat(shortage.shortage_amount).toFixed(2)}` },
        { label: t('fin.cashier_responsible'), value: cashierName || `#${shortage.cashier_id}` },
        { label: t('common.status'), value: <StatusBadge status={shortage.status} map={{ unpaid: 'danger', paid: 'success' }} /> },
        { label: t('common.reason'), value: shortage.reason },
        ...(shortage.status === 'paid' ? [
          { label: t('fin.resolved_amount'), value: `$${parseFloat(shortage.resolved_amount).toFixed(2)}` },
          { label: t('fin.resolved_at'), value: new Date(shortage.resolved_at).toLocaleString() },
          { label: t('fin.resolution_notes'), value: shortage.resolution_notes },
        ] : []),
      ]} />
      {shortage.status === 'unpaid' && (
        <RoleGate roles={['admin', 'head_of_cashiers']}>
          <div style={{ marginTop: '12px' }}>
            <Button variant="secondary" onClick={() => setResolveOpen(true)}>{t('fin.mark_resolved')}</Button>
          </div>
        </RoleGate>
      )}
      <Modal
        open={resolveOpen}
        onClose={() => setResolveOpen(false)}
        title={t('fin.resolve_cashier_shortage')}
        footer={<>
          <Button variant="secondary" onClick={() => setResolveOpen(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => handleResolve(document.getElementById('resolved-amount')?.value, document.getElementById('resolution-notes')?.value)} disabled={resolveMut.isPending}>
            {resolveMut.isPending ? t('common.saving') : t('fin.mark_resolved')}
          </Button>
        </>}
      >
        <p style={{ margin: '0 0 10px', fontSize: '13px', color: 'var(--text-muted)' }}>
          {t('fin.record_what_was_actually_recovered')}
        </p>
        <label style={{ display: 'block', marginBottom: '10px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('fin.amount_recovered')}</span>
          <input id="resolved-amount" type="number" min="0" step="0.01" defaultValue={shortage.shortage_amount} style={inputStyle} />
        </label>
        <label style={{ display: 'block' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('fin.resolution_notes_required')}</span>
          <input id="resolution-notes" placeholder={t('fin.e_g_cashier_repaid_in')} style={inputStyle} />
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
  const { t } = useI18n();
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
      toast.error(err.message || t('fin.failed_to_open_attachment'));
    } finally {
      setLoading(false);
    }
  }
  async function handleVoid(reason) {
    try {
      await voidMut.mutateAsync({ attachmentId: attachment.id, reason });
      toast.success(t('fin.attachment_removed'));
      setVoidOpen(false);
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <>
      <Card style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong>{t('fin.doc.' + attachment.document_type, DOC_TYPE_LABELS[attachment.document_type] || attachment.document_type)}</strong>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{attachment.original_filename} · {new Date(attachment.uploaded_at).toLocaleString()}</div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Button variant="secondary" onClick={handleView} disabled={loading}>{loading ? t('common.loading') : t('fin.view')}</Button>
          <RoleGate roles={['admin']}>
            <Button variant="danger" icon={Trash2} onClick={() => setVoidOpen(true)}>{t('fin.remove')}</Button>
          </RoleGate>
        </div>
      </Card>
      <ConfirmDialog
        open={voidOpen}
        onClose={() => setVoidOpen(false)}
        onConfirm={() => handleVoid(document.getElementById(`void-attachment-reason-${attachment.id}`)?.value || '')}
        title={t('fin.remove_this_attachment')}
        message={<div>
          <p style={{ margin: '0 0 8px' }}>
            {t('fin.the_file_itself_is_preserved')}
          </p>
          <input id={`void-attachment-reason-${attachment.id}`} placeholder={t('fin.reason_for_removal')} style={inputStyle} />
        </div>}
        confirmLabel={t('fin.remove')}
        danger
        isLoading={voidMut.isPending}
      />
    </>
  );
}

function UploadAttachmentModal({ open, onClose, cashoutId }) {
  const { t } = useI18n();
  const [file, setFile] = useState(null);
  const [documentType, setDocumentType] = useState('signed_cashout_form');
  const [error, setError] = useState('');
  const uploadMut = useUploadAttachment(cashoutId);
  const toast = useToast();

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!file) { setError(t('fin.choose_a_file_first')); return; }
    try {
      await uploadMut.mutateAsync({ file, documentType });
      toast.success(t('fin.attachment_uploaded'));
      onClose();
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  if (!open) return null;
  return (
    <Modal
      open
      onClose={uploadMut.isPending ? () => {} : onClose}
      title={t('fin.upload_signed_copy_supporting_docume')}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={uploadMut.isPending}>{t('common.cancel')}</Button>
        <Button type="submit" form="upload-form" disabled={uploadMut.isPending}>{uploadMut.isPending ? t('topbar.uploading') : t('fin.upload')}</Button>
      </>}
    >
      <form id="upload-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('fin.pdf_jpg_or_png_only')}</span>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('fin.document_type')}</span>
          <select value={documentType} onChange={(e) => setDocumentType(e.target.value)} style={inputStyle}>
            {Object.entries(DOC_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{t('fin.doc.' + k, v)}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('fin.file')}</span>
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
