import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, Calculator, AlertTriangle } from 'lucide-react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import { useCreateCashout, useReconciliationPreview, useCashiers, useCashoutMeta } from '../../hooks/useCashouts.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { CURRENCIES, METHODS, fmtMoney, fmtDiff, toLocalInput, localInputToIso, notesTotal } from './cashoutUtils.js';
import './cashout.css';

const emptyCount = () => ({ mode: 'notes', notes: {}, total: '', remark: '' });

// New Cashout. Only physical CASH is counted (per currency, by notes or a
// remarked manual total); ZAAD / eDahab are auto-verified from the matched
// payments. The figures shown here are a preview — the server recomputes
// every expected / actual / difference figure and applies the tolerance.
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
  const [shortageReason, setShortageReason] = useState('');
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState('');
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

  // Display-only estimate of the result (the server decides).
  const estimate = useMemo(() => {
    if (!p?.breakdown) return null;
    const b = p.breakdown.currencies;
    const diffs = { USD: counted.USD - b.USD.cash.expected, SLSH: counted.SLSH - b.SLSH.cash.expected };
    const rate = Number(p.rate) || null;
    const slshUsd = Math.abs(diffs.SLSH) < 0.5 ? 0 : rate ? diffs.SLSH / rate : null;
    if (slshUsd === null) return { diffs, noRate: true };
    const net = diffs.USD + slshUsd;
    const gross = Math.max(0, -diffs.USD) + Math.max(0, -slshUsd);
    const control = Math.max(net < -0.005 ? -net : 0, gross);
    const surplus = net > 0.005 ? net : 0;
    const status = control > controls.tolerance_usd + 1e-9 ? 'shortage' : surplus > controls.tolerance_usd + 1e-9 ? 'surplus' : 'balanced';
    return { diffs, control, surplus, status, reasonRequired: status === 'shortage', needsAdmin: control > controls.admin_threshold_usd + 1e-9 };
  }, [p, counted.USD, counted.SLSH, controls.tolerance_usd, controls.admin_threshold_usd]);

  function setCount(cur, patch) {
    setCounts((prev) => ({ ...prev, [cur]: { ...prev[cur], ...patch } }));
  }

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
    if (estimate?.reasonRequired && !shortageReason.trim()) { setError(t('co2.form.reasonRequired')); return; }
    try {
      const result = await create.mutateAsync({
        zone_id: parseInt(zoneId, 10), cashier_id: parseInt(cashierId, 10), period_start: startIso, period_end: endIso,
        cash_count, shortage_reason: shortageReason.trim() || undefined, remarks: remarks.trim() || undefined,
      });
      toast.success(t('fin.m.created', undefined, { number: result.data.cashout_number }));
      onClose();
      navigate(`/financial/cashouts/${result.data.id}`);
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      maxWidth="720px"
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
        <div className="co-step"><b>1</b>{t('co2.form.whoWhen')}</div>
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

        {p?.breakdown && (<>
          <div className="co-step"><b>2</b>{t('co2.form.expected')}</div>
          <div className="co-exp">
            <table>
              <thead><tr><th>{t('co2.method')}</th><th>USD</th><th>SLSH</th></tr></thead>
              <tbody>
                {METHODS.map((m) => (
                  <tr key={m}>
                    <td>
                      {t(`co2.m.${m}`)}{' '}
                      {m !== 'cash' && <span className="co-auto"><ShieldCheck size={11} />{t('co2.autoVerified')}</span>}
                    </td>
                    <td>{fmtMoney(p.breakdown.currencies.USD[m].expected, 'USD')} <span className="co-muted">({p.breakdown.currencies.USD[m].count})</span></td>
                    <td>{fmtMoney(p.breakdown.currencies.SLSH[m].expected, 'SLSH')} <span className="co-muted">({p.breakdown.currencies.SLSH[m].count})</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {p.breakdown.debt?.count > 0 && <div className="co-note">{t('co2.debtNote', undefined, { n: p.breakdown.debt.count })}</div>}
          {p.electronic?.length > 0 && (
            <div className="co-note">
              {t('co2.form.txnCodes')}: {p.electronic.slice(0, 6).map((x) => x.reference_code || '—').join(', ')}{p.electronic.length > 6 ? ` +${p.electronic.length - 6}` : ''}
            </div>
          )}

          <div className="co-step"><b>3</b>{t('co2.form.countCash')}</div>
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
