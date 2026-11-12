import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Wallet2, Printer, Upload, CheckCircle2, XCircle, Ban, FileDown, Eye, List, Trash2, Landmark, ShieldCheck,
  Check, X, AlertTriangle, Coins, History, Users, Paperclip, Scale,
} from 'lucide-react';
import { Button, LoadingState, ErrorState, ConfirmDialog, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { apiClient } from '../../lib/apiClient.js';
import {
  useCashout, useApproveCashout, useRejectCashout, useVoidCashout, useUploadAttachment, useResolveShortage, useVoidAttachment,
  useCashoutTransactions, useCashoutMeta, useRecordDeposit, useChangeDeposit,
} from '../../hooks/useCashouts.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { fmtDate, fmtDateTime } from './financeUtils.js';
import { CURRENCIES, METHODS, fmtMoney, fmtDiff, fmtPair, varianceOf } from './cashoutUtils.js';
import { StatusChip, DepositChip, VarianceChip, NeedsAdminChip, Person, Chip } from './CashoutBits.jsx';
import CashoutDocument from './CashoutDocument.jsx';
import CashoutAssignmentCard from './CashoutAssignmentCard.jsx';
import './cashout.css';

const DOC_TYPE_LABELS = {
  signed_cashout_form: 'Signed Cashout Form', deposit_slip: 'Deposit Slip', cash_handover_evidence: 'Cash Handover Evidence',
  receipt: 'Receipt', shortage_explanation: 'Shortage Explanation', approval_document: 'Approval Document', other: 'Other Supporting Document',
  merchant_statement: 'Merchant Statement',
};

export default function CashoutDetailPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const toast = useToast();
  const { data, isLoading, error, refetch } = useCashout(id);
  const approveMut = useApproveCashout(id);
  const rejectMut = useRejectCashout(id);
  const voidMut = useVoidCashout(id);
  const [modal, setModal] = useState(null); // reject | void | upload | statement | preview | transactions | deposit | resolve
  const [reason, setReason] = useState('');
  const [downloading, setDownloading] = useState(false);
  const cashout = data?.data;

  if (isLoading) return <LoadingState label={t('fin.loading_cashout')} />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!cashout) return null;

  const role = (user?.role || '').toLowerCase();
  const isAdmin = role === 'admin';
  const canPrepare = isAdmin || role === 'head_of_cashiers';
  const hasSigned = (cashout.attachments || []).some((a) => a.document_type === 'signed_cashout_form');
  const v = varianceOf(cashout);
  const open = (m) => { setReason(''); setModal(m); };

  // Why the approve button would be refused — shown before the user tries.
  const blockers = [];
  if (cashout.status === 'pending') {
    if (!hasSigned) blockers.push(t('co2.blk.signed'));
    if (cashout.needs_admin && !isAdmin) blockers.push(t('co2.blk.admin'));
    if (user && (cashout.created_by === user.id || cashout.head_of_cashiers_id === user.id)) blockers.push(t('co2.blk.preparer'));
    if (user && cashout.cashier_id === user.id) blockers.push(t('co2.blk.cashier'));
  }

  async function handleDownloadDocx() {
    setDownloading(true);
    try { await apiClient.downloadAuthorizedFile(`/v2/cashouts/${id}/document.docx`, `${cashout.cashout_number}.docx`); }
    catch (err) { toast.error(err.message || t('fin.failed_to_download_document')); }
    finally { setDownloading(false); }
  }
  async function handleApprove() {
    try { await approveMut.mutateAsync(); toast.success(t('fin.cashout_approved')); }
    catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }
  async function handleReject() {
    if (!reason.trim()) { toast.error(t('fin.a_reason_is_required')); return; }
    try { await rejectMut.mutateAsync(reason.trim()); toast.success(t('fin.cashout_rejected')); setModal(null); }
    catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }
  async function handleVoid() {
    if (!reason.trim()) { toast.error(t('fin.a_reason_is_required')); return; }
    try { await voidMut.mutateAsync(reason.trim()); toast.success(t('fin.cashout_voided')); setModal(null); }
    catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }

  const canDeposit = cashout.status === 'approved' && canPrepare && cashout.deposit_status !== 'verified' && cashout.deposit_status !== 'not_required';
  const shortageOpen = cashout.shortage_record && cashout.shortage_record.status === 'unpaid';

  return (
    <div>
      <button onClick={() => navigate('/financial/cashouts')} style={backLinkStyle}>
        <ArrowLeft size={14} /> {t('fin.back_to_cashouts')}
      </button>

      <div className="co-hero">
        <div style={{ minWidth: 0 }}>
          <h1>
            <Wallet2 size={24} color="var(--brand)" /> {cashout.cashout_number}
            <StatusChip status={cashout.status} />
            <VarianceChip status={v} />
            {cashout.needs_admin && cashout.status === 'pending' && <NeedsAdminChip />}
          </h1>
          <div className="meta">
            <Person small name={cashout.cashier_name || cashout.cashier_username || `#${cashout.cashier_id}`} id={cashout.cashier_id} />
            <span>· {cashout.zone_name}</span>
            <span>· {fmtDateTime(cashout.period_start)} – {fmtDateTime(cashout.period_end)}</span>
          </div>
        </div>
        <div className="co-hero-actions">
          <Button variant="secondary" icon={Eye} onClick={() => open('preview')}>{t('fin.preview_print')}</Button>
          <Button variant="secondary" icon={FileDown} onClick={handleDownloadDocx} disabled={downloading}>{downloading ? t('fin.preparing') : t('fin.download_word_docx')}</Button>
        </div>
      </div>

      <Stepper cashout={cashout} />

      {/* Actions, grouped by who does them. Hidden groups never render. */}
      <div className="co-card co-actions">
        {cashout.status === 'pending' && (
          <RoleGate roles={['admin', 'gudoomiye']}>
            <div className="co-actgroup">
              <span>{t('co2.act.approval')}</span>
              <div className="btns">
                <Button icon={CheckCircle2} onClick={handleApprove} disabled={approveMut.isPending || blockers.length > 0}>{t('fin.approve')}</Button>
                <Button variant="secondary" icon={XCircle} onClick={() => open('reject')}>{t('fin.reject')}</Button>
              </div>
            </div>
          </RoleGate>
        )}
        {canDeposit && (
          <div className="co-actgroup">
            <span>{t('co2.act.deposit')}</span>
            <div className="btns"><Button icon={Landmark} onClick={() => open('deposit')}>{t('co2.dep.record')}</Button></div>
          </div>
        )}
        {shortageOpen && canPrepare && (
          <div className="co-actgroup">
            <span>{t('fin.cashier_shortage')}</span>
            <div className="btns"><Button variant="secondary" icon={Scale} onClick={() => open('resolve')}>{t('fin.mark_resolved')}</Button></div>
          </div>
        )}
        {canPrepare && (
          <div className="co-actgroup">
            <span>{t('co2.act.documents')}</span>
            <div className="btns"><Button variant="secondary" icon={Upload} onClick={() => open('upload')}>{t('fin.upload_signed_copy')}</Button></div>
          </div>
        )}
        {isAdmin && cashout.status !== 'approved' && cashout.status !== 'voided' && (<>
          <span className="co-actdiv" />
          <div className="co-actgroup">
            <span>{t('co2.act.admin')}</span>
            <div className="btns"><Button variant="danger" icon={Ban} onClick={() => open('void')}>{t('status.void')}</Button></div>
          </div>
        </>)}
        {blockers.length > 0 && (role === 'admin' || role === 'gudoomiye') && (
          <div className="co-blockers">
            {blockers.map((b) => <span key={b} className="co-warn"><AlertTriangle size={12} style={{ verticalAlign: '-2px' }} /> {b}</span>)}
          </div>
        )}
        {cashout.status === 'rejected' && cashout.rejection_reason && <div className="co-blockers"><span className="co-danger-box">{t('fin.rejection_reason')}: {cashout.rejection_reason}</span></div>}
        {cashout.status === 'voided' && cashout.voided_reason && <div className="co-blockers"><span className="co-danger-box">{t('fin.void_reason')}: {cashout.voided_reason}</span></div>}
      </div>

      <div className="co-layout">
        <div className="co-main">
          <BreakdownCard cashout={cashout} onViewTransactions={() => open('transactions')} />
          <ElectronicCard cashout={cashout} />
          {cashout.assignment_snapshot && <CashoutAssignmentCard data={cashout.assignment_snapshot} snapshot />}
          <CountCard cashout={cashout} />
          {cashout.status === 'approved' && <DepositsCard cashout={cashout} isAdmin={isAdmin} userId={user?.id} />}
        </div>
        <div className="co-side">
          <ShortageCard cashout={cashout} />
          <StatementsCard cashout={cashout} canUpload={canPrepare} onUpload={() => open('statement')} />
          <AttachmentsCard cashout={cashout} />
          <TimelineCard cashout={cashout} />
          <PeopleCard cashout={cashout} />
        </div>
      </div>

      {/* The only thing that prints (cashout.css @media print). */}
      {createPortal(<div className="codoc-print-root"><CashoutDocument cashout={cashout} /></div>, document.body)}

      <Modal open={modal === 'preview'} onClose={() => setModal(null)} title={t('portal.invoice.docPreview')} maxWidth="860px"
        footer={<><Button variant="secondary" onClick={() => setModal(null)}>{t('common.close')}</Button><Button icon={Printer} onClick={() => window.print()}>{t('fin.print')}</Button></>}>
        <div className="co-preview"><CashoutDocument cashout={cashout} /></div>
      </Modal>
      <Modal open={modal === 'transactions'} onClose={() => setModal(null)} title={t('fin.m.transactionsTitle', undefined, { number: cashout.cashout_number })}>
        <TransactionsList cashoutId={id} enabled={modal === 'transactions'} />
      </Modal>
      <ConfirmDialog open={modal === 'reject'} onClose={() => setModal(null)} onConfirm={handleReject} title={t('fin.reject_this_cashout')} danger
        confirmLabel={t('fin.reject')} isLoading={rejectMut.isPending}
        message={<div><p style={{ margin: '0 0 8px' }}>{t('fin.a_reason_is_required')}</p><input className="co-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('fin.reason_for_rejection')} /></div>} />
      <ConfirmDialog open={modal === 'void'} onClose={() => setModal(null)} onConfirm={handleVoid} title={t('fin.void_this_cashout')} danger
        confirmLabel={t('fin.void_cashout')} isLoading={voidMut.isPending}
        message={<div><p style={{ margin: '0 0 8px' }}>{t('fin.only_allowed_before_approval_the')}</p><input className="co-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('fin.reason_for_voiding')} /></div>} />
      {modal === 'upload' && <UploadAttachmentModal onClose={() => setModal(null)} cashoutId={id} />}
      {modal === 'statement' && <UploadAttachmentModal onClose={() => setModal(null)} cashoutId={id} initialType="merchant_statement" />}
      {modal === 'deposit' && <RecordDepositModal onClose={() => setModal(null)} cashout={cashout} />}
      {modal === 'resolve' && <ResolveShortageModal onClose={() => setModal(null)} cashoutId={id} shortage={cashout.shortage_record} />}
    </div>
  );
}

// Pending → Approved → Deposited → Verified (rejected / voided end the line).
function Stepper({ cashout }) {
  const { t } = useI18n();
  const ds = cashout.deposit_status;
  const steps = [{ key: 'created', label: t('co2.step.created'), when: cashout.created_at, state: 'done' }];
  if (cashout.status === 'rejected' || cashout.status === 'voided') {
    steps.push({ key: cashout.status, label: t(`status.${cashout.status}`), when: cashout.status === 'voided' ? cashout.voided_at : cashout.approved_at, state: 'bad' });
  } else {
    const approved = cashout.status === 'approved';
    const deposited = approved && ['deposited', 'verified', 'not_required'].includes(ds);
    const verified = approved && (ds === 'verified' || ds === 'not_required');
    steps.push({ key: 'approved', label: t('co2.step.approved'), when: approved ? cashout.approved_at : null, state: approved ? 'done' : 'current' });
    steps.push({ key: 'deposited', label: t('co2.step.deposited'), state: deposited ? 'done' : approved ? 'current' : '' });
    steps.push({ key: 'verified', label: t('co2.step.verified'), state: verified ? 'done' : deposited ? 'current' : '' });
  }
  return (
    <div className="co-card co-stepper" role="list">
      {steps.map((s, i) => (
        <React.Fragment key={s.key}>
          {i > 0 && <span className={`line${s.state === 'done' ? ' done' : ''}`} />}
          <span className={`st ${s.state}`} role="listitem">
            <span className="dot">{s.state === 'done' ? <Check size={14} /> : s.state === 'bad' ? <X size={14} /> : i + 1}</span>
            <span>{s.label}{s.when && <span className="when">{fmtDateTime(s.when)}</span>}</span>
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

function BreakdownCard({ cashout, onViewTransactions }) {
  const { t } = useI18n();
  const b = cashout.breakdown;
  const ctl = b?.control;
  return (
    <div className="co-card">
      <div className="co-card-head">
        <h3><Coins size={16} color="var(--brand)" /> {t('co2.perCurrency')}</h3>
        <button type="button" onClick={onViewTransactions} className="co-linkbtn" style={linkBtn}><List size={12} /> {t('fin.view_transactions')}</button>
      </div>
      <div className="co-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {b?.currencies ? (
          <div className="co-cur">
            {CURRENCIES.map((cur) => {
              const tot = b.totals[cur];
              return (
                <div key={cur} className="co-curcard">
                  <div className="h"><strong>{cur}</strong>{tot.diff !== null && <span className={tot.diff === 0 ? 'co-zero' : tot.diff < 0 ? 'co-neg' : 'co-pos'}>{fmtDiff(tot.diff, cur)}</span>}</div>
                  <table>
                    <thead><tr><th>{t('co2.method')}</th><th>{t('dash.expected')}</th><th>{t('co2.received')}</th><th>{t('fin.difference')}</th></tr></thead>
                    <tbody>
                      {METHODS.map((m) => {
                        const l = b.currencies[cur][m];
                        return (
                          <tr key={m}>
                            <td>
                              {t(`co2.m.${m}`)}{m !== 'cash' && l.count > 0 && l.auto_verified && <> <ShieldCheck size={12} color="var(--success)" aria-label={t('co2.autoVerified')} /></>}
                              <div className="co-note">{l.count} {t('fin.transactions').toLowerCase()}</div>
                              {m !== 'cash' && l.manual_expected > 0 && <div className="co-note">{t('co2.statementLine', undefined, { recorded: fmtMoney(l.manual_expected, cur), confirmed: l.statement_total !== undefined ? fmtMoney(l.statement_total, cur) : '—' })}</div>}
                            </td>
                            <td className="co-money">{fmtMoney(l.expected, cur)}</td>
                            <td className="co-money">{l.actual === null ? '—' : fmtMoney(l.actual, cur)}</td>
                            <td className={`co-money ${l.diff === null ? '' : l.diff === 0 ? 'co-zero' : l.diff < 0 ? 'co-neg' : 'co-pos'}`}>{fmtDiff(l.diff, cur)}</td>
                          </tr>
                        );
                      })}
                      <tr className="tot"><td>{t('co2.total')}</td><td className="co-money">{fmtMoney(tot.expected, cur)}</td><td className="co-money">{tot.actual === null ? '—' : fmtMoney(tot.actual, cur)}</td><td className="co-money">{fmtDiff(tot.diff, cur)}</td></tr>
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        ) : <div className="co-note">{t('co2.legacyNoBreakdown')}</div>}
        {b?.mode === 'legacy' && <div className="co-note">{t('co2.legacyMode')}</div>}
        {b?.debt?.count > 0 && <div className="co-note">{t('co2.debtNote', undefined, { n: b.debt.count })} ({fmtPair({ USD: b.debt.USD, SLSH: b.debt.SLSH })})</div>}
        <div className="co-kv">
          <div><div className="k">{t('co2.expectedUsd')}</div><div className="v">{fmtMoney(cashout.expected_amount, 'USD')}</div></div>
          <div><div className="k">{t('co2.receivedUsd')}</div><div className="v">{fmtMoney(cashout.actual_amount, 'USD')}</div></div>
          <div><div className="k">{t('dash.shortage')}</div><div className={`v ${Number(cashout.shortage) > 0 ? 'co-neg' : ''}`}>{fmtMoney(cashout.shortage, 'USD')}</div></div>
          <div><div className="k">{t('dash.surplus')}</div><div className={`v ${Number(cashout.surplus) > 0 ? 'co-pos' : ''}`}>{fmtMoney(cashout.surplus, 'USD')}</div></div>
        </div>
        {ctl && (
          <div className="co-note">
            {t('co2.controlLine', undefined, { control: fmtMoney(ctl.control_shortage_usd, 'USD'), tol: fmtMoney(ctl.tolerance_usd, 'USD'), thr: fmtMoney(ctl.admin_threshold_usd, 'USD') })}
            {b.rate ? ` · ${t('co2.rateUsed', undefined, { rate: Number(b.rate).toLocaleString('en-US') })}` : ''}
          </div>
        )}
        {cashout.shortage_reason && <div style={{ fontSize: '13px' }}><strong>{t('fin.shortage_reason')}</strong> {cashout.shortage_reason}</div>}
        {cashout.remarks && <div style={{ fontSize: '13px' }}><strong>{t('fin.remarks')}</strong> {cashout.remarks}</div>}
      </div>
    </div>
  );
}

function ElectronicCard({ cashout }) {
  const { t } = useI18n();
  const rows = cashout.electronic || [];
  if (!rows.length) return null;
  // Statement check stored at creation: ticked / not found (+ note).
  const ticked = new Set();
  const missing = new Map();
  const c = cashout.breakdown?.currencies || {};
  for (const cur of CURRENCIES) for (const m of ['zaad', 'edahab']) {
    const l = c[cur]?.[m];
    if (!l) continue;
    for (const pid of l.confirmed_ids || []) ticked.add(Number(pid));
    for (const pid of l.unconfirmed_ids || []) missing.set(Number(pid), (l.notes && l.notes[pid]) || l.note || '');
  }
  return (
    <div className="co-card">
      <div className="co-card-head">
        <h3><ShieldCheck size={16} color="var(--success)" /> {t('co2.electronic')}</h3>
        <span className="co-note">{t('co2.autoVerifiedLong')}</span>
      </div>
      <div className="co-card-body co-list">
        {rows.map((p) => (
          <div key={p.id}>
            <div style={{ minWidth: 0 }}>
              <div>
                <span className="co-code">{p.reference_code || '—'}</span> <Chip tone="info" flat>{t(`co2.m.${p.method}`)}</Chip>{' '}
                {p.gateway_verified ? <Chip tone="success">{t('co2.viaGateway')}</Chip>
                  : ticked.has(Number(p.id)) ? <Chip tone="success">{t('co2.stmt.onStatement')}</Chip>
                    : missing.has(Number(p.id)) ? <Chip tone="danger">{t('co2.stmt.notOnStatement')}</Chip>
                      : <Chip tone="warning">{t('co2.viaStatement')}</Chip>}
              </div>
              {missing.get(Number(p.id)) && <div className="ref co-neg">{missing.get(Number(p.id))}</div>}
              <div className="ref">{p.invoice_number} · {p.customer_name} · {fmtDateTime(p.created_at)}</div>
            </div>
            <span className="co-money" style={{ fontWeight: 800 }}>{fmtMoney(p.amount, p.currency)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CountCard({ cashout }) {
  const { t } = useI18n();
  const cd = cashout.count_detail;
  if (!cd) return null;
  return (
    <div className="co-card">
      <div className="co-card-head"><h3><Coins size={16} color="var(--accent)" /> {t('co2.countDetail')}</h3></div>
      <div className="co-card-body co-cur">
        {CURRENCIES.map((cur) => {
          const e = cd[cur];
          if (!e) return null;
          const notes = Object.entries(e.notes || {}).sort((a, b) => Number(b[0]) - Number(a[0]));
          return (
            <div key={cur} className="co-curcard">
              <div className="h"><strong>{cur}</strong><span className="co-money" style={{ fontWeight: 800 }}>{fmtMoney(e.total, cur)}</span></div>
              {e.mode === 'manual' ? (
                <div style={{ padding: '10px 12px', fontSize: '13px' }}><Chip tone="warning" flat>{t('co2.manualTotal')}</Chip><div className="co-note" style={{ marginTop: '6px' }}>{e.remark}</div></div>
              ) : (
                <table>
                  <thead><tr><th>{t('co2.note')}</th><th>{t('co2.notesCount')}</th><th>{t('co2.subtotal')}</th></tr></thead>
                  <tbody>
                    {notes.length === 0 && <tr><td colSpan={3} className="co-muted">{t('co2.noNotes')}</td></tr>}
                    {notes.map(([d, n]) => <tr key={d}><td>{fmtMoney(Number(d), cur)}</td><td>{n}</td><td className="co-money">{fmtMoney(Number(d) * n, cur)}</td></tr>)}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DepositsCard({ cashout, isAdmin, userId }) {
  const { t } = useI18n();
  const toast = useToast();
  const change = useChangeDeposit(cashout.id);
  const [voidFor, setVoidFor] = useState(null);
  const [voidReason, setVoidReason] = useState('');
  const deps = cashout.deposits || [];
  const req = cashout.deposit_required || {};

  async function act(depositId, action, reason) {
    try {
      await change.mutateAsync({ depositId, action, reason });
      toast.success(t(action === 'verify' ? 'co2.dep.verifiedOk' : 'co2.dep.voidedOk'));
      setVoidFor(null);
    } catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }
  async function openSlip(d) {
    try { window.open(await apiClient.fetchAuthorizedFileUrl(`/v2/cashouts/${cashout.id}/attachments/${d.attachment_id}/file`), '_blank'); }
    catch (err) { toast.error(err.message); }
  }

  return (
    <div className="co-card">
      <div className="co-card-head">
        <h3><Landmark size={16} color="var(--info)" /> {t('co2.deposit')}</h3>
        <DepositChip status={cashout.deposit_status} />
      </div>
      <div className="co-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div className="co-kv">
          {CURRENCIES.map((cur) => (
            <div key={cur}>
              <div className="k">{cur} · {t('co2.dep.depositedOf')}</div>
              <div className="v">{fmtMoney(cashout.deposited?.[cur] || 0, cur)} <span className="co-muted" style={{ fontSize: '12px' }}>/ {fmtMoney(req[cur] || 0, cur)}</span></div>
            </div>
          ))}
        </div>
        {req.legacy && <div className="co-note">{t('co2.dep.legacyReq')}</div>}
        {deps.length === 0 && <div className="co-note">{t('co2.dep.none')}</div>}
        {deps.length > 0 && (
          <div className="co-list">
            {deps.map((d) => (
              <div key={d.id} style={d.voided_at ? { opacity: 0.6 } : undefined}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }} className={d.voided_at ? 'co-struck' : undefined}>{fmtMoney(d.amount, d.currency)} → {d.account_name} <span className="co-muted">({t(`co2.acct.${d.account_type}`)})</span></div>
                  <div className="ref">
                    {fmtDateTime(d.deposited_at)} · {d.deposited_by_name || d.deposited_by_username}
                    {d.note ? ` · ${d.note}` : ''}
                    {d.voided_at ? ` · ${t('status.voided')}: ${d.voided_reason}` : ''}
                    {d.verified_at ? ` · ${t('co2.dep.verifiedBy', undefined, { who: d.verified_by_name || d.verified_by_username, when: fmtDate(d.verified_at) })}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {d.attachment_id && <button type="button" className="co-linkbtn" onClick={() => openSlip(d)}>{t('co2.dep.slip')}</button>}
                  {d.verified_at && <Chip tone="success">{t('co2.dep.verified')}</Chip>}
                  {!d.verified_at && !d.voided_at && isAdmin && (<>
                    <Button variant="secondary" onClick={() => act(d.id, 'verify')} disabled={change.isPending || d.deposited_by === userId} title={d.deposited_by === userId ? t('co2.dep.ownDeposit') : undefined}>{t('co2.dep.verify')}</Button>
                    <Button variant="ghost" onClick={() => { setVoidFor(d); setVoidReason(''); }}>{t('status.void')}</Button>
                  </>)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <ConfirmDialog open={!!voidFor} onClose={() => setVoidFor(null)} onConfirm={() => (voidReason.trim() ? act(voidFor.id, 'void', voidReason.trim()) : toast.error(t('fin.a_reason_is_required')))}
        title={t('co2.dep.voidTitle')} danger confirmLabel={t('status.void')} isLoading={change.isPending}
        message={<input className="co-input" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} placeholder={t('common.reason')} />} />
    </div>
  );
}

// Merchant statement files (attachments of kind 'statement').
function StatementsCard({ cashout, canUpload, onUpload }) {
  const { t } = useI18n();
  const list = (cashout.attachments || []).filter((a) => a.kind === 'statement');
  if (!cashout.statement_required && list.length === 0) return null;
  return (
    <div className="co-card">
      <div className="co-card-head">
        <h3><FileDown size={16} color="var(--info)" /> {t('co2.stmt.cardTitle')}</h3>
        {list.length === 0 ? <Chip tone="danger">{t('co2.stmt.none')}</Chip> : <Chip tone="success">{t('co2.stmt.count', undefined, { n: list.length })}</Chip>}
      </div>
      <div className="co-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {list.length === 0 && <div className="co-note">{t('co2.stmt.noneHint')}</div>}
        {list.length > 0 && <div className="co-list">{list.map((a) => <AttachmentRow key={a.id} attachment={a} cashoutId={cashout.id} />)}</div>}
        {canUpload && <div><Button variant="secondary" icon={Upload} onClick={onUpload}>{t('co2.stmt.upload')}</Button></div>}
      </div>
    </div>
  );
}

function ShortageCard({ cashout }) {
  const { t } = useI18n();
  const s = cashout.shortage_record;
  return (
    <div className="co-card">
      <div className="co-card-head"><h3><Scale size={16} color="var(--danger)" /> {t('fin.cashier_shortage')}</h3>{s && <Chip tone={s.status === 'paid' ? 'success' : 'danger'}>{t(`status.${s.status}`, s.status)}</Chip>}</div>
      <div className="co-card-body">
        {!s ? <div className="co-note">{t('fin.no_shortage_nothing_to_reconcile')}</div> : (
          <dl className="co-dl">
            <dt>{t('fin.shortage_amount')}</dt><dd className="co-money">{fmtMoney(s.shortage_amount, 'USD')}</dd>
            <dt>{t('common.reason')}</dt><dd>{s.reason}</dd>
            {s.status === 'paid' && (<>
              <dt>{t('fin.resolved_amount')}</dt><dd className="co-money">{fmtMoney(s.resolved_amount, 'USD')}</dd>
              <dt>{t('fin.resolved_at')}</dt><dd>{fmtDateTime(s.resolved_at)}</dd>
              <dt>{t('fin.resolution_notes')}</dt><dd>{s.resolution_notes}</dd>
            </>)}
          </dl>
        )}
      </div>
    </div>
  );
}

function AttachmentsCard({ cashout }) {
  const { t } = useI18n();
  const list = cashout.attachments || [];
  return (
    <div className="co-card">
      <div className="co-card-head"><h3><Paperclip size={16} /> {t('fin.supporting_attachments')}</h3></div>
      <div className="co-card-body">
        {list.length === 0 ? <div className="co-note">{t('fin.no_attachments_uploaded_yet')}</div> : (
          <div className="co-list">{list.map((a) => <AttachmentRow key={a.id} attachment={a} cashoutId={cashout.id} />)}</div>
        )}
      </div>
    </div>
  );
}

const TL_BAD = ['cashout.reject', 'cashout.void', 'cashout.attachment_void', 'cashout.deposit_void', 'cashout_shortage.create'];
function TimelineCard({ cashout }) {
  const { t } = useI18n();
  const items = cashout.timeline || [];
  return (
    <div className="co-card">
      <div className="co-card-head"><h3><History size={16} /> {t('co2.timeline')}</h3></div>
      <div className="co-card-body">
        {items.length === 0 ? <div className="co-note">—</div> : (
          <ul className="co-timeline">
            {items.map((it) => (
              <li key={it.id} className={TL_BAD.includes(it.action) ? 'bad' : undefined}>
                <div><strong>{t(`co2.tl.${it.action}`, it.action)}</strong>{it.note ? <span className="co-muted"> — {DOC_TYPE_LABELS[it.note] ? t('fin.doc.' + it.note, DOC_TYPE_LABELS[it.note]) : it.note}</span> : null}</div>
                <div className="w">{it.actor || t('co2.system')} · {fmtDateTime(it.at)}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PeopleCard({ cashout }) {
  const { t } = useI18n();
  const rows = [
    [t('fin.cashier'), cashout.cashier_name || cashout.cashier_username, cashout.cashier_id],
    [t('fin.head_of_cashiers'), cashout.head_of_cashiers_name || cashout.head_of_cashiers_username, cashout.head_of_cashiers_id],
    [t('fin.prepared_by'), cashout.created_by_name || cashout.created_by_username, cashout.created_by],
    ...(cashout.approved_by ? [[cashout.status === 'rejected' ? t('co2.rejectedBy') : t('fin.approved_by'), cashout.approved_by_name || cashout.approved_by_username, cashout.approved_by]] : []),
  ];
  return (
    <div className="co-card">
      <div className="co-card-head"><h3><Users size={16} /> {t('fin.accountability')}</h3></div>
      <div className="co-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {rows.map(([label, name, uid]) => <Person key={label} small name={name || `#${uid}`} id={uid} sub={label} />)}
      </div>
    </div>
  );
}

function TransactionsList({ cashoutId, enabled }) {
  const { t } = useI18n();
  const { data, isLoading, error } = useCashoutTransactions(cashoutId, enabled);
  const rows = data?.data || [];
  if (isLoading) return <LoadingState label={t('fin.loading_transactions')} />;
  if (error) return <p className="co-err">{error.message}</p>;
  if (rows.length === 0) return <p className="co-note" style={{ margin: 0 }}>{t('fin.no_transactions_recorded_in_this')}</p>;
  return (
    <div className="co-list" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
      {rows.map((r) => (
        <div key={r.id}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>{r.invoice_number} <span className="co-muted" style={{ fontWeight: 400 }}>— {r.customer_name} ({r.customer_number})</span></div>
            <div className="ref">{fmtDateTime(r.created_at)} · {t(`co2.m.${r.method}`, String(r.method).toUpperCase())}{r.reference_code ? <> · <span className="co-code">{r.reference_code}</span></> : null}</div>
          </div>
          <span className="co-money" style={{ fontWeight: 800 }}>{fmtMoney(r.amount, r.currency)}</span>
        </div>
      ))}
    </div>
  );
}

function AttachmentRow({ attachment, cashoutId }) {
  const { t } = useI18n();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [reason, setReason] = useState('');
  const voidMut = useVoidAttachment(cashoutId);
  async function handleView() {
    setLoading(true);
    try { window.open(await apiClient.fetchAuthorizedFileUrl(`/v2/cashouts/${cashoutId}/attachments/${attachment.id}/file`), '_blank'); }
    catch (err) { toast.error(err.message || t('fin.failed_to_open_attachment')); }
    finally { setLoading(false); }
  }
  async function handleVoid() {
    if (!reason.trim()) { toast.error(t('fin.a_reason_is_required')); return; }
    try { await voidMut.mutateAsync({ attachmentId: attachment.id, reason: reason.trim() }); toast.success(t('fin.attachment_removed')); setVoidOpen(false); }
    catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }
  return (
    <div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700 }}>{t('fin.doc.' + attachment.document_type, DOC_TYPE_LABELS[attachment.document_type] || attachment.document_type)}</div>
        <div className="ref">{attachment.original_filename} · {fmtDateTime(attachment.uploaded_at)}</div>
      </div>
      <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
        <button type="button" className="co-linkbtn" onClick={handleView} disabled={loading}>{loading ? t('common.loading') : t('fin.view')}</button>
        <RoleGate roles={['admin']}>
          <button type="button" className="co-linkbtn" style={{ color: 'var(--danger)' }} onClick={() => { setReason(''); setVoidOpen(true); }} aria-label={t('fin.remove')}><Trash2 size={13} /></button>
        </RoleGate>
      </div>
      <ConfirmDialog open={voidOpen} onClose={() => setVoidOpen(false)} onConfirm={handleVoid} title={t('fin.remove_this_attachment')} danger
        confirmLabel={t('fin.remove')} isLoading={voidMut.isPending}
        message={<div><p style={{ margin: '0 0 8px' }}>{t('fin.the_file_itself_is_preserved')}</p><input className="co-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('fin.reason_for_removal')} /></div>} />
    </div>
  );
}

function UploadAttachmentModal({ onClose, cashoutId, initialType = 'signed_cashout_form' }) {
  const { t } = useI18n();
  const toast = useToast();
  const [file, setFile] = useState(null);
  const [documentType, setDocumentType] = useState(initialType);
  const [error, setError] = useState('');
  const uploadMut = useUploadAttachment(cashoutId);
  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!file) { setError(t('fin.choose_a_file_first')); return; }
    try { await uploadMut.mutateAsync({ file, documentType }); toast.success(t('fin.attachment_uploaded')); onClose(); }
    catch (err) { setError(err.message || t('common.somethingWrong')); }
  }
  return (
    <Modal open onClose={uploadMut.isPending ? () => {} : onClose} title={t('fin.upload_signed_copy_supporting_docume')}
      footer={<><Button variant="secondary" onClick={onClose} disabled={uploadMut.isPending}>{t('common.cancel')}</Button><Button type="submit" form="co-upload-form" disabled={uploadMut.isPending}>{uploadMut.isPending ? t('topbar.uploading') : t('fin.upload')}</Button></>}>
      <form id="co-upload-form" onSubmit={handleSubmit} className="co-form">
        <span className="co-note">{t('fin.pdf_jpg_or_png_only')}</span>
        <label className="co-field">
          <span>{t('fin.document_type')}</span>
          <select className="co-input" value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
            {Object.entries(DOC_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{t('fin.doc.' + k, v)}</option>)}
          </select>
        </label>
        <label className="co-field">
          <span>{t('fin.file')}</span>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" capture="environment" onChange={(e) => setFile(e.target.files?.[0] || null)} className="co-input" />
        </label>
        {error && <span className="co-err">{error}</span>}
      </form>
    </Modal>
  );
}

function RecordDepositModal({ onClose, cashout }) {
  const { t } = useI18n();
  const toast = useToast();
  const { data: metaData } = useCashoutMeta();
  const accounts = metaData?.data?.deposit_accounts || [];
  const req = cashout.deposit_required || {};
  const remaining = (cur) => Math.max(0, Number(req[cur] || 0) - Number(cashout.deposited?.[cur] || 0));
  const firstCur = remaining('USD') > 0 || remaining('SLSH') <= 0 ? 'USD' : 'SLSH';
  const [accountId, setAccountId] = useState('');
  const [currency, setCurrency] = useState(firstCur);
  const [amount, setAmount] = useState(String(remaining(firstCur) || ''));
  const [note, setNote] = useState('');
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const record = useRecordDeposit(cashout.id);
  const account = accounts.find((a) => String(a.id) === accountId);
  const slipNeeded = account && account.type !== 'safe';

  function pickCurrency(c) { setCurrency(c); setAmount(String(remaining(c) || '')); }
  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const n = Number(amount);
    if (!accountId) { setError(t('co2.dep.pickAccount')); return; }
    if (!(n > 0)) { setError(t('co2.dep.amountInvalid')); return; }
    if (slipNeeded && !file) { setError(t('co2.dep.slipRequired')); return; }
    try {
      await record.mutateAsync({ deposit_account_id: Number(accountId), currency, amount: n, note: note.trim() || undefined, file });
      toast.success(t('co2.dep.recorded'));
      onClose();
    } catch (err) { setError(err.message || t('common.somethingWrong')); }
  }
  return (
    <Modal open onClose={record.isPending ? () => {} : onClose} title={t('co2.dep.record')}
      footer={<><Button variant="secondary" onClick={onClose} disabled={record.isPending}>{t('common.cancel')}</Button><Button type="submit" form="co-dep-form" icon={Landmark} disabled={record.isPending}>{record.isPending ? t('common.saving') : t('co2.dep.record')}</Button></>}>
      <form id="co-dep-form" onSubmit={handleSubmit} className="co-form">
        <div className="co-kv">
          {CURRENCIES.map((cur) => <div key={cur}><div className="k">{cur} · {t('co2.dep.remaining')}</div><div className="v">{fmtMoney(remaining(cur), cur)}</div></div>)}
        </div>
        {accounts.length === 0 && <div className="co-warn">{t('co2.dep.noAccounts')}</div>}
        <label className="co-field">
          <span>{t('co2.dep.account')}</span>
          <select className="co-input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">{t('co2.dep.pickAccount')}</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({t(`co2.acct.${a.type}`)}){a.account_ref ? ` · ${a.account_ref}` : ''}</option>)}
          </select>
        </label>
        <div className="co-grid2">
          <label className="co-field">
            <span>{t('fin.currency')}</span>
            <span className="co-seg" role="group">
              {CURRENCIES.map((c) => <button key={c} type="button" aria-pressed={currency === c} onClick={() => pickCurrency(c)}>{c}</button>)}
            </span>
          </label>
          <label className="co-field">
            <span>{t('common.amount')}</span>
            <input className="co-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} />
          </label>
        </div>
        <label className="co-field">
          <span>{t('co2.dep.slip')}{slipNeeded ? ' *' : ''} <span className="hint">{t('co2.dep.slipHint')}</span></span>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" capture="environment" onChange={(e) => setFile(e.target.files?.[0] || null)} className="co-input" />
        </label>
        <label className="co-field">
          <span>{t('co2.dep.note')}</span>
          <input className="co-input" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <span className="co-err">{error}</span>}
      </form>
    </Modal>
  );
}

function ResolveShortageModal({ onClose, cashoutId, shortage }) {
  const { t } = useI18n();
  const toast = useToast();
  const [amount, setAmount] = useState(String(Number(shortage.shortage_amount).toFixed(2)));
  const [notes, setNotes] = useState('');
  const resolveMut = useResolveShortage(cashoutId);
  async function handleResolve() {
    if (!notes.trim()) { toast.error(t('fin.resolution_notes_required')); return; }
    try { await resolveMut.mutateAsync({ resolved_amount: parseFloat(amount), resolution_notes: notes.trim() }); toast.success(t('fin.shortage_marked_resolved')); onClose(); }
    catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }
  return (
    <Modal open onClose={onClose} title={t('fin.resolve_cashier_shortage')}
      footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button onClick={handleResolve} disabled={resolveMut.isPending}>{resolveMut.isPending ? t('common.saving') : t('fin.mark_resolved')}</Button></>}>
      <div className="co-form">
        <p className="co-note" style={{ margin: 0 }}>{t('fin.record_what_was_actually_recovered')}</p>
        <label className="co-field"><span>{t('fin.amount_recovered')}</span><input className="co-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="co-field"><span>{t('fin.resolution_notes_required')}</span><input className="co-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('fin.e_g_cashier_repaid_in')} /></label>
      </div>
    </Modal>
  );
}

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
const linkBtn = { display: 'inline-flex', alignItems: 'center', gap: '4px', textDecoration: 'none' };
