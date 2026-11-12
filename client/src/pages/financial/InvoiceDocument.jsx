import React, { useState } from 'react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import {
  fmtMoney, invCurrency, otherCurrency, secondaryBlock, rateText, methodLabel, paymentChannelLabel,
  recordedByLabel, fmtDate, periodLabel, dayLabel,
} from './financeUtils.js';

export const LOGO_URL = '/api/v2/settings/company/logo-trimmed';

// The invoice as a document — rendered both as the on-screen paper preview
// and (portalled) as the only thing that prints. Same sections and order as
// the server's Word/HTML generator (lib/documentGenerators.js): letterhead,
// bill-to + amount due, details, totals, service days, payment history, void
// info, thank-you, footer. Fixed light colours (finance.css .invdoc), so the
// dark UI theme never leaks onto paper. Every figure comes from the API.
export default function InvoiceDocument({ invoice }) {
  const { t } = useI18n();
  const [logoFailed, setLogoFailed] = useState(false);
  const cur = invCurrency(invoice);
  const other = otherCurrency(cur);
  const balance = invoice.balance || {};
  const sec = secondaryBlock(balance, cur);
  const rate = rateText(balance);
  const total = parseFloat(invoice.invoice_total || 0);
  const discount = parseFloat(invoice.discount_amount || 0);
  const net = Number(balance.netTotal ?? total - discount);
  const paid = Number(balance.paid || 0);
  const outstanding = Number(balance.outstanding ?? net);
  // Gross/discount in the other currency, scaled from the server's net figure.
  const secGross = sec && net > 0 ? sec.netTotal * (total / net) : sec ? 0 : null;
  const secDiscount = sec && secGross !== null ? secGross - sec.netTotal : null;
  const company = invoice.company || { name: 'GURMAD' };
  const contact = [company.address, company.phone, company.email].filter(Boolean);
  const status = invoice.status || 'unpaid';
  const workedDays = Array.isArray(invoice.worked_days) ? invoice.worked_days : null;
  const visitDate = invoice.visit?.status_at || null;

  const billingType = invoice.billing_period ? t('fr.inv.monthly')
    : invoice.batch_customer_id ? t('fr.inv.daily')
      : invoice.customer_billing_type === 'monthly' ? t('fr.inv.monthly')
        : invoice.customer_billing_type === 'daily' ? t('fr.inv.daily') : t('fr.inv.manual');
  const description = invoice.billing_period
    ? t('fr.inv.descMonthly', undefined, { period: periodLabel(invoice.billing_period) })
    : visitDate ? t('fr.inv.descVisit', undefined, { date: fmtDate(visitDate) }) : t('fr.inv.descService');
  const usdCol = (ownVal, secVal) => (cur === 'USD' ? ownVal : secVal);
  const slshCol = (ownVal, secVal) => (cur === 'SLSH' ? ownVal : secVal);
  const show = (v, c) => (v === null || v === undefined ? '—' : fmtMoney(v, c));

  return (
    <div className="invdoc">
      <div className="top">
        <div>
          {!logoFailed && <img className="logo" src={LOGO_URL} alt="" onError={() => setLogoFailed(true)} />}
          <div className="co-name">{company.name}</div>
          <div className="co-tag">Shirkadda Nadaafadda</div>
          {contact.map((l) => <div key={l} className="co-line">{l}</div>)}
        </div>
        <div className="doc">
          <div className="title">{t('fr.inv.invoice').toUpperCase()}</div>
          <div className="no">{invoice.invoice_number}</div>
          <div className="date">{t('fr.inv.issued')} {fmtDate(invoice.created_at)}</div>
          <div className={`stamp ${status}`}>{t(`fr.inv.stamp.${status}`, status.toUpperCase())}</div>
        </div>
      </div>
      <div className="rule" /><div className="rule2" />

      <div className="billing">
        <div style={{ minWidth: 0 }}>
          <div className="lbl">{t('fr.inv.billTo')}</div>
          <div className="cust">{invoice.customer_name}</div>
          <div className="custno">{t('fr.inv.customerNo')} {invoice.customer_number}</div>
          {invoice.customer_phone && <div className="small">{invoice.customer_phone}</div>}
          {invoice.customer_address && <div className="small">{invoice.customer_address}</div>}
          {invoice.customer_path && <div className="small">{invoice.customer_path}</div>}
          {invoice.customer_door && <div className="small">{t('fr.inv.door')} {invoice.customer_door}</div>}
        </div>
        <div className={`due${outstanding > 0.004 ? '' : ' zero'}`}>
          <div className="lbl">{t('fr.inv.balanceDue')}</div>
          <div className="amt">{fmtMoney(outstanding, cur)}</div>
          {sec && <div className="sec">≈ {fmtMoney(sec.outstanding, other)}</div>}
          {rate && <div className="small">{t('fr.pay.rate', undefined, { rate })}</div>}
        </div>
      </div>

      <h2>{t('fr.inv.service')}</h2>
      <div className="facts">
        <div><div className="lbl">{t('fr.inv.billingType')}</div><div className="v">{billingType}</div></div>
        <div>
          <div className="lbl">{invoice.billing_period ? t('fr.inv.period') : t('fr.inv.visitDate')}</div>
          <div className="v">{invoice.billing_period ? periodLabel(invoice.billing_period) : visitDate ? fmtDate(visitDate) : '—'}</div>
        </div>
        <div>
          <div className="lbl">{t('fr.inv.collectionEvent')}</div>
          <div className="v">{invoice.visit?.batch_code || (invoice.batch_customer_id ? `#${invoice.batch_customer_id}` : '—')}</div>
        </div>
      </div>

      <h2>{t('fr.inv.details')}</h2>
      <table>
        <thead><tr><th>{t('fr.inv.description')}</th><th className="num">{t('fr.inv.fee')}</th><th className="num">{t('fr.inv.discount')}</th><th className="num">{t('fr.inv.total')}</th></tr></thead>
        <tbody>
          <tr>
            <td>{description}{invoice.notes ? <div className="sub">{invoice.notes}</div> : null}</td>
            <td className="num">{fmtMoney(total, cur)}{secGross !== null && <div className="sub">≈ {fmtMoney(secGross, other)}</div>}</td>
            <td className="num">{discount > 0 ? `− ${fmtMoney(discount, cur)}` : '—'}{discount > 0 && secDiscount !== null && <div className="sub">≈ {fmtMoney(secDiscount, other)}</div>}</td>
            <td className="num"><b>{fmtMoney(net, cur)}</b>{sec && <div className="sub">≈ {fmtMoney(sec.netTotal, other)}</div>}</td>
          </tr>
        </tbody>
      </table>

      <div className="totals">
        <table>
          <thead><tr><th>&nbsp;</th><th>USD</th><th>SLSH</th></tr></thead>
          <tbody>
            <tr><td>{t('fr.inv.total')}</td><td className="num">{show(usdCol(net, sec?.netTotal), 'USD')}</td><td className="num">{show(slshCol(net, sec?.netTotal), 'SLSH')}</td></tr>
            <tr className="paid-row"><td>{t('fr.inv.amountPaid')}</td><td className="num">{show(usdCol(paid, sec?.paid), 'USD')}</td><td className="num">{show(slshCol(paid, sec?.paid), 'SLSH')}</td></tr>
            <tr className="due-row"><td>{t('fr.inv.balanceDue')}</td><td className="num">{show(usdCol(outstanding, sec?.outstanding), 'USD')}</td><td className="num">{show(slshCol(outstanding, sec?.outstanding), 'SLSH')}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="rate">{rate ? t('fr.inv.rateUsed', undefined, { rate }) : t('fr.pay.noRate')}</div>

      {workedDays && workedDays.length > 0 && (
        <>
          <h2>{t('fr.inv.serviceDays')}{invoice.billing_period ? ` — ${periodLabel(invoice.billing_period)}` : ''}</h2>
          <table>
            <tbody>
              {workedDays.map((wk) => (
                <tr key={wk.week}>
                  <td style={{ width: '30%' }}>{t('fr.inv.week', undefined, { n: wk.week })} <span className="sub">({wk.range})</span></td>
                  <td>{wk.dates.length ? wk.dates.map(dayLabel).join(', ') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>{t('fr.inv.paymentsReceived')}</h2>
      {(invoice.payments || []).length === 0 ? (
        <div className="empty">{t('fr.inv.noPayments')}</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t('fr.inv.col.date')}</th><th>{t('fr.inv.col.method')}</th><th>{t('fr.inv.col.channel')}</th>
              <th className="num">{t('fr.inv.col.amount')}</th><th>{t('fr.inv.col.reference')}</th><th>{t('fr.inv.col.by')}</th>
            </tr>
          </thead>
          <tbody>
            {invoice.payments.map((p) => (
              <tr key={p.id} className={p.status === 'reversed' ? 'rev' : undefined}>
                <td>{fmtDate(p.created_at)}</td>
                <td>{methodLabel(t, p.method)}</td>
                <td>{paymentChannelLabel(t, p)}</td>
                <td className="num">{fmtMoney(p.amount, p.currency)}{p.currency !== 'USD' && <div className="sub">${parseFloat(p.amount_usd).toFixed(2)}</div>}</td>
                <td style={{ wordBreak: 'break-all' }}>{p.reference_code || '—'}</td>
                <td className={p.status === 'reversed' ? 'revnote' : undefined}>
                  {p.status === 'reversed' ? `${t('fr.inv.reversedNote')}${p.reversed_reason ? ` — ${p.reversed_reason}` : ''}` : recordedByLabel(t, p)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {status === 'voided' && (
        <div className="voidbox"><b>{t('fr.inv.voidInfo')}</b> {invoice.voided_at ? fmtDate(invoice.voided_at) : ''}{invoice.voided_reason ? ` — ${invoice.voided_reason}` : ''}</div>
      )}

      <div className="terms">{t('fr.inv.terms')}</div>
      <div className="thanks">{t('fr.inv.thanks')}</div>
      <div className="foot">
        <span><b>{company.name}</b> · Shirkadda Nadaafadda · {t('fr.inv.invoice')} {invoice.invoice_number}</span>
        <span>
          {invoice.created_by_name ? `${t('fr.inv.createdBy', undefined, { name: invoice.created_by_name })} · ` : ''}
          {t('fr.inv.printed', undefined, { date: fmtDate(new Date()) })}
        </span>
      </div>
    </div>
  );
}
