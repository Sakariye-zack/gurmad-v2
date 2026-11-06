import React, { useEffect, useState } from 'react';
import { Fuel, Plus, Download, Search, Pencil, History, Receipt, Gauge, Droplets, Wallet, ListChecks, AlertTriangle } from 'lucide-react';
import { PageHeader, Button, Card, DataTable, StatCard, Modal, EmptyState, LoadingState, ErrorState, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import {
  useFuelRecords, useCreateFuelRecord, useUpdateFuelRecord, useFuelRevisions, useUploadReceipt, useConfirmFuelCurrency, fuelQueryString,
} from '../../hooks/useFleet.js';
import { useTrucks } from '../../hooks/useTrucks.js';
import { apiClient } from '../../lib/apiClient.js';
import { fmtMoney } from '../../lib/money.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { Pill, ReceiptLink, usd, fmtNum, fmtDate, cellStyle, fieldStyle, labelStyle, inputStyle, selectStyle, errStyle, grid2, iconBtn } from './fleetShared.jsx';

// True below 640px — the table becomes stacked cards.
function useIsNarrow(maxWidth = 640) {
  const query = `(max-width: ${maxWidth - 1}px)`;
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}

const WRITE_ROLES = ['admin', 'gudoomiye'];

// green = normal, amber = low efficiency, red = flagged (odometer problems).
function kmplColor(r) {
  if ((r.flags || []).some((f) => f.startsWith('odometer'))) return 'var(--danger)';
  if ((r.flags || []).includes('low_efficiency')) return 'var(--warning)';
  return r.km_per_liter ? 'var(--success)' : 'var(--text-muted)';
}

export default function FleetFuelListPage() {
  const { t } = useI18n();
  const toast = useToast();
  const narrow = useIsNarrow();
  const [search, setSearch] = useState('');
  const [truckId, setTruckId] = useState('');
  const [month, setMonth] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [flagged, setFlagged] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [historyFor, setHistoryFor] = useState(null);
  const filters = { q: search || undefined, truck_id: truckId || undefined, month: month || undefined, date_from: dateFrom || undefined, date_to: dateTo || undefined, flagged: flagged || undefined };
  const hasFilters = !!(search || truckId || month || dateFrom || dateTo || flagged);
  const { data, isLoading, error, refetch } = useFuelRecords(filters);
  const { data: trucksData } = useTrucks({ status: 'all' });
  const trucks = trucksData?.data || [];
  const records = data?.data || [];
  const totals = data?.meta?.totals;
  const ready = !error && !!totals;

  function clearFilters() { setSearch(''); setTruckId(''); setMonth(''); setDateFrom(''); setDateTo(''); setFlagged(false); }
  async function exportCsv() {
    try { await apiClient.downloadAuthorizedFile(`/v2/fleet/fuel.csv${fuelQueryString(filters)}`, 'fuel-records.csv'); } catch (err) { toast.error(err.message); }
  }

  const bothCurrencies = ready && Number(totals.cost_by_currency?.USD) > 0.004 && Number(totals.cost_by_currency?.SLSH) > 0.4;
  const costValue = !ready ? '—'
    : bothCurrencies
      ? <span style={{ fontSize: '17px', lineHeight: 1.3, display: 'inline-block' }}>{fmtMoney(totals.cost_by_currency.USD, 'USD')} · {fmtMoney(totals.cost_by_currency.SLSH, 'SLSH')}</span>
      : usd(totals.cost_usd);
  const costSub = !ready ? undefined
    : bothCurrencies ? `${usd(totals.cost_usd)} ${t('fleet.fuel.approxUsdTotal')}`
      : (totals.cost_by_currency?.SLSH > 0.4 && !(totals.cost_by_currency?.USD > 0.004) ? `${fmtMoney(totals.cost_by_currency.SLSH, 'SLSH')}` : undefined);

  const openEdit = (r) => setEditing(r);
  const openHistory = (r) => setHistoryFor(r);

  return (
    <div>
      <PageHeader
        icon={Fuel}
        title={t('fleet.fuel.title')}
        subtitle={t('fleet.fuel.subtitle')}
        actions={<div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <Button variant="secondary" icon={Download} onClick={exportCsv}>{t('fleet.fuel.exportCsv')}</Button>
          <RoleGate roles={WRITE_ROLES}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>{t('fleet.fuel.log')}</Button>
          </RoleGate>
        </div>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '12px', marginBottom: '16px', alignItems: 'stretch' }}>
        <div style={{ display: 'grid' }}><StatCard label={t('fleet.fuel.records')} value={ready ? totals.count : '—'} icon={ListChecks} /></div>
        <div style={{ display: 'grid' }}><StatCard label={t('fleet.fuel.liters')} value={ready ? fmtNum(totals.liters, 2) : '—'} icon={Droplets} accent="var(--info)" /></div>
        <div style={{ display: 'grid' }}><StatCard label={t('fleet.fuel.totalCost')} value={costValue} sub={costSub} icon={Wallet} accent="var(--accent)" /></div>
        <div style={{ display: 'grid' }}><StatCard label={t('fleet.fuel.avgKmpl')} value={ready ? fmtNum(totals.km_per_liter) : '—'}
          sub={totals?.cost_per_km_usd ? `${t('fleet.fuel.costPerKm')}: ${fmtMoney(totals.cost_per_km_usd, 'USD')}` : undefined} icon={Gauge} /></div>
      </div>

      <Card style={{ padding: '12px 14px', marginBottom: '14px' }}>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ position: 'relative', flex: '2 1 200px', minWidth: 0 }}>
            <Search size={15} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input aria-label={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('common.search')}
              style={{ ...inputStyle, padding: '9px 12px 9px 32px', fontSize: '13px' }} />
          </div>
          <label style={{ ...filterField, flex: '1 1 150px' }}>
            <span style={filterLabel}>{t('fleet.common.truck')}</span>
            <select value={truckId} onChange={(e) => setTruckId(e.target.value)} style={fullSelect}>
              <option value="">{t('fleet.fuel.allTrucks')}</option>
              {trucks.map((tr) => <option key={tr.id} value={tr.id}>{tr.plate_number}</option>)}
            </select>
          </label>
          <label style={{ ...filterField, flex: '1 1 130px' }}><span style={filterLabel}>{t('fleet.fuel.month')}</span>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={fullSelect} /></label>
          <label style={{ ...filterField, flex: '1 1 130px' }}><span style={filterLabel}>{t('fleet.fuel.from')}</span>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={fullSelect} /></label>
          <label style={{ ...filterField, flex: '1 1 130px' }}><span style={filterLabel}>{t('fleet.fuel.to')}</span>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={fullSelect} /></label>
          <button type="button" aria-pressed={flagged} onClick={() => setFlagged((v) => !v)}
            style={{ ...toggleChip, ...(flagged ? { background: 'var(--warning-bg)', color: 'var(--warning)', borderColor: 'var(--warning)' } : null) }}>
            <AlertTriangle size={13} /> {t('fleet.fuel.flaggedOnly')}
          </button>
          {hasFilters && <button type="button" onClick={clearFilters} style={{ background: 'none', border: 'none', color: 'var(--brand-dark)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: '10px 4px' }}>{t('fleet.fuel.clearFilters')}</button>}
        </div>
      </Card>

      {narrow ? (
        <CardList loading={isLoading} error={error} onRetry={refetch} records={records} hasFilters={hasFilters} onLog={() => setFormOpen(true)} onEdit={openEdit} onHistory={openHistory} />
      ) : (
        <DataTable
          loading={isLoading}
          error={error?.message}
          onRetry={refetch}
          isEmpty={!isLoading && !error && records.length === 0}
          emptyTitle={hasFilters ? t('fleet.fuel.noMatch') : t('fleet.fuel.none')}
          emptySubtitle={hasFilters ? undefined : t('fleet.fuel.noneHint')}
          columns={[{ label: t('fleet.common.truck') }, { label: t('fleet.common.date') }, { label: t('fleet.fuel.liters'), align: 'right' },
            { label: t('fleet.fuel.pricePerLiter'), align: 'right' }, { label: t('fleet.m.cost'), align: 'right' }, { label: t('fleet.common.odometer'), align: 'right' },
            { label: t('fleet.fuel.kmSince'), align: 'right' }, { label: t('fleet.card.kmpl'), align: 'right' }, { label: t('fleet.fuel.costPerKm'), align: 'right' },
            { label: t('fleet.fuel.flags') }, { label: t('fleet.fuel.receipt') }, { label: t('fleet.common.actions'), align: 'right' }]}
        >
          {records.map((r) => (
            <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={cellStyle}>
                <div style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{r.plate_number}</div>
                {r.station && <div style={sub}>{r.station}</div>}
              </td>
              <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{fmtDate(r.record_date)}<EditedChip r={r} /></td>
              <td style={num}>{fmtNum(r.liters, 2)}</td>
              <td style={num}>{r.price_per_liter !== null ? fmtMoney(r.price_per_liter, r.currency) : '—'}</td>
              <td style={num}><CostCell r={r} /></td>
              <td style={num}>{r.odometer_reading ?? '—'}</td>
              <td style={num}>{fmtNum(r.km_since_last, 0)}</td>
              <td style={{ ...num, fontWeight: 800, color: kmplColor(r) }}>{fmtNum(r.km_per_liter)}</td>
              <td style={num}>{r.cost_per_km_usd !== null ? fmtMoney(r.cost_per_km_usd, 'USD') : '—'}</td>
              <td style={cellStyle}><Chips flags={r.flags} /></td>
              <td style={cellStyle}>{r.has_receipt ? <ReceiptLink path={`/v2/fleet/fuel/${r.id}/receipt`} icon={Receipt} /> : <span style={sub}>—</span>}</td>
              <td style={{ ...cellStyle, textAlign: 'right' }}><RowActions r={r} onEdit={openEdit} onHistory={openHistory} /></td>
            </tr>
          ))}
        </DataTable>
      )}

      {formOpen && <FuelFormModal key="create" onClose={() => setFormOpen(false)} trucks={trucks} />}
      {editing && <FuelFormModal key={`edit-${editing.id}`} record={editing} onClose={() => setEditing(null)} trucks={trucks} />}
      {historyFor && <HistoryModal record={historyFor} trucks={trucks} onClose={() => setHistoryFor(null)} />}
    </div>
  );
}

function EditedChip({ r }) {
  const { t } = useI18n();
  if (!r.edited_at) return null;
  const tip = t('fleet.fuel.editedTip', undefined, { d: String(r.edited_at).slice(0, 16).replace('T', ' '), u: r.edited_by_name || '—' });
  return <div style={{ marginTop: '3px' }}><Pill variant="info" title={tip}>{t('fleet.fuel.edited')}</Pill></div>;
}

function Chips({ flags }) {
  const { t } = useI18n();
  if (!flags || !flags.length) return <span style={sub}>—</span>;
  return (
    <span style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }}>
      {flags.map((f) => {
        const label = t(`fleet.fuel.flag.${f}`, f);
        return <Pill key={f} variant={f.startsWith('odometer') ? 'danger' : 'warning'} title={label}>{label}</Pill>;
      })}
    </span>
  );
}

function CostCell({ r }) {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}>
      <strong className="tabular-nums">{fmtMoney(r.cost, r.currency)}</strong>
      {r.currency === 'SLSH' && r.cost_usd !== null && <span style={sub}>≈ {usd(r.cost_usd)}</span>}
      {r.currency_confirmed === false && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Pill variant="warning" title={t('fleet.fuel.currencyUnconfirmed')}>{t('fleet.fuel.unconfirmed')}</Pill>
          <RoleGate roles={['admin']}><ConfirmCurrencyChip id={r.id} /></RoleGate>
        </span>
      )}
    </div>
  );
}

function RowActions({ r, onEdit, onHistory }) {
  const { t } = useI18n();
  return (
    <span style={{ display: 'inline-flex', gap: '6px' }}>
      <RoleGate roles={WRITE_ROLES}>
        <button type="button" style={iconBtn} title={t('fleet.fuel.edit')} aria-label={t('fleet.fuel.edit')} onClick={() => onEdit(r)}><Pencil size={14} /></button>
      </RoleGate>
      <button type="button" style={iconBtn} title={t('fleet.fuel.history')} aria-label={t('fleet.fuel.history')} onClick={() => onHistory(r)}><History size={14} /></button>
    </span>
  );
}

// Mobile: one stacked card per fill-up.
function CardList({ loading, error, onRetry, records, hasFilters, onLog, onEdit, onHistory }) {
  const { t } = useI18n();
  if (loading) return <LoadingState label={t('common.loading')} />;
  if (error) return <ErrorState message={error.message} onRetry={onRetry} />;
  if (records.length === 0) {
    return (
      <Card style={{ padding: '8px' }}>
        <EmptyState icon={Fuel} title={hasFilters ? t('fleet.fuel.noMatch') : t('fleet.fuel.none')} subtitle={hasFilters ? undefined : t('fleet.fuel.noneHint')} />
        {!hasFilters && <RoleGate roles={WRITE_ROLES}><div style={{ textAlign: 'center', paddingBottom: '16px' }}><Button icon={Plus} onClick={onLog}>{t('fleet.fuel.log')}</Button></div></RoleGate>}
      </Card>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {records.map((r) => (
        <Card key={r.id} style={{ padding: '14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: '15px' }}>{r.plate_number}</div>
              <div style={sub}>{fmtDate(r.record_date)}{r.station ? ` · ${r.station}` : ''}</div>
            </div>
            <div style={{ textAlign: 'right' }}><CostCell r={r} /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', margin: '12px 0' }}>
            <Fact label={t('fleet.fuel.liters')} value={fmtNum(r.liters, 2)} />
            <Fact label={t('fleet.fuel.pricePerLiter')} value={r.price_per_liter !== null ? fmtMoney(r.price_per_liter, r.currency) : '—'} />
            <Fact label={t('fleet.common.odometer')} value={r.odometer_reading ?? '—'} />
            <Fact label={t('fleet.fuel.kmSince')} value={fmtNum(r.km_since_last, 0)} />
            <Fact label={t('fleet.card.kmpl')} value={fmtNum(r.km_per_liter)} color={kmplColor(r)} />
            <Fact label={t('fleet.fuel.costPerKm')} value={r.cost_per_km_usd !== null ? fmtMoney(r.cost_per_km_usd, 'USD') : '—'} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ display: 'inline-flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
              {(r.flags || []).length > 0 && <Chips flags={r.flags} />}
              {r.edited_at && <EditedChip r={r} />}
            </span>
            <span style={{ display: 'inline-flex', gap: '6px', alignItems: 'center' }}>
              {r.has_receipt && <ReceiptLink path={`/v2/fleet/fuel/${r.id}/receipt`} icon={Receipt} />}
              <RowActions r={r} onEdit={onEdit} onHistory={onHistory} />
            </span>
          </div>
        </Card>
      ))}
    </div>
  );
}

function Fact({ label, value, color }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{label}</div>
      <div className="tabular-nums" style={{ fontSize: '14px', fontWeight: 700, color: color || 'var(--text)' }}>{value}</div>
    </div>
  );
}

function ConfirmCurrencyChip({ id }) {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirmFuelCurrency();
  const pick = async (currency) => {
    try { await confirm.mutateAsync({ id, currency }); toast.success(t('fleet.fuel.currencyConfirmed')); } catch (err) { toast.error(err.message); }
  };
  const btn = { border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', borderRadius: '999px', padding: '0 7px', fontSize: '10px', fontWeight: 700, cursor: 'pointer', lineHeight: '18px' };
  return (
    <span style={{ display: 'inline-flex', gap: '3px', alignItems: 'center' }} title={t('fleet.fuel.confirmCurrency')}>
      <button type="button" style={btn} disabled={confirm.isPending} onClick={() => pick('USD')}>USD</button>
      <button type="button" style={btn} disabled={confirm.isPending} onClick={() => pick('SLSH')}>SLSH</button>
    </span>
  );
}

const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

// Log Fuel (no `record`) and Edit (with `record`) share one form.
function FuelFormModal({ record, onClose, trucks }) {
  const { t } = useI18n();
  const isEdit = !!record;
  const [truckId, setTruckId] = useState(isEdit ? String(record.truck_id) : '');
  const [liters, setLiters] = useState(isEdit ? String(Number(record.liters)) : '');
  const [currency, setCurrency] = useState(isEdit ? record.currency : 'USD');
  const [ppl, setPpl] = useState(isEdit && record.price_per_liter !== null ? String(Number(record.price_per_liter)) : '');
  const [cost, setCost] = useState(isEdit ? String(Number(record.cost)) : '');
  const [station, setStation] = useState(isEdit ? record.station || '' : '');
  const [odometer, setOdometer] = useState(isEdit && record.odometer_reading !== null ? String(record.odometer_reading) : '');
  const [recordDate, setRecordDate] = useState(isEdit ? fmtDate(record.record_date) : '');
  const [notes, setNotes] = useState(isEdit ? record.notes || '' : '');
  const [reason, setReason] = useState('');
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const create = useCreateFuelRecord();
  const update = useUpdateFuelRecord();
  const uploadReceipt = useUploadReceipt();
  const toast = useToast();
  const busy = create.isPending || update.isPending || uploadReceipt.isPending;

  function validate() {
    const litersVal = parseFloat(liters);
    const costVal = cost === '' ? null : parseFloat(cost);
    const pplVal = ppl === '' ? null : parseFloat(ppl);
    if (!truckId) return { err: t('fleet.common.required', undefined, { f: t('fleet.common.truck') }) };
    if (isNaN(litersVal) || litersVal <= 0) return { err: t('fleet.common.positive', undefined, { f: t('fleet.fuel.liters') }) };
    if (costVal === null && pplVal === null) return { err: t('fleet.common.required', undefined, { f: t('fleet.m.cost') }) };
    if ((costVal !== null && !(costVal > 0)) || (pplVal !== null && !(pplVal > 0))) return { err: t('fleet.common.positive', undefined, { f: t('fleet.m.cost') }) };
    return { litersVal, costVal, pplVal };
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const v = validate();
    if (v.err) { setError(v.err); return; }
    const { litersVal, costVal, pplVal } = v;
    try {
      if (isEdit) {
        const why = reason.trim();
        if (why.length < 3 || why.length > 300) { setError(t('fleet.fuel.reasonLength')); return; }
        // Send only what changed; the server recomputes price/L when cost or liters change.
        const body = { id: record.id, reason: why };
        if (parseInt(truckId, 10) !== record.truck_id) body.truck_id = parseInt(truckId, 10);
        if (litersVal !== Number(record.liters)) body.liters = litersVal;
        if (currency !== record.currency) body.currency = currency;
        if (costVal !== null && costVal !== Number(record.cost)) body.cost = costVal;
        if (pplVal !== null && pplVal !== numOrNull(record.price_per_liter)) body.price_per_liter = pplVal;
        if (numOrNull(odometer) !== (record.odometer_reading ?? null)) body.odometer_reading = odometer === '' ? null : parseInt(odometer, 10);
        if (recordDate && recordDate !== fmtDate(record.record_date)) body.record_date = recordDate;
        if (station.trim() !== (record.station || '')) body.station = station.trim() || null;
        if (notes.trim() !== (record.notes || '')) body.notes = notes.trim() || null;
        await update.mutateAsync(body);
        toast.success(t('fleet.fuel.updated'));
        onClose();
        return;
      }
      if (file && file.size > 5 * 1024 * 1024) { setError('Max 5MB'); return; }
      const result = await create.mutateAsync({
        truck_id: parseInt(truckId, 10), liters: litersVal, currency,
        ...(costVal !== null ? { cost: costVal } : {}), ...(pplVal !== null ? { price_per_liter: pplVal } : {}),
        station: station.trim() || undefined,
        odometer_reading: odometer ? parseInt(odometer, 10) : undefined,
        record_date: recordDate || undefined, notes: notes.trim() || undefined,
      });
      if (file) {
        try { await uploadReceipt.mutateAsync({ kind: 'fuel', id: result.data.id, file }); } catch (err) { toast.error(t('fleet.fuel.receiptFailed', undefined, { m: err.message })); }
      }
      toast.success(result.data.flags?.length ? t('fleet.fuel.loggedReview') : t('fleet.fuel.logged'));
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={isEdit ? t('fleet.fuel.editTitle') : t('fleet.fuel.log')}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t('fleet.common.cancel')}</Button>
        <Button type="submit" form="fuel-form" disabled={busy}>{busy ? t('fleet.common.saving') : (isEdit ? t('fleet.common.save') : t('fleet.fuel.log'))}</Button>
      </>}
    >
      <form id="fuel-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {isEdit && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--warning-bg)', color: 'var(--warning)', fontSize: '12px', fontWeight: 700 }}>
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: '1px' }} /> {t('fleet.fuel.historyWarning')}
          </div>
        )}
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('fleet.common.truck')}</span>
          <select value={truckId} onChange={(e) => setTruckId(e.target.value)} style={inputStyle}>
            <option value="">—</option>
            {trucks.map((tr) => <option key={tr.id} value={tr.id}>{tr.plate_number}{tr.model ? ` — ${tr.model}` : ''}</option>)}
          </select>
        </label>
        <div style={grid2}>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.fuel.liters')}</span>
            <input type="number" min="0.01" step="0.01" value={liters} onChange={(e) => setLiters(e.target.value)} style={inputStyle} /></label>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.currency')}</span>
            <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={inputStyle}>
              <option value="USD">USD</option><option value="SLSH">SLSH</option>
            </select></label>
        </div>
        <div style={grid2}>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.fuel.pricePerLiter')}</span>
            <input type="number" min="0" step="0.0001" value={ppl} onChange={(e) => setPpl(e.target.value)} style={inputStyle} /></label>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.cost')}</span>
            <input type="number" min="0.01" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} style={inputStyle}
              placeholder={ppl && liters ? String(Math.round(parseFloat(ppl) * parseFloat(liters) * 100) / 100) : ''} /></label>
        </div>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '-6px' }}>{t('fleet.fuel.pricePerLiterHint')}</span>
        <label style={fieldStyle}><span style={labelStyle}>{t('fleet.fuel.station')}</span>
          <input maxLength={150} value={station} onChange={(e) => setStation(e.target.value)} style={inputStyle} /></label>
        <div style={grid2}>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.common.odometer')}</span>
            <input type="number" min="0" step="1" value={odometer} onChange={(e) => setOdometer(e.target.value)} style={inputStyle} /></label>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.common.date')}</span>
            <input type="date" value={recordDate} onChange={(e) => setRecordDate(e.target.value)} style={inputStyle} /></label>
        </div>
        {!isEdit && (
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.fuel.receiptOptional')}</span>
            <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} style={{ fontSize: '13px', maxWidth: '100%' }} /></label>
        )}
        <label style={fieldStyle}><span style={labelStyle}>{t('fleet.common.notes')}</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle} /></label>
        {isEdit && (
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.fuel.reason')} *</span>
            <textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} style={{ ...inputStyle, resize: 'vertical' }} />
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('fleet.fuel.reasonHint')}</span></label>
        )}
        {error && <span style={errStyle}>{error}</span>}
      </form>
    </Modal>
  );
}

function HistoryModal({ record, trucks, onClose }) {
  const { t } = useI18n();
  const { data, isLoading, error, refetch } = useFuelRevisions(record.id);
  const revisions = data?.data || [];
  const plateOf = (id) => trucks.find((tr) => tr.id === Number(id))?.plate_number || `#${id}`;

  function fmtValue(key, value, side, rv) {
    if (value === null || value === undefined || value === '') return '—';
    const cur = side.currency ?? rv.after?.currency ?? rv.before?.currency ?? record.currency;
    if (key === 'cost' || key === 'price_per_liter') return fmtMoney(value, cur);
    if (key === 'liters') return fmtNum(value, 2);
    if (key === 'truck_id') return plateOf(value);
    if (key === 'record_date') return fmtDate(value);
    if (key === 'currency_confirmed') return value ? '✓' : '✗';
    return String(value);
  }

  return (
    <Modal open onClose={onClose} title={`${t('fleet.fuel.historyTitle')} — ${record.plate_number}`} maxWidth="560px">
      {isLoading ? <LoadingState label={t('common.loading')} />
        : error ? <ErrorState message={error.message} onRetry={refetch} />
          : revisions.length === 0 ? <EmptyState icon={History} title={t('fleet.fuel.historyNone')} />
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {revisions.map((rv) => (
                  <div key={rv.id} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '12px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', fontSize: '12px', color: 'var(--text-muted)' }}>
                      <strong style={{ color: 'var(--text)' }}>{rv.changed_by_name || '—'}</strong>
                      <span>{String(rv.changed_at).slice(0, 16).replace('T', ' ')}</span>
                    </div>
                    <div style={{ margin: '6px 0 8px', fontSize: '13px', fontStyle: 'italic' }}>“{rv.reason}”</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                      {Object.keys(rv.after || {}).map((k) => (
                        <div key={k} style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'baseline' }}>
                          <span style={{ fontWeight: 700, minWidth: '110px' }}>{t(`fleet.fuel.field.${k}`, k)}</span>
                          <span className="tabular-nums" style={{ color: 'var(--danger)', textDecoration: 'line-through' }}>{fmtValue(k, rv.before?.[k], rv.before || {}, rv)}</span>
                          <span aria-hidden="true">→</span>
                          <span className="tabular-nums" style={{ color: 'var(--success)', fontWeight: 700 }}>{fmtValue(k, rv.after[k], rv.after || {}, rv)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
    </Modal>
  );
}

const num = { ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
const sub = { fontSize: '11px', color: 'var(--text-muted)' };
const filterField = { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 };
const filterLabel = { fontSize: '10px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' };
const fullSelect = { ...selectStyle, width: '100%' };
const toggleChip = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 12px', borderRadius: '999px', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text-muted)', fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
};
