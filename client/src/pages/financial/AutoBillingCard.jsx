import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { Card, Button, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useAutoBillingStatus, useRunAutoBilling } from '../../hooks/useFinancial.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

const todayIso = () => new Date().toLocaleDateString('en-CA');
const thisMonth = () => todayIso().slice(0, 7);

// Latest successful run of a kind + its skipped customers (zone-filtered server-side).
function RunSummary({ kind, runs, latest }) {
  const { t } = useI18n();
  const run = (runs || []).find((r) => r.kind === kind && r.finished_at && !r.error);
  const failed = (runs || []).find((r) => r.kind === kind && r.error);
  const skipped = latest?.[kind]?.skipped || [];
  const title = kind === 'monthly' ? t('inv.last_monthly_run') : t('inv.last_daily_run');
  const reasonLabel = (reason) => {
    if (reason === 'no_fee') return t('inv.skip_no_fee');
    if (reason === 'already_invoiced') return t('inv.skip_already_invoiced');
    return `${t('inv.skip_error')}: ${String(reason).replace(/^error:\s*/, '')}`;
  };
  return (
    <div style={{ flex: '1 1 280px', minWidth: 0 }}>
      <div style={labelStyle}>{title}</div>
      {run ? (
        <div style={{ fontSize: '14px', fontWeight: 700 }}>
          {new Date(run.finished_at).toLocaleString()} <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>({run.period_key})</span>
          <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-muted)' }}>{t('inv.created_count', undefined, { n: run.created_count })}</div>
        </div>
      ) : <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{t('inv.no_run_yet')}</div>}
      {failed && !run && <div style={{ fontSize: '12px', color: 'var(--danger)' }}>{t('inv.run_failed')}: {failed.error}</div>}
      {run && (
        <div style={{ marginTop: '8px' }}>
          <div style={labelStyle}>{t('inv.skipped_title')} ({skipped.length})</div>
          {skipped.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('inv.no_skipped')}</div>
          ) : (
            <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', maxHeight: '160px', overflowY: 'auto' }}>
              {skipped.map((s, i) => (
                <li key={`${s.customer_id}-${i}`}>
                  <Link to={`/customers/${s.customer_id}`}>{s.name} ({s.customer_number})</Link>
                  <span style={{ color: 'var(--text-muted)' }}> — {reasonLabel(s.reason)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function GenerateNow() {
  const { t } = useI18n();
  const toast = useToast();
  const run = useRunAutoBilling();
  const [kind, setKind] = useState('monthly');
  const [period, setPeriod] = useState(thisMonth());
  const [date, setDate] = useState(todayIso());

  async function handleRun() {
    try {
      const body = kind === 'monthly' ? { kind, period: period || undefined } : { kind, date: date || undefined };
      const res = await run.mutateAsync(body);
      const d = res?.data || {};
      if (d.not_due) toast.error(t('inv.run_not_due'));
      else if (d.before_go_live) toast.error(t('inv.run_before_go_live'));
      else toast.success(t('inv.run_done', undefined, { n: d.created ?? 0 }));
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', flexWrap: 'wrap', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
      <label style={fieldStyle}>
        <span style={labelStyle}>{t('inv.kind')}</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={inputStyle}>
          <option value="monthly">{t('inv.kind_monthly')}</option>
          <option value="daily">{t('inv.kind_daily')}</option>
        </select>
      </label>
      {kind === 'monthly' ? (
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('inv.period')}</span>
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} style={inputStyle} />
        </label>
      ) : (
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('inv.date')}</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
        </label>
      )}
      <Button onClick={handleRun} disabled={run.isPending || (kind === 'monthly' ? !period : !date)}>{run.isPending ? t('common.saving') : t('inv.generate_now')}</Button>
    </div>
  );
}

// Visible to admin / gudoomiye / zone_accountant (same roles the status endpoint allows).
export default function AutoBillingCard() {
  return (
    <RoleGate roles={['admin', 'gudoomiye', 'zone_accountant']}>
      <AutoBillingCardInner />
    </RoleGate>
  );
}

function AutoBillingCardInner() {
  const { t } = useI18n();
  const { data, error } = useAutoBillingStatus();
  const runs = data?.data?.runs || [];
  const latest = data?.data?.latest_skipped;
  return (
    <Card style={{ padding: '20px', marginBottom: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
        <Zap size={16} color="var(--brand)" />
        <strong style={{ fontSize: '15px' }}>{t('inv.auto_billing')}</strong>
      </div>
      <p style={{ margin: '0 0 14px', fontSize: '12px', color: 'var(--text-muted)' }}>{t('inv.auto_billing_hint')}</p>
      {error ? (
        <div style={{ fontSize: '13px', color: 'var(--danger)' }}>{error.message}</div>
      ) : (
        <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
          <RunSummary kind="monthly" runs={runs} latest={latest} />
          <RunSummary kind="daily" runs={runs} latest={latest} />
        </div>
      )}
      <RoleGate roles={['admin']}><GenerateNow /></RoleGate>
    </Card>
  );
}

const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', marginBottom: '4px' };
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', fontFamily: 'inherit',
};
