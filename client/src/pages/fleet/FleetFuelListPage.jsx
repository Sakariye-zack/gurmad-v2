import React, { useState } from 'react';
import { Fuel, Plus, Download } from 'lucide-react';
import { PageHeader, Button, DataTable, FilterBar, StatCard, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useFuelRecords, useCreateFuelRecord, useUploadReceipt, useConfirmFuelCurrency, fuelQueryString } from '../../hooks/useFleet.js';
import { useTrucks } from '../../hooks/useTrucks.js';
import { apiClient } from '../../lib/apiClient.js';
import { fmtMoney, fmtByCurrency } from '../../lib/money.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { FlagChips, ReceiptLink, usd, fmtNum, fmtDate, cellStyle, fieldStyle, labelStyle, inputStyle, selectStyle, errStyle, grid2 } from './fleetShared.jsx';

export default function FleetFuelListPage() {
  const { t } = useI18n();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [truckId, setTruckId] = useState('');
  const [month, setMonth] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [flagged, setFlagged] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const filters = { q: search || undefined, truck_id: truckId || undefined, month: month || undefined, date_from: dateFrom || undefined, date_to: dateTo || undefined, flagged: flagged || undefined };
  const { data, isLoading, error, refetch } = useFuelRecords(filters);
  const { data: trucksData } = useTrucks({ status: 'all' });
  const trucks = trucksData?.data || [];
  const records = data?.data || [];
  const totals = data?.meta?.totals;

  async function exportCsv() {
    try { await apiClient.downloadAuthorizedFile(`/v2/fleet/fuel.csv${fuelQueryString(filters)}`, 'fuel-records.csv'); } catch (err) { toast.error(err.message); }
  }

  return (
    <div>
      <PageHeader
        icon={Fuel}
        title={t('fleet.fuel.title')}
        subtitle={t('fleet.fuel.subtitle')}
        actions={<div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <Button variant="secondary" icon={Download} onClick={exportCsv}>{t('fleet.fuel.exportCsv')}</Button>
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>{t('fleet.fuel.log')}</Button>
          </RoleGate>
        </div>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label={t('fleet.fuel.records')} value={error || !totals ? '—' : totals.count} icon={Fuel} />
        <StatCard label={t('fleet.fuel.liters')} value={error || !totals ? '—' : fmtNum(totals.liters, 2)} icon={Fuel} />
        <StatCard label={t('fleet.fuel.totalCost')} value={error || !totals ? '—' : usd(totals.cost_usd)} sub={totals ? fmtByCurrency(totals.cost_by_currency) : undefined} icon={Fuel} />
        <StatCard label={t('fleet.fuel.avgKmpl')} value={error || !totals ? '—' : fmtNum(totals.km_per_liter)} sub={totals?.cost_per_km_usd ? `${t('fleet.fuel.costPerKm')}: ${fmtMoney(totals.cost_per_km_usd, 'USD')}` : undefined} icon={Fuel} />
      </div>

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder={t('common.search')}>
        <select aria-label={t('fleet.common.truck')} value={truckId} onChange={(e) => setTruckId(e.target.value)} style={selectStyle}>
          <option value="">{t('fleet.fuel.allTrucks')}</option>
          {trucks.map((tr) => <option key={tr.id} value={tr.id}>{tr.plate_number}</option>)}
        </select>
        <label style={inlineLabel}>{t('fleet.fuel.month')}
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={selectStyle} /></label>
        <label style={inlineLabel}>{t('fleet.fuel.from')}
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={selectStyle} /></label>
        <label style={inlineLabel}>{t('fleet.fuel.to')}
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={selectStyle} /></label>
        <label style={inlineLabel}>
          <input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} /> {t('fleet.fuel.flags')}
        </label>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && records.length === 0}
        emptyTitle={t('fleet.fuel.none')}
        columns={[{ label: t('fleet.common.truck') }, { label: t('fleet.common.date') }, { label: t('fleet.fuel.station') }, { label: t('fleet.fuel.liters'), align: 'right' },
          { label: t('fleet.fuel.pricePerLiter'), align: 'right' }, { label: t('fleet.m.cost'), align: 'right' }, { label: t('fleet.common.odometer'), align: 'right' },
          { label: t('fleet.fuel.kmSince'), align: 'right' }, { label: t('fleet.card.kmpl'), align: 'right' }, { label: t('fleet.fuel.costPerKm'), align: 'right' },
          { label: t('fleet.fuel.flags') }, { label: t('fleet.fuel.receipt') }]}
      >
        {records.map((r) => (
          <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={cellStyle}><strong>{r.plate_number}</strong></td>
            <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{fmtDate(r.record_date)}</td>
            <td style={cellStyle}>{r.station || '—'}</td>
            <td style={num}>{fmtNum(r.liters, 2)}</td>
            <td style={num}>{r.price_per_liter !== null ? fmtMoney(r.price_per_liter, r.currency) : '—'}</td>
            <td style={num}>
              {fmtMoney(r.cost, r.currency)}{r.currency === 'SLSH' && r.cost_usd !== null && <div style={sub}>≈ {usd(r.cost_usd)}</div>}
              {r.currency_confirmed === false && <div style={sub}>{t('fleet.fuel.currencyUnconfirmed')}</div>}
              {r.currency_confirmed === false && <RoleGate roles={['admin']}><ConfirmCurrencyChip id={r.id} /></RoleGate>}
            </td>
            <td style={num}>{r.odometer_reading ?? '—'}</td>
            <td style={num}>{fmtNum(r.km_since_last, 0)}</td>
            <td style={num}>{fmtNum(r.km_per_liter)}</td>
            <td style={num}>{r.cost_per_km_usd !== null ? fmtMoney(r.cost_per_km_usd, 'USD') : '—'}</td>
            <td style={cellStyle}><FlagChips flags={r.flags} /></td>
            <td style={cellStyle}>{r.has_receipt ? <ReceiptLink path={`/v2/fleet/fuel/${r.id}/receipt`} /> : '—'}</td>
          </tr>
        ))}
      </DataTable>

      <FuelFormModal open={formOpen} onClose={() => setFormOpen(false)} trucks={trucks} />
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
  const btn = { border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', borderRadius: '999px', padding: '1px 8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' };
  return (
    <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', marginTop: '4px', padding: '2px 6px', borderRadius: '999px', background: 'var(--warning-bg)', whiteSpace: 'nowrap' }}>
      <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--warning)' }}>{t('fleet.fuel.confirmCurrency')}</span>
      <button type="button" style={btn} disabled={confirm.isPending} onClick={() => pick('USD')}>USD</button>
      <button type="button" style={btn} disabled={confirm.isPending} onClick={() => pick('SLSH')}>SLSH</button>
    </span>
  );
}

function FuelFormModal({ open, onClose, trucks }) {
  const { t } = useI18n();
  const [truckId, setTruckId] = useState('');
  const [liters, setLiters] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [ppl, setPpl] = useState('');
  const [cost, setCost] = useState('');
  const [station, setStation] = useState('');
  const [odometer, setOdometer] = useState('');
  const [recordDate, setRecordDate] = useState('');
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState(null);
  const [error, setError] = useState('');
  const create = useCreateFuelRecord();
  const uploadReceipt = useUploadReceipt();
  const toast = useToast();
  const busy = create.isPending || uploadReceipt.isPending;

  if (!open) return null;

  function reset() {
    setTruckId(''); setLiters(''); setCurrency('USD'); setPpl(''); setCost(''); setStation(''); setOdometer(''); setRecordDate(''); setNotes(''); setFile(null); setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const litersVal = parseFloat(liters);
    const costVal = cost === '' ? null : parseFloat(cost);
    const pplVal = ppl === '' ? null : parseFloat(ppl);
    if (!truckId) { setError(t('fleet.common.required', undefined, { f: t('fleet.common.truck') })); return; }
    if (isNaN(litersVal) || litersVal <= 0) { setError(t('fleet.common.positive', undefined, { f: t('fleet.fuel.liters') })); return; }
    if (costVal === null && pplVal === null) { setError(t('fleet.common.required', undefined, { f: t('fleet.m.cost') })); return; }
    if ((costVal !== null && !(costVal > 0)) || (pplVal !== null && !(pplVal > 0))) { setError(t('fleet.common.positive', undefined, { f: t('fleet.m.cost') })); return; }
    if (file && file.size > 5 * 1024 * 1024) { setError('Max 5MB'); return; }
    try {
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
      reset();
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t('fleet.fuel.log')}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t('fleet.common.cancel')}</Button>
        <Button type="submit" form="fuel-form" disabled={busy}>{busy ? t('fleet.common.saving') : t('fleet.fuel.log')}</Button>
      </>}
    >
      <form id="fuel-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
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
        <label style={fieldStyle}><span style={labelStyle}>{t('fleet.fuel.receiptOptional')}</span>
          <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} style={{ fontSize: '13px', maxWidth: '100%' }} /></label>
        <label style={fieldStyle}><span style={labelStyle}>{t('fleet.common.notes')}</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle} /></label>
        {error && <span style={errStyle}>{error}</span>}
      </form>
    </Modal>
  );
}

const num = { ...cellStyle, textAlign: 'right', whiteSpace: 'nowrap' };
const sub = { fontSize: '11px', color: 'var(--text-muted)' };
const inlineLabel = { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700 };
