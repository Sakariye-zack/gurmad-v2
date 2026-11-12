import React, { useState } from 'react';
import { Archive, CalendarRange, ClipboardList, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Button, DataTable, StatusBadge, Modal, ConfirmDialog, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import LegacyOpsBanner from '../../components/collection/LegacyOpsBanner.jsx';
import { useCycles, useCreateCycle, useCloseCycle, useCloseEndedCycles } from '../../hooks/useCollectionOps.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

export default function CyclesListPage() {
  const { t } = useI18n();
  const { data, isLoading, error, refetch } = useCycles();
  const [formOpen, setFormOpen] = useState(false);
  const cycles = data?.data || [];
  const navigate = useNavigate();
  const toast = useToast();
  const closeEnded = useCloseEndedCycles();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const today = localToday();
  const endedCount = cycles.filter((c) => isEnded(c, today) && !c.auto).length;

  async function handleCloseEnded() {
    try {
      const r = await closeEnded.mutateAsync();
      toast.success(t('calc.closeEndedDone', undefined, { n: r?.data?.closed ?? 0 }));
      setConfirmOpen(false);
      refetch();
    } catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }

  return (
    <div>
      <PageHeader
        icon={CalendarRange}
        title={t('nav.collectionCycles')}
        subtitle={t('coll.monthly_weekly_or_custom_collection')}
        actions={
          <>
            {/* Phase 10 Gap Audit fix — the Batches page (/collection-cycles/batches)
                existed and worked but had NO link anywhere in the UI leading to it
                (not here, not in Sidebar.jsx's NAV) — a user had to already know the
                exact URL. A cycle only becomes useful once batches are created from
                it, so this is the natural, narrow place to close that gap; purely
                additive, no other behavior on this page changes. */}
            <Button variant="secondary" icon={ClipboardList} onClick={() => navigate('/collection-cycles/batches')}>{t('coll.view_batches')}</Button>
            <RoleGate roles={['admin', 'gudoomiye']}>
              <Button
                variant="secondary"
                icon={Archive}
                onClick={() => setConfirmOpen(true)}
                disabled={endedCount === 0 || closeEnded.isPending}
                title={endedCount === 0 ? t('calc.closeEndedNone') : undefined}
              >
                {t('calc.closeEnded')}{endedCount > 0 ? ` (${endedCount})` : ''}
              </Button>
              <Button icon={Plus} onClick={() => setFormOpen(true)}>{t('coll.create_cycle')}</Button>
            </RoleGate>
          </>
        }
      />
      <LegacyOpsBanner />
      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && cycles.length === 0}
        emptyTitle={t('coll.no_collection_cycles_yet')}
        emptySubtitle={t('coll.create_the_first_cycle_to')}
        columns={[{ label: t('common.zone') }, { label: t('cust.type') }, { label: t('coll.start') }, { label: t('coll.end') }, { label: t('common.status') }, { label: t('fin.actions') }]}
      >
        {cycles.map((c) => <CycleRow key={c.id} cycle={c} onClosed={refetch} />)}
      </DataTable>
      <CycleFormModal open={formOpen} onClose={() => setFormOpen(false)} />
      <ConfirmDialog
        open={confirmOpen}
        title={t('calc.closeEndedTitle')}
        message={t('calc.closeEndedBody', undefined, { n: endedCount })}
        confirmLabel={t('calc.closeEnded')}
        isLoading={closeEnded.isPending}
        onConfirm={handleCloseEnded}
        onClose={() => { if (!closeEnded.isPending) setConfirmOpen(false); }}
      />
    </div>
  );
}

// User-requested gap-audit sweep ('sii wad qaybaha kale'): useCloseCycle()
// already existed in useCollectionOps.js, fully wired to the backend
// (PUT /v2/cycles/:id/close, sets is_active=false), but nothing here
// ever called it — a cycle, once created, could never be closed
// through the UI, only ever shown as permanently 'Active'.
function CycleRow({ cycle: c, onClosed }) {
  const { t } = useI18n();
  const closeCycle = useCloseCycle(c.id);
  const toast = useToast();
  async function handleClose() {
    try {
      await closeCycle.mutateAsync();
      toast.success(t('coll.cycle_closed'));
      onClosed?.();
    } catch (err) { toast.error(err.message || t('common.somethingWrong')); }
  }
  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={cellStyle}><strong>{c.zone_name}</strong></td>
      <td style={cellStyle}>
        <span style={{ textTransform: 'capitalize' }}>{c.cycle_type}</span>
        {c.auto && <span style={autoChipStyle}>{t('daily.auto')}</span>}
      </td>
      <td style={cellStyle} className="tabular-nums">{c.start_date}</td>
      <td style={cellStyle} className="tabular-nums">{c.end_date}</td>
      <td style={cellStyle}>
        <StatusBadge status={c.is_active ? 'Active' : 'Closed'} map={{ closed: 'info' }} />
        {isEnded(c, localToday()) && <span style={endedChipStyle} title={t('calc.endedHint')}>{t('calc.ended')}</span>}
      </td>
      <td style={cellStyle}>
        {c.is_active && (
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button variant="secondary" onClick={handleClose} disabled={closeCycle.isPending}>{closeCycle.isPending ? t('coll.closing') : t('common.close')}</Button>
          </RoleGate>
        )}
      </td>
    </tr>
  );
}

function CycleFormModal({ open, onClose }) {
  if (!open) return null;
  return <CycleFormContent onClose={onClose} />;
}

function CycleFormContent({ onClose }) {
  const { t } = useI18n();
  const [zoneId, setZoneId] = useState('');
  const [cycleType, setCycleType] = useState('monthly');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [endTouched, setEndTouched] = useState(false);
  const [error, setError] = useState('');

  // End date follows start date + type until the user edits it by hand.
  function applyAutoEnd(nextStart, nextType) {
    if (endTouched) return;
    const auto = suggestEndDate(nextStart, nextType);
    if (auto) setEndDate(auto);
  }
  const endIsAuto = !endTouched && !!endDate && endDate === suggestEndDate(startDate, cycleType);
  const { data: zonesData } = useZonesList();
  const createCycle = useCreateCycle();
  const toast = useToast();
  const zones = zonesData?.data || [];

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!zoneId || !startDate || !endDate) { setError(t('coll.zone_start_date_and_end')); return; }
    try {
      await createCycle.mutateAsync({ zone_id: parseInt(zoneId, 10), cycle_type: cycleType, start_date: startDate, end_date: endDate });
      toast.success(t('coll.collection_cycle_created'));
      onClose();
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      onClose={createCycle.isPending ? () => {} : onClose}
      title={t('coll.create_collection_cycle')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createCycle.isPending}>{t('common.cancel')}</Button>
          <Button type="submit" form="cycle-form" disabled={createCycle.isPending}>{createCycle.isPending ? t('common.saving') : t('coll.create_cycle')}</Button>
        </>
      }
    >
      <form id="cycle-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('common.zone')}</span>
          <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} style={inputStyle}>
            <option value="">{t('cust.select_a_zone')}</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('coll.cycle_type')}</span>
          <select value={cycleType} onChange={(e) => { setCycleType(e.target.value); applyAutoEnd(startDate, e.target.value); }} style={inputStyle}>
            <option value="monthly">{t('coll.monthly')}</option>
            <option value="weekly">{t('coll.weekly')}</option>
            <option value="custom">{t('coll.custom')}</option>
          </select>
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('coll.start_date')}</span>
            <input type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); applyAutoEnd(e.target.value, cycleType); }} style={inputStyle} />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('coll.end_date')}</span>
            <input type="date" value={endDate} onChange={(e) => { setEndDate(e.target.value); setEndTouched(true); }} style={inputStyle} />
          </label>
        </div>
        {(cycleType !== 'custom' || endIsAuto) && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {cycleType === 'weekly' && t('calc.spanRuleWeekly')}
            {cycleType === 'monthly' && t('calc.spanRuleMonthly')}
            {endIsAuto && <> {t('calc.endAutoFilled')}</>}
          </span>
        )}
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

// Browser-local today as YYYY-MM-DD. Only used for the Ended chip and the
// confirm count; the server decides with the company timezone.
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isEnded(c, today) {
  return !!c.is_active && !!c.end_date && String(c.end_date).slice(0, 10) < today;
}

// Suggested end date: weekly = start + 6 days (7-day span). Monthly = last
// day of the month when starting on the 1st; otherwise the day before the
// same date next month, so the span always stays inside the server's 28–31
// day rule. Custom: no suggestion.
function suggestEndDate(start, type) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start || '')) return '';
  const [y, m, d] = start.split('-').map(Number);
  const iso = (dt) => dt.toISOString().slice(0, 10);
  if (type === 'weekly') return iso(new Date(Date.UTC(y, m - 1, d + 6)));
  if (type === 'monthly') {
    if (d === 1) return iso(new Date(Date.UTC(y, m, 0)));
    const daysNext = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return iso(new Date(Date.UTC(y, m, Math.min(d, daysNext) - 1)));
  }
  return '';
}

const endedChipStyle = { marginLeft: '6px', fontSize: '11px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px', color: 'var(--warning)', border: '1px solid var(--warning)' };

const cellStyle = { padding: '12px 14px' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};

const autoChipStyle = { marginLeft: '6px', fontSize: '11px', fontWeight: 700, padding: '1px 7px', borderRadius: '999px', color: 'var(--info)', border: '1px solid var(--info)' };
