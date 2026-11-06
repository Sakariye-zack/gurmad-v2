import React, { useState } from 'react';
import { Wrench, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, FilterBar, StatCard, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useMaintenanceRecords, useCreateMaintenanceRecord, useUploadReceipt } from '../../hooks/useFleet.js';
import { useTrucks } from '../../hooks/useTrucks.js';
import { fmtMoney } from '../../lib/money.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import {
  MaintStatusBadge, MaintenanceActions, PartsEditor, cleanParts, ReceiptLink, Pill, fmtDate, fmtNum,
  cellStyle, fieldStyle, labelStyle, inputStyle, selectStyle, errStyle, grid2,
} from './fleetShared.jsx';

export default function FleetMaintenanceListPage() {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [truckId, setTruckId] = useState('');
  const [upcomingOnly, setUpcomingOnly] = useState(false);
  const [dueOnly, setDueOnly] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const { data, isLoading, error, refetch } = useMaintenanceRecords({
    q: search || undefined, status: status || undefined, truck_id: truckId || undefined,
    upcoming_service: upcomingOnly || undefined, due: dueOnly || undefined,
  });
  const { data: trucksData } = useTrucks({ status: 'all' });
  const trucks = trucksData?.data || [];
  const records = data?.data || [];
  const byCur = records.filter((r) => r.status === 'completed').reduce((acc, r) => { acc[r.currency || 'USD'] = (acc[r.currency || 'USD'] || 0) + parseFloat(r.cost); return acc; }, {});

  return (
    <div>
      <PageHeader
        icon={Wrench}
        title={t('fleet.m.title')}
        subtitle={t('fleet.m.subtitle')}
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>{t('fleet.m.log')}</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label={t('fleet.fuel.records')} value={error ? '—' : records.length} icon={Wrench} />
        <StatCard label={t('fleet.m.status.in_progress')} value={error ? '—' : records.filter((r) => r.status === 'in_progress').length} icon={Wrench} accent="var(--warning)" />
        <StatCard label={t('fleet.fuel.totalCost')} value={error ? '—' : (Object.keys(byCur).length ? Object.entries(byCur).map(([c, v]) => fmtMoney(v, c)).join(' + ') : fmtMoney(0, 'USD'))} icon={Wrench} />
      </div>

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder={t('common.search')}>
        <select aria-label={t('fleet.m.status')} value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle}>
          <option value="">{t('fleet.m.allStatuses')}</option>
          {['scheduled', 'in_progress', 'completed'].map((s) => <option key={s} value={s}>{t(`fleet.m.status.${s}`)}</option>)}
        </select>
        <select aria-label={t('fleet.common.truck')} value={truckId} onChange={(e) => setTruckId(e.target.value)} style={selectStyle}>
          <option value="">{t('fleet.fuel.allTrucks')}</option>
          {trucks.map((tr) => <option key={tr.id} value={tr.id}>{tr.plate_number}</option>)}
        </select>
        <label style={inlineLabel}><input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} /> {t('fleet.m.dueOnly')}</label>
        <label style={inlineLabel}><input type="checkbox" checked={upcomingOnly} onChange={(e) => setUpcomingOnly(e.target.checked)} /> {t('fleet.m.nextDate')}</label>
      </FilterBar>

      <MaintenanceTable records={records} loading={isLoading} error={error} onRetry={refetch} />

      <MaintenanceFormModal open={formOpen} onClose={() => setFormOpen(false)} trucks={trucks} />
    </div>
  );
}

export function MaintenanceTable({ records, loading, error, onRetry, hideTruck = false }) {
  const { t } = useI18n();
  const cols = [
    ...(hideTruck ? [] : [{ label: t('fleet.common.truck') }]),
    { label: t('fleet.m.description') }, { label: t('fleet.m.status') }, { label: t('fleet.m.cost'), align: 'right' },
    { label: t('fleet.m.nextDate') }, { label: t('fleet.m.downtime'), align: 'right' }, { label: t('fleet.m.provider') },
    { label: t('fleet.common.date') }, { label: t('fleet.fuel.receipt') }, { label: t('fleet.common.actions') },
  ];
  return (
    <DataTable loading={loading} error={error?.message} onRetry={onRetry} isEmpty={!loading && !error && records.length === 0} emptyTitle={t('fleet.m.none')} columns={cols}>
      {records.map((r) => (
        <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
          {!hideTruck && <td style={cellStyle}><strong>{r.plate_number}</strong></td>}
          <td style={cellStyle}>
            {r.description}
            {Array.isArray(r.parts) && r.parts.length > 0 && <div style={subText}>{r.parts.map((p) => `${p.name} ×${p.qty}`).join(', ')}</div>}
          </td>
          <td style={cellStyle}>
            <span style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }}>
              <MaintStatusBadge status={r.status} />
              {r.is_due && <Pill variant="warning">{t('fleet.card.due')}</Pill>}
            </span>
          </td>
          <td style={{ ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtMoney(r.cost, r.currency || 'USD')}</td>
          <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
            {r.next_service_date ? fmtDate(r.next_service_date) : '—'}
            {r.next_service_km !== null && r.next_service_km !== undefined && <div style={subText}>{fmtNum(r.next_service_km, 0)} km</div>}
          </td>
          <td style={{ ...cellStyle, textAlign: 'right' }}>{r.downtime_days !== null && r.downtime_days !== undefined ? t('fleet.m.days', undefined, { n: fmtNum(r.downtime_days) }) : '—'}</td>
          <td style={cellStyle}>{r.provider || '—'}</td>
          <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{fmtDate(r.scheduled_date || r.created_at)}</td>
          <td style={cellStyle}>
            {r.has_receipt ? <ReceiptLink path={`/v2/fleet/maintenance/${r.id}/receipt`} /> : <RoleGate roles={['admin', 'gudoomiye']}><ReceiptUploadButton id={r.id} /></RoleGate>}
          </td>
          <td style={cellStyle}><RoleGate roles={['admin', 'gudoomiye']}><MaintenanceActions record={r} /></RoleGate></td>
        </tr>
      ))}
    </DataTable>
  );
}

function ReceiptUploadButton({ id }) {
  const { t } = useI18n();
  const toast = useToast();
  const upload = useUploadReceipt();
  return (
    <label style={{ fontSize: '12px', fontWeight: 700, color: 'var(--brand)', cursor: 'pointer' }}>
      {upload.isPending ? '…' : t('fleet.common.upload')}
      <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          try { await upload.mutateAsync({ kind: 'maintenance', id, file }); toast.success(t('fleet.m.saved')); } catch (err) { toast.error(err.message); }
        }} />
    </label>
  );
}

export function MaintenanceFormModal({ open, onClose, trucks, defaultTruckId = '' }) {
  const { t } = useI18n();
  const [truckId, setTruckId] = useState(defaultTruckId ? String(defaultTruckId) : '');
  const [status, setStatus] = useState('completed');
  const [description, setDescription] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [cost, setCost] = useState('');
  const [parts, setParts] = useState([]);
  const [scheduledDate, setScheduledDate] = useState('');
  const [odometer, setOdometer] = useState('');
  const [nextServiceDate, setNextServiceDate] = useState('');
  const [nextKm, setNextKm] = useState('');
  const [intervalKm, setIntervalKm] = useState('');
  const [intervalDays, setIntervalDays] = useState('');
  const [provider, setProvider] = useState('');
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const create = useCreateMaintenanceRecord();
  const uploadReceipt = useUploadReceipt();
  const toast = useToast();
  const busy = create.isPending || uploadReceipt.isPending;

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const p = cleanParts(parts);
    const costVal = cost === '' ? null : parseFloat(cost);
    if (!truckId) { setError(t('fleet.common.required', undefined, { f: t('fleet.common.truck') })); return; }
    if (!description.trim()) { setError(t('fleet.common.required', undefined, { f: t('fleet.m.description') })); return; }
    if (status === 'completed' && !(costVal > 0) && !p.length) { setError(t('fleet.common.positive', undefined, { f: t('fleet.m.cost') })); return; }
    if (costVal !== null && (isNaN(costVal) || costVal < 0)) { setError(t('fleet.common.positive', undefined, { f: t('fleet.m.cost') })); return; }
    const int = (v) => (v === '' ? undefined : parseInt(v, 10));
    try {
      const result = await create.mutateAsync({
        truck_id: parseInt(truckId, 10), description: description.trim(), status, currency,
        ...(costVal !== null ? { cost: costVal } : {}), parts: p,
        scheduled_date: scheduledDate || undefined, next_service_date: nextServiceDate || undefined,
        odometer_at_service: int(odometer), next_service_km: int(nextKm), interval_km: int(intervalKm), interval_days: int(intervalDays),
        provider: provider.trim() || undefined,
      });
      if (file) {
        try { await uploadReceipt.mutateAsync({ kind: 'maintenance', id: result.data.id, file }); } catch (err) { toast.error(t('fleet.fuel.receiptFailed', undefined, { m: err.message })); }
      }
      toast.success(t('fleet.m.saved'));
      setDescription(''); setCost(''); setParts([]); setScheduledDate(''); setOdometer(''); setNextServiceDate(''); setNextKm('');
      setIntervalKm(''); setIntervalDays(''); setProvider(''); setFile(null);
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={t('fleet.m.log')}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t('fleet.common.cancel')}</Button>
        <Button type="submit" form="maintenance-form" disabled={busy}>{busy ? t('fleet.common.saving') : t('fleet.common.save')}</Button>
      </>}>
      <form id="maintenance-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={grid2}>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.common.truck')}</span>
            <select value={truckId} onChange={(e) => setTruckId(e.target.value)} style={inputStyle}>
              <option value="">—</option>
              {trucks.map((tr) => <option key={tr.id} value={tr.id}>{tr.plate_number}{tr.model ? ` — ${tr.model}` : ''}</option>)}
            </select></label>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.status')}</span>
            <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
              {['scheduled', 'in_progress', 'completed'].map((s) => <option key={s} value={s}>{t(`fleet.m.status.${s}`)}</option>)}
            </select></label>
        </div>
        <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.description')}</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} /></label>
        {status === 'scheduled' && (
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.scheduledDate')}</span>
            <input type="date" value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} style={inputStyle} /></label>
        )}
        <PartsEditor parts={parts} onChange={setParts} currency={currency} />
        <div style={grid2}>
          <label style={fieldStyle}><span style={labelStyle}>{status === 'completed' ? t('fleet.m.cost') : t('fleet.m.costHint')}</span>
            <input type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} style={inputStyle} /></label>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.currency')}</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle}>
              <option value="USD">USD</option><option value="SLSH">SLSH</option>
            </select></label>
        </div>
        <div style={grid2}>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.odometer')}</span>
            <input type="number" min="0" step="1" value={odometer} onChange={(e) => setOdometer(e.target.value)} style={inputStyle} /></label>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.nextKm')}</span>
            <input type="number" min="0" step="1" value={nextKm} onChange={(e) => setNextKm(e.target.value)} style={inputStyle} /></label>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.intervalKm')}</span>
            <input type="number" min="1" step="1" value={intervalKm} onChange={(e) => setIntervalKm(e.target.value)} style={inputStyle} /></label>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.intervalDays')}</span>
            <input type="number" min="1" step="1" value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} style={inputStyle} /></label>
        </div>
        <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.nextDate')}</span>
          <input type="date" value={nextServiceDate} onChange={(e) => setNextServiceDate(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.provider')}</span>
          <input value={provider} onChange={(e) => setProvider(e.target.value)} style={inputStyle} /></label>
        <label style={fieldStyle}><span style={labelStyle}>{t('fleet.fuel.receiptOptional')}</span>
          <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} style={{ fontSize: '13px', maxWidth: '100%' }} /></label>
        {error && <span style={errStyle}>{error}</span>}
      </form>
    </Modal>
  );
}

const subText = { fontSize: '11px', color: 'var(--text-muted)' };
const inlineLabel = { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700 };
