import React from 'react';
import { MapPinned, AlertTriangle, Info } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { fmtDateTime } from './financeUtils.js';
import { CURRENCIES, fmtMoney } from './cashoutUtils.js';

const ROWS = ['opening_due', 'new_invoices', 'total_sent', 'collected', 'other_channels', 'remaining_due'];

// The cashier's assignment panel: his Sub Zones and what was "sent" to him
// (open invoices of those customers) vs what he and other channels
// collected in the period. INFORMATION ONLY — it never changes the
// expected / received / shortage figures. `snapshot` = the stored copy
// shown on a cashout's detail page (what was true at creation).
export default function CashoutAssignmentCard({ data, snapshot = false, compact = false }) {
  const { t } = useI18n();
  if (!data) return null;
  const showCur = CURRENCIES.filter((cur) => cur === 'USD' || ROWS.some((k) => Number(data.totals?.[cur]?.[k]) > 0));
  return (
    <div className={compact ? 'co-assign compact' : 'co-card co-assign'}>
      <div className="co-card-head">
        <h3><MapPinned size={16} color="var(--info)" /> {t('co2.asg.title')}</h3>
        <span className="co-note">{snapshot ? t('co2.asg.snapshot', undefined, { when: fmtDateTime(data.computed_at) }) : t('co2.asg.infoOnly')}</span>
      </div>
      <div className="co-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {data.no_subzone ? (
          <div className="co-warn"><Info size={12} style={{ verticalAlign: '-2px' }} /> {t('co2.asg.noSubzone')}</div>
        ) : (
          <div className="co-asg-zones">
            {data.subzones.map((z) => (
              <span key={z.id} className="co-asg-zone" title={z.path}>
                <strong>{z.name}</strong>
                <span className="co-muted">{z.path}</span>
                <span className="co-muted">{t('co2.asg.customers', undefined, { n: z.customer_count })}</span>
              </span>
            ))}
          </div>
        )}
        <div className="co-exp">
          <table>
            <thead><tr><th>{t('co2.asg.line')}</th>{showCur.map((cur) => <th key={cur}>{cur}</th>)}</tr></thead>
            <tbody>
              {ROWS.map((k) => (
                <tr key={k} className={k === 'total_sent' || k === 'remaining_due' ? 'co-asg-strong' : undefined}>
                  <td>{t(`co2.asg.${k}`)}</td>
                  {showCur.map((cur) => <td key={cur}>{fmtMoney(data.totals[cur][k], cur)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {Number(data.outside_area?.payment_count) > 0 && (
          <div className="co-warn">
            <AlertTriangle size={12} style={{ verticalAlign: '-2px' }} />{' '}
            {t('co2.asg.outside', undefined, { amount: fmtMoney(data.outside_area.usd_equiv, 'USD'), n: data.outside_area.payment_count })}
          </div>
        )}
      </div>
    </div>
  );
}
