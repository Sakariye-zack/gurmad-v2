import React, { useEffect, useState } from 'react';
import { Truck as TruckIcon } from 'lucide-react';
import { Button, Modal, StatusBadge, useToast } from '../../components/ui/index.js';
import { apiClient } from '../../lib/apiClient.js';
import { fmtMoney } from '../../lib/money.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { useRenewDocument, useUpdateMaintenanceStatus } from '../../hooks/useFleet.js';

// Shared pieces of the fleet pages (overview, fuel, maintenance, truck).

export const usd = (n) => (n === null || n === undefined ? '—' : fmtMoney(n, 'USD'));
export const fmtNum = (n, dp = 1) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: dp }));
export const fmtDate = (d) => (d ? String(d).slice(0, 10) : '—');

export const MAINT_STATUS_MAP = { scheduled: 'info', in_progress: 'warning', completed: 'success' };
export const LIVE_MAP = { live: 'success', idle: 'warning', offline: 'danger', no_signal: 'info' };

export function MaintStatusBadge({ status }) {
  const { t } = useI18n();
  const variant = MAINT_STATUS_MAP[status] || 'info';
  return <Pill variant={variant}>{t(`fleet.m.status.${status}`, status)}</Pill>;
}

export function Pill({ variant = 'info', children, title }) {
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '2px 9px', borderRadius: '999px',
      fontSize: '11px', fontWeight: 700, background: `var(--${variant}-bg)`, color: `var(--${variant})`, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: `var(--${variant})` }} />
      {children}
    </span>
  );
}

export function FlagChips({ flags }) {
  const { t } = useI18n();
  if (!flags || !flags.length) return null;
  return (
    <span style={{ display: 'inline-flex', gap: '4px', flexWrap: 'wrap' }}>
      {flags.map((f) => <Pill key={f} variant={f.startsWith('odometer') ? 'danger' : 'warning'}>{t(`fleet.fuel.flag.${f}`, f)}</Pill>)}
    </span>
  );
}

// Opens an authenticated file (receipt / photo) in a new tab.
export function ReceiptLink({ path, icon: Icon }) {
  const { t } = useI18n();
  const toast = useToast();
  async function open() {
    const w = window.open('', '_blank');
    try {
      const url = await apiClient.fetchAuthorizedFileUrl(path);
      if (w) w.location.href = url; else window.location.href = url;
      // The new tab has loaded the blob by then; free it.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      if (w) w.close();
      toast.error(err.message);
    }
  }
  if (Icon) return <button type="button" onClick={open} title={t('fleet.fuel.receipt')} aria-label={t('fleet.fuel.receipt')} style={iconBtn}><Icon size={15} /></button>;
  return <button type="button" onClick={open} style={linkBtn}>{t('fleet.common.view')}</button>;
}

// Authenticated <img> thumbnail; falls back to a truck icon.
export function TruckPhoto({ path, size = 56, radius = 'var(--radius-sm)' }) {
  const [loaded, setLoaded] = useState({ path: null, url: null });
  useEffect(() => {
    let url = null; let cancelled = false;
    if (path) {
      apiClient.fetchAuthorizedFileUrl(path).then((u) => {
        if (cancelled) { URL.revokeObjectURL(u); return; } // path changed / unmounted before it arrived
        url = u; setLoaded({ path, url: u });
      }).catch(() => {});
    }
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [path]);
  const src = path && loaded.path === path ? loaded.url : null;
  const box = { width: size, height: size, borderRadius: radius, flexShrink: 0, background: 'var(--bg)', border: '1px solid var(--border)' };
  if (!src) return <div style={{ ...box, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}><TruckIcon size={size * 0.45} /></div>;
  return <img src={src} alt="" style={{ ...box, objectFit: 'cover' }} />;
}

export function RenewModal({ target, onClose }) {
  if (!target) return null;
  return <RenewForm key={`${target.truckId}-${target.document}`} target={target} onClose={onClose} />;
}

function RenewForm({ target, onClose }) {
  const { t } = useI18n();
  const toast = useToast();
  const renew = useRenewDocument();
  const [date, setDate] = useState('');
  const [error, setError] = useState('');
  const docLabel = t(`fleet.doc.${target.document}`, target.document);
  async function submit(e) {
    e.preventDefault();
    if (!date) { setError(t('fleet.common.required', undefined, { f: t('fleet.renew.newExpiry') })); return; }
    try {
      await renew.mutateAsync({ truckId: target.truckId, document: target.document, new_expiry: date });
      toast.success(t('fleet.renew.done'));
      onClose();
    } catch (err) { setError(err.message); }
  }
  return (
    <Modal open onClose={renew.isPending ? () => {} : onClose} title={t('fleet.renew.title', undefined, { doc: docLabel })}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={renew.isPending}>{t('fleet.common.cancel')}</Button>
        <Button type="submit" form="renew-form" disabled={renew.isPending}>{renew.isPending ? t('fleet.common.saving') : t('fleet.renew')}</Button>
      </>}>
      <form id="renew-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {target.plate && <div style={{ fontSize: '13px' }}><strong>{target.plate}</strong> · {docLabel} · {fmtDate(target.current)}</div>}
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('fleet.renew.newExpiry')}</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
        </label>
        {error && <span style={errStyle}>{error}</span>}
      </form>
    </Modal>
  );
}

// Start / Complete buttons for a maintenance job (write roles only — the
// caller wraps this in a RoleGate).
export function MaintenanceActions({ record }) {
  const { t } = useI18n();
  const toast = useToast();
  const update = useUpdateMaintenanceStatus();
  const [completeOpen, setCompleteOpen] = useState(false);
  if (record.status === 'completed') return null;
  async function start() {
    try { await update.mutateAsync({ id: record.id, status: 'in_progress' }); toast.success(t('fleet.m.statusChanged')); } catch (err) { toast.error(err.message); }
  }
  return (
    <span style={{ display: 'inline-flex', gap: '6px', flexWrap: 'wrap' }}>
      {record.status === 'scheduled' && <Button variant="secondary" onClick={start} disabled={update.isPending}>{t('fleet.m.start')}</Button>}
      <Button onClick={() => setCompleteOpen(true)} disabled={update.isPending}>{t('fleet.m.complete')}</Button>
      {completeOpen && <CompleteModal record={record} onClose={() => setCompleteOpen(false)} />}
    </span>
  );
}

function CompleteModal({ record, onClose }) {
  const { t } = useI18n();
  const toast = useToast();
  const update = useUpdateMaintenanceStatus();
  const [cost, setCost] = useState(Number(record.cost) > 0 ? String(record.cost) : '');
  const [odometer, setOdometer] = useState(record.odometer_at_service ?? '');
  const [nextKm, setNextKm] = useState(record.next_service_km ?? '');
  const [nextDate, setNextDate] = useState(record.next_service_date || '');
  const [parts, setParts] = useState(Array.isArray(record.parts) ? record.parts : []);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    setError('');
    const body = { id: record.id, status: 'completed', parts: cleanParts(parts) };
    if (cost !== '') body.cost = parseFloat(cost);
    if (odometer !== '') body.odometer_at_service = parseInt(odometer, 10);
    if (nextKm !== '') body.next_service_km = parseInt(nextKm, 10);
    if (nextDate) body.next_service_date = nextDate;
    try {
      await update.mutateAsync(body);
      toast.success(t('fleet.m.statusChanged'));
      onClose();
    } catch (err) { setError(err.message); }
  }
  return (
    <Modal open onClose={update.isPending ? () => {} : onClose} title={t('fleet.m.completeTitle')}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={update.isPending}>{t('fleet.common.cancel')}</Button>
        <Button type="submit" form={`complete-${record.id}`} disabled={update.isPending}>{update.isPending ? t('fleet.common.saving') : t('fleet.m.complete')}</Button>
      </>}>
      <form id={`complete-${record.id}`} onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ fontSize: '13px' }}><strong>{record.plate_number}</strong> · {record.description}</div>
        <PartsEditor parts={parts} onChange={setParts} currency={record.currency} />
        <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.cost')} ({record.currency})</span>
          <input type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} style={inputStyle} /></label>
        <div style={grid2}>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.odometer')}</span>
            <input type="number" min="0" step="1" value={odometer} onChange={(e) => setOdometer(e.target.value)} style={inputStyle} /></label>
          <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.nextKm')}</span>
            <input type="number" min="0" step="1" value={nextKm} onChange={(e) => setNextKm(e.target.value)} style={inputStyle} /></label>
        </div>
        <label style={fieldStyle}><span style={labelStyle}>{t('fleet.m.nextDate')}</span>
          <input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} style={inputStyle} /></label>
        {error && <span style={errStyle}>{error}</span>}
      </form>
    </Modal>
  );
}

export function PartsEditor({ parts, onChange, currency }) {
  const { t } = useI18n();
  const set = (i, k, v) => onChange(parts.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const total = parts.reduce((s, p) => s + (Number(p.qty) || 0) * (Number(p.unit_cost) || 0), 0);
  return (
    <div style={fieldStyle}>
      <span style={labelStyle}>{t('fleet.m.parts')}</span>
      {parts.map((p, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr) minmax(0,1fr) auto', gap: '6px' }}>
          <input aria-label={t('fleet.m.partName')} placeholder={t('fleet.m.partName')} value={p.name} onChange={(e) => set(i, 'name', e.target.value)} style={inputStyle} />
          <input aria-label={t('fleet.m.qty')} placeholder={t('fleet.m.qty')} type="number" min="0" step="any" value={p.qty} onChange={(e) => set(i, 'qty', e.target.value)} style={inputStyle} />
          <input aria-label={t('fleet.m.unitCost')} placeholder={t('fleet.m.unitCost')} type="number" min="0" step="0.01" value={p.unit_cost} onChange={(e) => set(i, 'unit_cost', e.target.value)} style={inputStyle} />
          <button type="button" aria-label="Remove" onClick={() => onChange(parts.filter((_, j) => j !== i))} style={{ ...linkBtn, color: 'var(--danger)' }}>×</button>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <button type="button" onClick={() => onChange([...parts, { name: '', qty: 1, unit_cost: 0 }])} style={linkBtn}>+ {t('fleet.m.addPart')}</button>
        {parts.length > 0 && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{fmtMoney(total, currency)}</span>}
      </div>
    </div>
  );
}

// Parts as sent to the API (numbers, empty rows dropped).
export const cleanParts = (parts) => parts
  .filter((p) => String(p.name || '').trim())
  .map((p) => ({ name: String(p.name).trim(), qty: Number(p.qty) || 0, unit_cost: Number(p.unit_cost) || 0 }));

export function DocStatusBadge({ daysLeft }) {
  if (daysLeft === null || daysLeft === undefined) return null;
  const status = daysLeft < 0 ? 'expired' : daysLeft <= 30 ? 'expiring_soon' : 'active';
  return <StatusBadge status={status} map={{ expired: 'danger', expiring_soon: 'warning' }} />;
}

export const cellStyle = { padding: '10px 12px', verticalAlign: 'top' };
export const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 };
export const labelStyle = { fontSize: '12px', fontWeight: 700 };
export const errStyle = { fontSize: '12px', color: 'var(--danger)' };
export const grid2 = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px' };
export const inputStyle = {
  padding: '9px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit', boxSizing: 'border-box', minWidth: 0,
};
export const selectStyle = { ...inputStyle, width: 'auto', fontSize: '13px' };
export const iconBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)', cursor: 'pointer', padding: 0 };
export const linkBtn = { background: 'none', border: 'none', padding: 0, color: 'var(--brand)', fontWeight: 700, fontSize: '12px', cursor: 'pointer' };
