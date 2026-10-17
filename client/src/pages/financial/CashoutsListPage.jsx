import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wallet2, Plus, FileCheck2 } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, StatCard, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useCashouts, useCreateCashout, useReconciliationPreview, useCashiers } from '../../hooks/useCashouts.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

const STATUS_MAP = { pending: 'warning', approved: 'success', rejected: 'danger', voided: 'info' };

export default function CashoutsListPage() {
  const { t } = useI18n();
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useCashouts({ status: statusFilter || undefined, q: search || undefined });
  const cashouts = data?.data || [];
  const pendingCount = cashouts.filter((c) => c.status === 'pending').length;
  const shortageCount = cashouts.filter((c) => parseFloat(c.shortage) > 0).length;

  return (
    <div>
      <PageHeader
        icon={Wallet2}
        title={t('nav.cashout')}
        subtitle={t('fin.cash_reconciliation_head_of_cashiers')}
        actions={
          <RoleGate roles={['admin', 'head_of_cashiers']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>{t('fin.new_cashout')}</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label={t('fin.total_cashouts')} value={error ? '—' : cashouts.length} icon={Wallet2} />
        <StatCard label={t('fin.pending_approval')} value={error ? '—' : pendingCount} icon={Wallet2} accent="var(--warning)" />
        <StatCard label={t('fin.with_shortage')} value={error ? '—' : shortageCount} icon={Wallet2} accent="var(--danger)" />
      </div>

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder={t('fin.search_cashout_number')}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">{t('cust.all_statuses')}</option>
          <option value="pending">{t('status.pending')}</option>
          <option value="approved">{t('status.approved')}</option>
          <option value="rejected">{t('status.rejected')}</option>
          <option value="voided">{t('status.voided')}</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && cashouts.length === 0}
        emptyTitle={t('fin.no_cashouts_yet')}
        columns={[{ label: t('fin.cashout_no') }, { label: t('common.zone') }, { label: t('dash.expected') }, { label: t('dash.actual') }, { label: t('dash.shortage') }, { label: t('dash.surplus') }, { label: t('common.status') }, { label: t('fin.signed') }]}
      >
        {cashouts.map((co) => (
          <tr key={co.id} onClick={() => navigate(`/financial/cashouts/${co.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong>{co.cashout_number}</strong></td>
            <td style={cellStyle}>{co.zone_name}</td>
            <td style={cellStyle} className="tabular-nums">${parseFloat(co.expected_amount).toFixed(2)}</td>
            <td style={cellStyle} className="tabular-nums">${parseFloat(co.actual_amount).toFixed(2)}</td>
            <td style={cellStyle} className="tabular-nums">{parseFloat(co.shortage) > 0 ? <span style={{ color: 'var(--danger)', fontWeight: 700 }}>${parseFloat(co.shortage).toFixed(2)}</span> : '—'}</td>
            <td style={cellStyle} className="tabular-nums">{parseFloat(co.surplus) > 0 ? <span style={{ color: 'var(--info)', fontWeight: 700 }}>${parseFloat(co.surplus).toFixed(2)}</span> : '—'}</td>
            <td style={cellStyle}><StatusBadge status={co.status} map={STATUS_MAP} /></td>
            <td style={cellStyle}>{co.has_signed_document ? <FileCheck2 size={16} color="var(--success)" /> : <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>—</span>}</td>
          </tr>
        ))}
      </DataTable>

      <CashoutFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function CashoutFormModal({ open, onClose }) {
  if (!open) return null;
  return <CashoutFormContent onClose={onClose} />;
}

function toIsoZ(local) {
  if (!local) return '';
  return new Date(local).toISOString();
}

function CashoutFormContent({ onClose }) {
  const { t } = useI18n();
  const [zoneId, setZoneId] = useState('');
  const [cashierId, setCashierId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [cash, setCash] = useState('0');
  const [zaad, setZaad] = useState('0');
  const [edahab, setEdahab] = useState('0');
  const [slsh, setSlsh] = useState('0');
  const [shortageReason, setShortageReason] = useState('');
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState('');
  const { data: zonesData } = useZonesList();
  const { data: cashiersData } = useCashiers();
  const preview = useReconciliationPreview(cashierId, toIsoZ(periodStart), toIsoZ(periodEnd));
  const createCashout = useCreateCashout();
  const toast = useToast();
  const zones = zonesData?.data || [];
  // User-reported gap (Phase 10 Billing audit): the field below used to
  // be a raw "type the numeric user id" input — same class of bug already
  // fixed once this session for Employees' "Linked user account ID".
  // Narrowed to the cashiers in the selected zone when one is chosen
  // (zone is picked first in this form), full list otherwise.
  const cashiers = (cashiersData?.data || []).filter((c) => !zoneId || !c.zone || c.zone === zones.find((z) => String(z.id) === zoneId)?.name);

  const actual = (parseFloat(cash) || 0) + (parseFloat(zaad) || 0) + (parseFloat(edahab) || 0) + (parseFloat(slsh) || 0);
  const expected = preview.data?.data?.expectedAmount ?? null;
  const diff = expected != null ? expected - actual : null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!zoneId || !cashierId || !periodStart || !periodEnd) { setError(t('fin.zone_cashier_and_period_are')); return; }
    try {
      const result = await createCashout.mutateAsync({
        zone_id: parseInt(zoneId, 10), cashier_id: parseInt(cashierId, 10),
        period_start: toIsoZ(periodStart), period_end: toIsoZ(periodEnd),
        actual_amount: actual, cash_amount: parseFloat(cash) || 0, zaad_amount: parseFloat(zaad) || 0,
        edahab_amount: parseFloat(edahab) || 0, slsh_amount: parseFloat(slsh) || 0,
        shortage_reason: shortageReason || undefined, remarks: remarks || undefined,
      });
      toast.success(t('fin.m.created', undefined, { number: result.data.cashout_number }));
      onClose();
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      onClose={createCashout.isPending ? () => {} : onClose}
      title={t('fin.new_cashout')}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={createCashout.isPending}>{t('common.cancel')}</Button>
        <Button type="submit" form="cashout-form" disabled={createCashout.isPending}>{createCashout.isPending ? t('common.saving') : t('fin.create_cashout')}</Button>
      </>}
    >
      <form id="cashout-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', gap: '10px' }}>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('common.zone')}</span>
            <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} style={inputStyle}>
              <option value="">{t('cust.select_a_zone')}</option>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('fin.cashier')}</span>
            <select value={cashierId} onChange={(e) => setCashierId(e.target.value)} style={inputStyle}>
              <option value="">{t('fin.select_a_cashier')}</option>
              {cashiers.map((c) => <option key={c.id} value={c.id}>{c.full_name || c.username} ({c.username}{c.zone ? `, ${c.zone}` : ''})</option>)}
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('fin.period_start')}</span>
            <input type="datetime-local" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} style={inputStyle} />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('fin.period_end')}</span>
            <input type="datetime-local" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} style={inputStyle} />
          </label>
        </div>

        {preview.data?.data && (
          <div style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', border: '1px solid var(--border)', fontSize: '12px' }}>
            <div className="tabular-nums" style={{ fontWeight: 700, marginBottom: '4px' }}>
              {t('fin.m.systemExpected', undefined, { expected: expected.toFixed(2), transactions: preview.data.data.transactionCount, customers: preview.data.data.customerCount })}
            </div>
            {preview.data.data.overlapsExistingCashout && (
              <span style={{ color: 'var(--danger)' }}>{t('fin.this_cashier_already_has_a')}</span>
            )}
          </div>
        )}

        <span style={sectionLabelStyle}>{t('fin.amount_physically_received')}</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '10px' }}>
          <label style={fieldStyle}><span style={labelStyle}>{t('fin.cash')}</span><input type="number" min="0" step="0.01" value={cash} onChange={(e) => setCash(e.target.value)} style={inputStyle} /></label>
          <label style={fieldStyle}><span style={labelStyle}>ZAAD</span><input type="number" min="0" step="0.01" value={zaad} onChange={(e) => setZaad(e.target.value)} style={inputStyle} /></label>
          <label style={fieldStyle}><span style={labelStyle}>{t('fin.edahab')}</span><input type="number" min="0" step="0.01" value={edahab} onChange={(e) => setEdahab(e.target.value)} style={inputStyle} /></label>
          <label style={fieldStyle}><span style={labelStyle}>SLSH</span><input type="number" min="0" step="0.01" value={slsh} onChange={(e) => setSlsh(e.target.value)} style={inputStyle} /></label>
        </div>
        <div className="tabular-nums" style={{ fontSize: '13px', fontWeight: 700 }}>{t('fin.m.totalActual', undefined, { actual: actual.toFixed(2) })}</div>
        {diff != null && Math.abs(diff) > 0.005 && (
          <div style={{ fontSize: '12px', color: diff > 0 ? 'var(--danger)' : 'var(--info)' }}>
            {diff > 0 ? t('fin.m.shortageRecorded', undefined, { amount: diff.toFixed(2) }) : t('fin.m.surplusRecorded', undefined, { amount: (-diff).toFixed(2) })}
          </div>
        )}
        {diff != null && diff > 0.005 && (
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('fin.shortage_reason_required')}</span>
            <input value={shortageReason} onChange={(e) => setShortageReason(e.target.value)} style={inputStyle} placeholder={t('fin.explain_the_shortfall')} />
          </label>
        )}
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('fin.remarks_optional')}</span>
          <input value={remarks} onChange={(e) => setRemarks(e.target.value)} style={inputStyle} />
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

const cellStyle = { padding: '12px 14px' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const sectionLabelStyle = {
  display: 'block', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--text-muted)', margin: '4px 0 -4px',
};
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
