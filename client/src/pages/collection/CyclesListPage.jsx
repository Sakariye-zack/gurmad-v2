import React, { useState } from 'react';
import { CalendarRange, ClipboardList, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Button, DataTable, StatusBadge, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useCycles, useCreateCycle, useCloseCycle } from '../../hooks/useCollectionOps.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

export default function CyclesListPage() {
  const { t } = useI18n();
  const { data, isLoading, error, refetch } = useCycles();
  const [formOpen, setFormOpen] = useState(false);
  const cycles = data?.data || [];
  const navigate = useNavigate();

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
              <Button icon={Plus} onClick={() => setFormOpen(true)}>{t('coll.create_cycle')}</Button>
            </RoleGate>
          </>
        }
      />
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
      <td style={cellStyle}><span style={{ textTransform: 'capitalize' }}>{c.cycle_type}</span></td>
      <td style={cellStyle} className="tabular-nums">{c.start_date}</td>
      <td style={cellStyle} className="tabular-nums">{c.end_date}</td>
      <td style={cellStyle}><StatusBadge status={c.is_active ? 'Active' : 'Closed'} map={{ closed: 'info' }} /></td>
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
  const [error, setError] = useState('');
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
          <select value={cycleType} onChange={(e) => setCycleType(e.target.value)} style={inputStyle}>
            <option value="monthly">{t('coll.monthly')}</option>
            <option value="weekly">{t('coll.weekly')}</option>
            <option value="custom">{t('coll.custom')}</option>
          </select>
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('coll.start_date')}</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
          </label>
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('coll.end_date')}</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
          </label>
        </div>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

const cellStyle = { padding: '12px 14px' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
