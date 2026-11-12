import React, { useState } from 'react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { useCompanyName } from '../../hooks/useSettings.js';
import { LOGO_URL } from './InvoiceDocument.jsx';
import { fmtDate, fmtDateTime } from './financeUtils.js';
import { CURRENCIES, METHODS, fmtMoney, fmtDiff, fmtPair, varianceOf } from './cashoutUtils.js';

// The cashout as a paper document — on-screen preview and (portalled) the
// only thing that prints. Same content as the server's Word document
// (lib/documentGenerators.js buildCashoutDocx). Fixed light colours
// (cashout.css .codoc). Every figure comes from the API.
export default function CashoutDocument({ cashout }) {
  const { t } = useI18n();
  const [logoFailed, setLogoFailed] = useState(false);
  const { data: nameData } = useCompanyName();
  const company = nameData?.data?.company_name || 'GURMAD';
  const b = cashout.breakdown;
  const recon = cashout.reconciliation || {};
  const v = varianceOf(cashout);
  const cd = cashout.count_detail;
  const live = (cashout.deposits || []).filter((d) => !d.voided_at);
  const cls = (d) => (d > 0 ? 'pos' : d < 0 ? 'neg' : '');

  return (
    <div className="codoc">
      <div className="top">
        <div>
          {!logoFailed && <img className="logo" src={LOGO_URL} alt="" onError={() => setLogoFailed(true)} />}
          <div className="co-name">{company}</div>
          <div className="co-tag">{t('fin.cashout_and_cash_reconciliation')}</div>
        </div>
        <div className="doc">
          <div className="title">{t('nav.cashout').toUpperCase()}</div>
          <div className="no">{cashout.cashout_number}</div>
          <div className="date">{t('co2.doc.prepared')} {fmtDateTime(cashout.created_at)}</div>
          <span className={`stamp ${cashout.status}`}>{t(`status.${cashout.status}`).toUpperCase()}</span>
        </div>
      </div>
      <div className="rule" /><div className="rule2" />

      <div className="facts">
        <div><div className="lbl">{t('fin.cashier')}</div><div className="v">{cashout.cashier_name || `#${cashout.cashier_id}`}</div></div>
        <div><div className="lbl">{t('co2.district')}</div><div className="v">{cashout.zone_name || '—'}</div></div>
        <div><div className="lbl">{t('co2.period')}</div><div className="v">{fmtDateTime(cashout.period_start)} – {fmtDateTime(cashout.period_end)}</div></div>
        <div><div className="lbl">{t('fin.transactions')}</div><div className="v">{recon.transactionCount ?? '—'} · {t('nav.customers')} {recon.customerCount ?? '—'}</div></div>
      </div>

      {b?.currencies && (<>
        <h2>{t('co2.perCurrency')}</h2>
        <div className="two">
          {CURRENCIES.map((cur) => (
            <table key={cur}>
              <thead><tr><th>{cur}</th><th>{t('dash.expected')}</th><th>{t('co2.received')}</th><th>{t('fin.difference')}</th></tr></thead>
              <tbody>
                {METHODS.map((m) => {
                  const l = b.currencies[cur][m];
                  return (
                    <tr key={m}>
                      <td>{t(`co2.m.${m}`)}{m !== 'cash' && l.count > 0 && l.auto_verified ? ' ✓' : ''}</td>
                      <td>{fmtMoney(l.expected, cur)}</td>
                      <td>{l.actual === null ? '—' : fmtMoney(l.actual, cur)}</td>
                      <td className={cls(l.diff)}>{fmtDiff(l.diff, cur)}</td>
                    </tr>
                  );
                })}
                <tr className="tot">
                  <td>{t('co2.total')}</td><td>{fmtMoney(b.totals[cur].expected, cur)}</td>
                  <td>{b.totals[cur].actual === null ? '—' : fmtMoney(b.totals[cur].actual, cur)}</td>
                  <td className={cls(b.totals[cur].diff)}>{fmtDiff(b.totals[cur].diff, cur)}</td>
                </tr>
              </tbody>
            </table>
          ))}
        </div>
        <div className="small">✓ {t('co2.autoVerifiedLong')}{b.rate ? ` · ${t('co2.rateUsed', undefined, { rate: Number(b.rate).toLocaleString('en-US') })}` : ''}</div>
        {b.debt?.count > 0 && <div className="small">{t('co2.debtNote', undefined, { n: b.debt.count })}</div>}
      </>)}

      <h2>{t('fin.reconciliation')} (USD)</h2>
      <table>
        <tbody>
          <tr><td>{t('fin.system_expected_amount')}</td><td>{fmtMoney(cashout.expected_amount, 'USD')}</td></tr>
          <tr><td>{t('fin.physical_received_amount')}</td><td>{fmtMoney(cashout.actual_amount, 'USD')}</td></tr>
          <tr><td>{t('dash.shortage')} / {t('dash.surplus')}</td><td>{fmtMoney(cashout.shortage, 'USD')} / {fmtMoney(cashout.surplus, 'USD')}</td></tr>
          <tr className="tot"><td>{t('co2.result')}</td><td>{t(`co2.var.${v}`)}{cashout.needs_admin ? ` · ${t('co2.needsAdmin')}` : ''}</td></tr>
        </tbody>
      </table>
      {cashout.shortage_reason && <div className="small" style={{ marginTop: 4 }}><b>{t('fin.shortage_reason')}</b> {cashout.shortage_reason}</div>}
      {cashout.remarks && <div className="small"><b>{t('fin.remarks')}</b> {cashout.remarks}</div>}

      {cd && (<>
        <h2>{t('co2.countDetail')}</h2>
        <div className="two">
          {CURRENCIES.map((cur) => <CountTable key={cur} cur={cur} entry={cd[cur]} />)}
        </div>
      </>)}

      {(cashout.electronic || []).length > 0 && (<>
        <h2>{t('co2.electronic')}</h2>
        <table>
          <thead><tr><th>{t('co2.txnCode')}</th><th>{t('co2.method')}</th><th>{t('co2.verifiedBy')}</th><th>{t('common.amount', 'Amount')}</th></tr></thead>
          <tbody>
            {cashout.electronic.map((p) => (
              <tr key={p.id}><td>{p.reference_code || '—'}</td><td>{t(`co2.m.${p.method}`)}</td><td>{p.gateway_verified ? t('co2.viaGateway') : t('co2.viaStatement')}</td><td>{fmtMoney(p.amount, p.currency)}</td></tr>
            ))}
          </tbody>
        </table>
      </>)}

      {cashout.status === 'approved' && (<>
        <h2>{t('co2.deposit')}</h2>
        <table>
          <tbody>
            <tr><td>{t('co2.dep.required')}</td><td>{fmtPair(cashout.deposit_required)}</td></tr>
            <tr><td>{t('co2.dep.depositedTotal')}</td><td>{fmtPair(cashout.deposited)}</td></tr>
            <tr className="tot"><td>{t('common.status')}</td><td>{t(`co2.dep.${cashout.deposit_status}`)}</td></tr>
          </tbody>
        </table>
        {live.length > 0 && (
          <table style={{ marginTop: 6 }}>
            <thead><tr><th>{t('co2.dep.account')}</th><th>{t('common.date')}</th><th>{t('common.amount', 'Amount')}</th><th>{t('co2.dep.verified')}</th></tr></thead>
            <tbody>
              {live.map((d) => (
                <tr key={d.id}><td>{d.account_name}</td><td>{fmtDate(d.deposited_at)}</td><td>{fmtMoney(d.amount, d.currency)}</td><td>{d.verified_at ? `${d.verified_by_name || d.verified_by_username || ''} ${fmtDate(d.verified_at)}` : '—'}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </>)}

      <h2>{t('fin.accountability')}</h2>
      <table>
        <tbody>
          <tr><td>{t('fin.head_of_cashiers')}</td><td>{cashout.head_of_cashiers_name || `#${cashout.head_of_cashiers_id}`}</td></tr>
          <tr><td>{t('fin.prepared_by')}</td><td>{cashout.created_by_name || `#${cashout.created_by}`}</td></tr>
          <tr><td>{t('fin.approved_by')}</td><td>{cashout.approved_by && cashout.status === 'approved' ? `${cashout.approved_by_name || `#${cashout.approved_by}`} · ${fmtDateTime(cashout.approved_at)}` : t('fin.not_yet_approved')}</td></tr>
        </tbody>
      </table>

      <div className="sig">
        <div>{t('fin.cashier_signature')}</div>
        <div>{t('fin.head_of_cashiers_signature')}</div>
        <div>{t('co2.doc.approverSignature')}</div>
      </div>
      <div className="foot"><span><b>{company}</b> · {t('fin.m.systemDoc')}</span><span>{cashout.cashout_number}</span></div>
    </div>
  );
}

function CountTable({ cur, entry }) {
  const { t } = useI18n();
  if (!entry) return <div />;
  if (entry.mode === 'manual') {
    return (
      <table>
        <thead><tr><th>{cur}</th><th>{t('co2.total')}</th></tr></thead>
        <tbody><tr><td>{t('co2.manualTotal')} — {entry.remark}</td><td>{fmtMoney(entry.total, cur)}</td></tr></tbody>
      </table>
    );
  }
  const notes = Object.entries(entry.notes || {}).sort((a, b) => Number(b[0]) - Number(a[0]));
  return (
    <table>
      <thead><tr><th>{cur}</th><th>{t('co2.notesCount')}</th><th>{t('co2.subtotal')}</th></tr></thead>
      <tbody>
        {notes.length === 0 && <tr><td colSpan={3}>{t('co2.noNotes')}</td></tr>}
        {notes.map(([d, n]) => <tr key={d}><td>{fmtMoney(Number(d), cur)}</td><td>{n}</td><td>{fmtMoney(Number(d) * n, cur)}</td></tr>)}
        <tr className="tot"><td>{t('co2.total')}</td><td /><td>{fmtMoney(entry.total, cur)}</td></tr>
      </tbody>
    </table>
  );
}
