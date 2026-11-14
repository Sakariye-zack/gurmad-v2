import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, Calculator, AlertTriangle, FileCheck2, Upload, CheckCircle2 } from 'lucide-react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import {
  useCreateCashout, useReconciliationPreview, useCashiers, useCashoutMeta, useAssignmentPreview, useUploadAttachment,
} from '../../hooks/useCashouts.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { fmtDateTime } from './financeUtils.js';
import { CURRENCIES, METHODS, fmtMoney, fmtDiff, toLocalInput, localInputToIso, notesTotal } from './cashoutUtils.js';
import CashoutAssignmentCard from './CashoutAssignmentCard.jsx';
import './cashout.css';

const emptyCount = () => ({ mode: 'notes', notes: {}, total: '', remark: '' });
const ELECTRONIC = ['zaad', 'edahab'];
const curOf = (c) => (c === 'SLSH' ? 'SLSH' : 'USD');

// New Cashout.
//  1. cashier + period, with the cashier's assignment panel (information only);
//  2. expected figures from recorded payments;
//  3. merchant statement: every manually recorded ZAAD/eDahab payment is
//     ticked when found on the statement (gateway-confirmed ZAAD is
//     auto-verified); an unticked payment is a shortage unless explained;
//  4. the cash count (notes or a remarked manual total);
//  then, after creation, the statement file(s) are attached.
// Everything shown is a preview — the server recomputes every figure.
export default function CashoutFormModal({ open, onClose, prefill }) {
  if (!open) return null;
  return <CashoutForm onClose={onClose} prefill={prefill || {}} />;
}

function CashoutForm({ onClose, prefill }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const [cashierId, setCashierId] = useState(prefill.cashierId ? String(prefill.cashierId) : '');
  const [zoneId, setZoneId] = useState(prefill.zoneId ? String(prefill.zoneId) : '');
  const [periodStart, setPeriodStart] = useState(prefill.periodStart ? toLocalInput(prefill.periodStart) : '');
  const [periodEnd, setPeriodEnd] = useState(toLocalInput(prefill.periodEnd || new Date()));
  const [counts, setCounts] = useState({ USD: emptyCount(), SLSH: emptyCount() });
  const [ticked, setTicked] = useState(() => new Set());
  const [rowNotes, setRowNotes] = useState({});
  const [lineNotes, setLineNotes] = useState({});
  const [shortageReason, setShortageReason] = useState('');
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null); // the new cashout, while attaching statements
  const { data: zonesData } = useZonesList();
  const { data: cashiersData } = useCashiers();
  const { data: metaData } = useCashoutMeta();
  const create = useCreateCashout();
  const zones = useMemo(() => zonesData?.data || [], [zonesData]);
  const cashiers = cashiersData?.data || [];
  const meta = metaData?.data;
  const denoms = meta?.denominations || { USD: [], SLSH: [] };
  const startIso = localInputToIso(periodStart);
  const endIso = localInputToIso(periodEnd);
  const preview = useReconciliationPreview(cashierId, startIso, endIso);
  const assignment = useAssignmentPreview(cashierId, startIso, endIso);
  const p = preview.data?.data;
  const controls = p?.controls || meta?.controls || { tolerance_usd: 1, admin_threshold_usd: 10 };

  function pickCashier(id) {
    setCashierId(id);
    const c = cashiers.find((x) => String(x.id) === id);
    const z = c && zones.find((x) => x.name === c.zone);
    if (z) setZoneId(String(z.id));
  }

  const counted = {};
  for (const cur of CURRENCIES) {
    const e = counts[cur];
    counted[cur] = e.mode === 'manual' ? (e.total === '' ? 0 : Number(e.total)) : notesTotal(denoms[cur], e.notes);
  }

  // Manually recorded electronic payments, per currency + method.
  const groups = [];
  for (const cur of CURRENCIES) for (const m of ELECTRONIC) {
    const rows = (p?.electronic || []).filter((x) => !x.gateway_verified && curOf(x.currency) === cur && x.method === m);
    if (rows.length) groups.push({ key: `${cur}.${m}`, cur, m, rows, recorded: rows.reduce((s, x) => s + x.amount, 0) });
  }
  const tickedSum = (g) => g.rows.filter((x) => ticked.has(x.id)).reduce((s, x) => s + x.amount, 0);
  const missSum = (cur) => groups.filter((g) => g.cur === cur).reduce((s, g) => s + (g.recorded - tickedSum(g)), 0);

  // Display-only estimate of the result (the server decides).
  const estimate = (() => {
    if (!p?.breakdown) return null;
    const b = p.breakdown.currencies;
    const cashD = { USD: counted.USD - b.USD.cash.expected, SLSH: counted.SLSH - b.SLSH.cash.expected };
    const diffs = { USD: cashD.USD - missSum('USD'), SLSH: cashD.SLSH - missSum('SLSH') };
    const rate = Number(p.rate) || null;
    const slshUsd = Math.abs(diffs.SLSH) < 0.5 ? 0 : rate ? diffs.SLSH / rate : null;
    if (slshUsd === null) return { diffs, noRate: true };
    const net = diffs.USD + slshUsd;
    const slshShort = Math.max(0, -cashD.SLSH) + missSum('SLSH');
    const gross = Math.max(0, -cashD.USD) + missSum('USD') + (slshShort > 0.4 ? (rate ? slshShort / rate : 0) : 0);
    const control = Math.max(net < -0.005 ? -net : 0, gross);
    const surplus = net > 0.005 ? net : 0;
    const status = control > controls.tolerance_usd + 1e-9 ? 'shortage' : surplus > controls.tolerance_usd + 1e-9 ? 'surplus' : 'balanced';
    // Unticked payments, every one explained, and no cash short -> the notes are the reason.
    const unticked = groups.flatMap((g) => g.rows.filter((x) => !ticked.has(x.id)).map((x) => ({ x, g })));
    const explained = unticked.length > 0 && unticked.every(({ x, g }) => (rowNotes[x.id] || '').trim() || (lineNotes[g.key] || '').trim());
    const cashShort = cashD.USD < -0.005 || cashD.SLSH < -0.4;
    return { diffs, control, surplus, status, reasonRequired: status === 'shortage' && !(explained && !cashShort), needsAdmin: control > controls.admin_threshold_usd + 1e-9 };
  })();

  function setCount(cur, patch) { setCounts((prev) => ({ ...prev, [cur]: { ...prev[cur], ...patch } })); }
  function toggle(id) { setTicked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; }); }
  function tickAll(g, on) { setTicked((prev) => { const n = new Set(prev); for (const x of g.rows) { if (on) n.add(x.id); else n.delete(x.id); } return n; }); }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!zoneId || !cashierId || !startIso || !endIso) { setError(t('co2.form.required')); return; }
    const cash_count = {};
    for (const cur of CURRENCIES) {
      const c = counts[cur];
      if (c.mode === 'manual') {
        if (c.total === '' || !(Number(c.total) >= 0)) { setError(t('co2.form.totalInvalid', undefined, { cur })); return; }
        if (!c.remark.trim()) { setError(t('co2.form.remarkRequired', undefined, { cur })); return; }
        cash_count[cur] = { mode: 'manual', total: Number(c.total), remark: c.remark.trim() };
      } else {
        const notes = {};
        for (const d of denoms[cur]) { const n = Number(c.notes[d]) || 0; if (n > 0) notes[d] = n; }
        cash_count[cur] = { mode: 'notes', notes };
      }
    }
    const electronic_confirm = {};
    for (const g of groups) {
      const notes = {};
      for (const x of g.rows) if (!ticked.has(x.id) && (rowNotes[x.id] || '').trim()) notes[x.id] = rowNotes[x.id].trim();
      electronic_confirm[g.cur] = electronic_confirm[g.cur] || {};
      electronic_confirm[g.cur][g.m] = { confirmed_ids: g.rows.filter((x) => ticked.has(x.id)).map((x) => x.id), notes, note: (lineNotes[g.key] || '').trim() || undefined };
    }
    if (estimate?.reasonRequired && !shortageReason.trim()) { setError(t('co2.form.reasonRequired')); return; }
    try {
      const result = await create.mutateAsync({
        zone_id: parseInt(zoneId, 10), cashier_id: parseInt(cashierId, 10), period_start: startIso, period_end: endIso,
        cash_count, electronic_confirm, shortage_reason: shortageReason.trim() || undefined, remarks: remarks.trim() || undefined,
      });
      toast.success(t('fin.m.created', undefined, { number: result.data.cashout_number }));
      if (groups.length) { setCreated(result.data); return; } // attach the merchant statement next
      onClose();
      navigate(`/financial/cashouts/${result.data.id}`);
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  if (created) {
    return <StatementUploadStep cashout={created} onDone={() => { onClose(); navigate(`/financial/cashouts/${created.id}`); }} />;
  }

  const step = { assign: 1, expected: 2, statement: 3, cash: groups.length ? 4 : 3 };
  return (
    <Modal
      open
      maxWidth="760px"
      onClose={create.isPending ? () => {} : onClose}
      title={t('fin.new_cashout')}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={create.isPending}>{t('common.cancel')}</Button>
        <Button type="submit" form="cashout-v2-form" disabled={create.isPending || !p || p.overlapsExistingCashout || p.periodInFuture}>
          {create.isPending ? t('common.saving') : t('fin.create_cashout')}
        </Button>
      </>}
    >
      <form id="cashout-v2-form" onSubmit={handleSubmit} className="co-form">
        <div className="co-step"><b>{step.assign}</b>{t('co2.form.whoWhen')}</div>
        <div className="co-grid2">
          <label className="co-field">
            <span>{t('fin.cashier')}</span>
            <select className="co-input" value={cashierId} onChange={(e) => pickCashier(e.target.value)}>
              <option value="">{t('fin.select_a_cashier')}</option>
              {cashiers.map((c) => <option key={c.id} value={c.id}>{c.full_name || c.username}{c.zone ? ` — ${c.zone}` : ''}</option>)}
            </select>
          </label>
          <label className="co-field">
            <span>{t('co2.district')}</span>
            <select className="co-input" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
              <option value="">{t('cust.select_a_zone')}</option>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </label>
          <label className="co-field">
            <span>{t('fin.period_start')}</span>
            <input type="datetime-local" step="1" className="co-input" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </label>
          <label className="co-field">
            <span>{t('fin.period_end')}</span>
            <input type="datetime-local" step="1" className="co-input" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </label>
        </div>
        {p?.overlapsExistingCashout && <div className="co-danger-box">{t('fin.this_cashier_already_has_a')}</div>}
        {p?.periodInFuture && <div className="co-danger-box">{t('co2.form.future')}</div>}
        {preview.error && <div className="co-err">{preview.error.message}</div>}
        {assignment.data?.data && <CashoutAssignmentCard data={assignment.data.data} compact />}

        {p?.breakdown && (<>
          <div className="co-step"><b>{step.expected}</b>{t('co2.form.expected')}</div>
          <div className="co-exp">
            <table>
              <thead><tr><th>{t('co2.method')}</th><th>USD</th><th>SLSH</th></tr></thead>
              <tbody>
                {METHODS.map((m) => (
                  <tr key={m}>
                    <td>
                      {t(`co2.m.${m}`)}{' '}
                      {m !== 'cash' && CURRENCIES.every((c) => p.breakdown.currencies[c][m].manual_expected <= 0) && p.breakdown.currencies.USD[m].count + p.breakdown.currencies.SLSH[m].count > 0 && (
                        <span className="co-auto"><ShieldCheck size={11} />{t('co2.autoVerified')}</span>
                      )}
                    </td>
                    <td>{fmtMoney(p.breakdown.currencies.USD[m].expected, 'USD')} <span className="co-muted">({p.breakdown.currencies.USD[m].count})</span></td>
                    <td>{fmtMoney(p.breakdown.currencies.SLSH[m].expected, 'SLSH')} <span className="co-muted">({p.breakdown.currencies.SLSH[m].count})</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {p.breakdown.debt?.count > 0 && <div className="co-note">{t('co2.debtNote', undefined, { n: p.breakdown.debt.count })}</div>}

          {groups.length > 0 && (<>
            <div className="co-step"><b>{step.statement}</b>{t('co2.form.confirmElectronic')}</div>
            <div className="co-note">{t('co2.stmt.hint')}</div>
            {groups.map((g) => <StatementGroup key={g.key} g={g} ticked={ticked} onToggle={toggle} onTickAll={tickAll}
              rowNotes={rowNotes} setRowNote={(id, v) => setRowNotes((prev) => ({ ...prev, [id]: v }))}
              lineNote={lineNotes[g.key] || ''} setLineNote={(v) => setLineNotes((prev) => ({ ...prev, [g.key]: v }))} sum={tickedSum(g)} />)}
          </>)}

          <div className="co-step"><b>{step.cash}</b>{t('co2.form.countCash')}</div>
          {CURRENCIES.map((cur) => (
            <CountBox key={cur} cur={cur} denoms={denoms[cur]} entry={counts[cur]} expected={p.breakdown.currencies[cur].cash.expected}
              total={counted[cur]} onChange={(patch) => setCount(cur, patch)} />
          ))}

          {estimate && !estimate.noRate && (
            <div className={`co-result ${estimate.status}`}>
              <span className="t">{t(`co2.form.result.${estimate.status}`)}</span>
              <span className="co-note">
                USD {fmtDiff(estimate.diffs.USD, 'USD')} · SLSH {fmtDiff(estimate.diffs.SLSH, 'SLSH')} · {t('co2.form.toleranceIs', undefined, { tol: fmtMoney(controls.tolerance_usd, 'USD') })}
              </span>
              {estimate.needsAdmin && <span className="co-err"><AlertTriangle size={12} style={{ verticalAlign: '-2px' }} /> {t('co2.form.needsAdmin', undefined, { thr: fmtMoney(controls.admin_threshold_usd, 'USD') })}</span>}
            </div>
          )}
          {estimate?.noRate && <div className="co-warn">{t('co2.form.noRate')}</div>}
          {estimate?.reasonRequired && (
            <label className="co-field">
              <span>{t('fin.shortage_reason_required')}</span>
              <input className="co-input" value={shortageReason} onChange={(e) => setShortageReason(e.target.value)} placeholder={t('fin.explain_the_shortfall')} />
            </label>
          )}
        </>)}
        {!p && cashierId && startIso && endIso && preview.isLoading && <div className="co-note">{t('common.loading')}</div>}

        <label className="co-field">
          <span>{t('fin.remarks_optional')}</span>
          <input className="co-input" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </label>
        {error && <span className="co-err">{error}</span>}
      </form>
    </Modal>
  );
}

// One currency + method of manually recorded electronic payments: tick each
// one found on the merchant statement; explain the ones that are not.
function StatementGroup({ g, ticked, onToggle, onTickAll, rowNotes, setRowNote, lineNote, setLineNote, sum }) {
  const { t } = useI18n();
  const all = g.rows.every((x) => ticked.has(x.id));
  const missing = g.rows.filter((x) => !ticked.has(x.id));
  const miss = g.recorded - sum;
  return (
    <div className="co-stmt">
      <div className="co-stmt-head">
        <strong><FileCheck2 size={14} style={{ verticalAlign: '-2px' }} /> {t(`co2.m.${g.m}`)} {g.cur} <span className="co-muted">({g.rows.length})</span></strong>
        <button type="button" className="co-linkbtn" onClick={() => onTickAll(g, !all)}>{all ? t('co2.stmt.untickAll') : t('co2.stmt.tickAll')}</button>
      </div>
      {g.rows.map((x) => {
        const on = ticked.has(x.id);
        return (
          <div key={x.id} className={`co-stmt-row${on ? '' : ' miss'}`}>
            <input type="checkbox" checked={on} onChange={() => onToggle(x.id)} aria-label={t('co2.stmt.found', undefined, { code: x.reference_code || x.id })} />
            <div style={{ minWidth: 0 }}>
              <div><span className="co-code">{x.reference_code || '—'}</span></div>
              <div className="who">{x.customer_name} · {x.customer_number} · {x.invoice_number || t('dv.debtRef', undefined, { id: x.debt_id })} · {fmtDateTime(x.created_at)}</div>
            </div>
            <span className="co-money" style={{ fontWeight: 800 }}>{fmtMoney(x.amount, x.currency)}</span>
            {!on && (
              <input className="co-input note" value={rowNotes[x.id] || ''} onChange={(e) => setRowNote(x.id, e.target.value)} placeholder={t('co2.stmt.rowNote')} maxLength={500} />
            )}
          </div>
        );
      })}
      <div className="co-stmt-foot">
        <span>{t('co2.stmt.total')} <strong className="co-money">{fmtMoney(sum, g.cur)}</strong> <span className="co-muted">/ {fmtMoney(g.recorded, g.cur)}</span></span>
        {missing.length > 0
          ? <span className="co-neg">{t('co2.stmt.notFound', undefined, { n: missing.length, amount: fmtMoney(miss, g.cur) })}</span>
          : <span className="co-zero"><CheckCircle2 size={12} style={{ verticalAlign: '-2px' }} /> {t('co2.stmt.allFound')}</span>}
      </div>
      {missing.length > 0 && (
        <div style={{ padding: '0 12px 10px' }}>
          <input className="co-input" value={lineNote} onChange={(e) => setLineNote(e.target.value)} placeholder={t('co2.stmt.lineNote')} maxLength={1000} />
        </div>
      )}
    </div>
  );
}

// After creation: attach one or more merchant statement files (image/PDF).
// Never blocking — skipping is allowed and the omission is audited server-side.
function StatementUploadStep({ cashout, onDone }) {
  const { t } = useI18n();
  const toast = useToast();
  const upload = useUploadAttachment(cashout.id);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function send() {
    setError('');
    if (!files.length) { setError(t('fin.choose_a_file_first')); return; }
    setBusy(true);
    try {
      for (const f of files) await upload.mutateAsync({ file: f, documentType: 'merchant_statement' });
      toast.success(t('co2.stmt.uploaded', undefined, { n: files.length }));
      onDone();
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={busy ? () => {} : onDone} title={t('co2.stmt.uploadTitle', undefined, { number: cashout.cashout_number })}
      footer={<>
        <Button variant="secondary" onClick={onDone} disabled={busy}>{t('co2.stmt.skip')}</Button>
        <Button icon={Upload} onClick={send} disabled={busy}>{busy ? t('topbar.uploading') : t('co2.stmt.uploadOpen')}</Button>
      </>}>
      <div className="co-form">
        <div className="co-result balanced"><span className="t"><CheckCircle2 size={14} style={{ verticalAlign: '-2px' }} /> {t('co2.stmt.created', undefined, { number: cashout.cashout_number })}</span></div>
        <p className="co-note" style={{ margin: 0 }}>{t('co2.stmt.uploadHint')}</p>
        <label className="co-field">
          <span>{t('co2.stmt.files')}</span>
          <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" capture="environment" className="co-input"
            onChange={(e) => setFiles(Array.from(e.target.files || []))} />
          <span className="hint">{t('fin.pdf_jpg_or_png_only')}</span>
        </label>
        {error && <span className="co-err">{error}</span>}
      </div>
    </Modal>
  );
}

function CountBox({ cur, denoms, entry, expected, total, onChange }) {
  const { t } = useI18n();
  const diff = total - expected;
  return (
    <div className="co-count">
      <div className="co-count-head">
        <strong><Calculator size={14} style={{ verticalAlign: '-2px' }} /> {t('co2.form.cashIn', undefined, { cur })}</strong>
        <span className="co-seg" role="group">
          <button type="button" aria-pressed={entry.mode === 'notes'} onClick={() => onChange({ mode: 'notes' })}>{t('co2.form.countNotes')}</button>
          <button type="button" aria-pressed={entry.mode === 'manual'} onClick={() => onChange({ mode: 'manual' })}>{t('co2.form.enterTotal')}</button>
        </span>
      </div>
      {entry.mode === 'notes' ? (
        <div className="co-notes">
          {denoms.map((d) => {
            const n = entry.notes[d] ?? '';
            return (
              <div key={d} className="co-note-in">
                <label htmlFor={`n-${cur}-${d}`}>{fmtMoney(d, cur)}</label>
                <input id={`n-${cur}-${d}`} className="co-input" inputMode="numeric" value={n}
                  onChange={(e) => onChange({ notes: { ...entry.notes, [d]: e.target.value.replace(/[^\d]/g, '') } })} placeholder="0" />
                <span className="sub">{Number(n) > 0 ? fmtMoney(d * Number(n), cur) : ''}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="co-grid2">
          <label className="co-field">
            <span>{t('co2.form.total', undefined, { cur })}</span>
            <input className="co-input" inputMode="decimal" value={entry.total} onChange={(e) => onChange({ total: e.target.value.replace(/[^\d.]/g, '') })} />
          </label>
          <label className="co-field">
            <span>{t('co2.form.remark')}</span>
            <input className="co-input" value={entry.remark} onChange={(e) => onChange({ remark: e.target.value })} placeholder={t('co2.form.remarkHint')} />
          </label>
        </div>
      )}
      <div className="co-count-total">
        <span className="co-muted">{t('co2.form.expectedCash')} {fmtMoney(expected, cur)}</span>
        <span>
          <span className="amt">{fmtMoney(total, cur)}</span>{' '}
          <span className={Math.abs(diff) < (cur === 'SLSH' ? 0.5 : 0.005) ? 'co-zero' : diff < 0 ? 'co-neg' : 'co-pos'}>{fmtDiff(diff, cur)}</span>
        </span>
      </div>
    </div>
  );
}
