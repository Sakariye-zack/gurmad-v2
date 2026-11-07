import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, Check, Clock } from 'lucide-react';
import { PageHeader, Button, DataTable, Card, ConfirmDialog, useToast } from '../../components/ui/index.js';
import { apiClient } from '../../lib/apiClient.js';
import { appLocale } from '../../lib/dateLocale.js';
import { fmtByCurrency } from '../../lib/money.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

// F3 — Debt suspensions. Admin + gudoomiye (the server scopes a gudoomiye to
// their own district and is the real authorization boundary).
const td = { padding: '10px 14px', verticalAlign: 'middle' };

function fmtDay(iso) {
  if (!iso) return '';
  return new Date(iso.length === 10 ? iso + 'T00:00:00' : iso).toLocaleDateString(appLocale(), { dateStyle: 'medium' });
}
const outstanding = (r) => fmtByCurrency({ USD: r.outstanding_usd, SLSH: r.outstanding_slsh });

export default function DebtSuspensionsPage() {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState('candidates');
  const [selected, setSelected] = useState(() => new Set());
  const [confirmIds, setConfirmIds] = useState(null);

  const cand = useQuery({ queryKey: ['debt-suspensions', 'candidates'], queryFn: () => apiClient.get('/v2/debt-suspensions/candidates') });
  const susp = useQuery({ queryKey: ['debt-suspensions', 'suspended'], queryFn: () => apiClient.get('/v2/debt-suspensions/suspended'), enabled: tab === 'suspended' });
  const rows = useMemo(() => cand.data?.data || [], [cand.data]);
  const days = cand.data?.meta?.debt_suspend_days;
  const visibleSelected = rows.filter((r) => selected.has(r.id)).map((r) => r.id);

  const done = () => { setSelected(new Set()); qc.invalidateQueries({ queryKey: ['debt-suspensions'] }); };
  const approve = useMutation({
    mutationFn: (ids) => apiClient.post('/v2/debt-suspensions/approve', { customer_ids: ids }),
    onSuccess: (res) => {
      const d = res?.data || {};
      toast.success(t('debtSusp.approved', undefined, { n: d.approved?.length || 0 }));
      if (d.skipped?.length) toast.error(t('debtSusp.skipped', undefined, { n: d.skipped.length }));
      setConfirmIds(null);
      done();
    },
    onError: (err) => toast.error(err.message),
  });
  const dismiss = useMutation({
    mutationFn: (ids) => apiClient.post('/v2/debt-suspensions/dismiss', { customer_ids: ids }),
    onSuccess: (res) => { toast.success(t('debtSusp.dismissed', undefined, { n: res?.data?.dismissed?.length || 0 })); done(); },
    onError: (err) => toast.error(err.message),
  });

  function toggle(id) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  const allChecked = rows.length > 0 && visibleSelected.length === rows.length;
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)));
  const busy = approve.isPending || dismiss.isPending;

  const tabBtn = (key, label) => (
    <button
      type="button" onClick={() => setTab(key)}
      style={{ padding: '8px 14px', border: 'none', borderBottom: tab === key ? '2px solid var(--brand)' : '2px solid transparent', background: 'none', color: tab === key ? 'var(--text)' : 'var(--text-muted)', fontWeight: 700, cursor: 'pointer' }}
    >{label}</button>
  );
  const customerCell = (r) => <Link to={`/customers/${r.id}`} className="tabular-nums" style={{ color: 'var(--brand)', fontWeight: 700 }}>{r.customer_number}</Link>;

  return (
    <div>
      <PageHeader icon={ShieldAlert} title={t('debtSusp.title')} subtitle={days ? t('debtSusp.subtitle', undefined, { days }) : undefined} />

      <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid var(--border)', marginBottom: '16px' }}>
        {tabBtn('candidates', `${t('debtSusp.tabCandidates')}${rows.length ? ` (${rows.length})` : ''}`)}
        {tabBtn('suspended', t('debtSusp.tabSuspended'))}
      </div>

      {tab === 'candidates' && (
        <>
          {days === 0 && <Card style={{ padding: '14px 18px', marginBottom: '16px', color: 'var(--text-muted)' }}>{t('debtSusp.off')}</Card>}
          {visibleSelected.length > 0 && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
              <Button variant="danger" icon={Check} disabled={busy} onClick={() => setConfirmIds(visibleSelected)}>
                {t('debtSusp.approveSelected', undefined, { n: visibleSelected.length })}
              </Button>
              <Button variant="secondary" icon={Clock} disabled={busy} onClick={() => dismiss.mutate(visibleSelected)}>
                {t('debtSusp.dismissSelected', undefined, { n: visibleSelected.length })}
              </Button>
            </div>
          )}
          <DataTable
            columns={[
              { label: <input type="checkbox" aria-label={t('debtSusp.selectAll')} checked={allChecked} onChange={toggleAll} disabled={!rows.length} /> },
              { label: t('debtSusp.colCustomer') }, { label: t('debtSusp.colName') }, { label: t('debtSusp.colHierarchy') },
              { label: t('debtSusp.colOldest') }, { label: t('debtSusp.colDays'), align: 'right' }, { label: t('debtSusp.colOutstanding'), align: 'right' }, { label: '' },
            ]}
            loading={cand.isLoading}
            error={cand.error?.message}
            onRetry={cand.refetch}
            isEmpty={!cand.isLoading && rows.length === 0}
            emptyTitle={t('debtSusp.empty')}
          >
            {rows.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={td}><input type="checkbox" aria-label={r.customer_number} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>
                <td style={td}>{customerCell(r)}</td>
                <td style={td}>{r.business_name || r.name}</td>
                <td style={{ ...td, color: 'var(--text-muted)' }}>{r.hierarchy || r.zone_name}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDay(r.oldest_unpaid_date)}</td>
                <td className="tabular-nums" style={{ ...td, textAlign: 'right', fontWeight: 700, color: 'var(--danger)' }}>{r.days}</td>
                <td className="tabular-nums" style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>{outstanding(r)}</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'inline-flex', gap: '6px' }}>
                    <Button variant="danger" disabled={busy} onClick={() => setConfirmIds([r.id])}>{t('debtSusp.approve')}</Button>
                    <Button variant="secondary" disabled={busy} onClick={() => dismiss.mutate([r.id])}>{t('debtSusp.dismiss')}</Button>
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
        </>
      )}

      {tab === 'suspended' && (
        <DataTable
          columns={[
            { label: t('debtSusp.colCustomer') }, { label: t('debtSusp.colName') }, { label: t('debtSusp.colHierarchy') },
            { label: t('debtSusp.colSince') }, { label: t('debtSusp.colBy') }, { label: t('debtSusp.colOutstanding'), align: 'right' },
          ]}
          loading={susp.isLoading}
          error={susp.error?.message}
          onRetry={susp.refetch}
          isEmpty={!susp.isLoading && (susp.data?.data || []).length === 0}
          emptyTitle={t('debtSusp.emptySuspended')}
        >
          {(susp.data?.data || []).map((r) => (
            <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={td}>{customerCell(r)}</td>
              <td style={td}>{r.business_name || r.name}</td>
              <td style={{ ...td, color: 'var(--text-muted)' }}>{r.hierarchy || r.zone_name}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDay(r.suspended_at)}</td>
              <td style={td}>{r.suspended_by_username || '—'}</td>
              <td className="tabular-nums" style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>{outstanding(r)}</td>
            </tr>
          ))}
        </DataTable>
      )}

      <ConfirmDialog
        open={!!confirmIds}
        onClose={() => setConfirmIds(null)}
        onConfirm={() => approve.mutate(confirmIds)}
        title={t('debtSusp.confirmTitle')}
        message={t('debtSusp.confirmBody', undefined, { n: confirmIds?.length || 0 })}
        confirmLabel={t('debtSusp.approve')}
        danger
        isLoading={approve.isPending}
      />
    </div>
  );
}
