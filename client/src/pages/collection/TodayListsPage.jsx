import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ListChecks, Play, ChevronDown, ChevronUp, UserPlus, Repeat, Trash2, AlertTriangle, Truck, User, ArrowUp, ArrowDown, Route as RouteIcon, ShieldCheck } from 'lucide-react';
import { PageHeader, Button, Card, StatusBadge, LoadingState, ErrorState, EmptyState, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useBatchCustomers } from '../../hooks/useCollectionOps.js';
import { useCustomers } from '../../hooks/useCustomers.js';
import {
  useDailyLists, useDailyListWarnings, useDailyListOptions, useRunDailyLists,
  useAddDailyListCustomer, useRemoveDailyListCustomer, useReassignDailyList,
  useReorderDailyList, useMoveDailyListCustomer, useOverrideServiced,
} from '../../hooks/useDailyLists.js';

const WEEK_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];

// Operations → Today: the automatically generated daily lists (one per Sub
// Zone, split by customer type), ordered Group › District › Zone › Sub Zone.
export default function TodayListsPage() {
  const { t } = useI18n();
  const [date, setDate] = useState('');
  const { data, isLoading, error, refetch } = useDailyLists(date || undefined);
  const info = data?.data;
  const effectiveDate = date || info?.today || '';
  const editable = !!info && effectiveDate >= info.today;
  const role = (useAuth().user?.role || '').toLowerCase();
  const canEdit = editable && ['admin', 'gudoomiye'].includes(role);

  return (
    <div>
      <PageHeader
        icon={ListChecks}
        title={t('daily.title')}
        subtitle={t('daily.subtitle')}
        actions={
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', fontWeight: 700 }}>
            {t('daily.date')}
            <input type="date" value={effectiveDate} onChange={(e) => setDate(e.target.value)} style={inputStyle} />
          </label>
        }
      />

      <RunStatusCard info={info} date={effectiveDate} />
      <MismatchPanel items={info?.mismatches || []} />
      <WarningsPanel />

      {isLoading && <LoadingState />}
      {error && <ErrorState message={error.message} onRetry={refetch} />}
      {info && info.lists.length === 0 && <EmptyState title={t('daily.noLists')} subtitle={t('daily.noListsHint')} />}
      {info && !editable && info.lists.length > 0 && (
        <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '0 0 10px' }}>{t('daily.readOnly')}</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {(info?.lists || []).map((l) => <SubZoneCard key={l.route_id} list={l} canEdit={canEdit} />)}
      </div>
    </div>
  );
}

function RunStatusCard({ info, date }) {
  const { t } = useI18n();
  const toast = useToast();
  const run = useRunDailyLists();
  const last = info?.last_run;
  const isToday = info && date === info.today;
  async function runNow() {
    try {
      const r = await run.mutateAsync(date);
      toast.success(t('daily.runDone', undefined, { batches: r.data.created_batches, customers: r.data.customers }));
    } catch (e) {
      toast.error(e.message || t('common.somethingWrong'));
    }
  }
  return (
    <Card style={{ padding: '14px 16px', marginBottom: '14px', display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={{ fontSize: '13px', minWidth: 0 }}>
        <div style={{ fontWeight: 700, marginBottom: '2px' }}>{t('daily.lastRun')}</div>
        {!last && <div style={{ color: 'var(--text-muted)' }}>{t('daily.neverRan')}</div>}
        {last && (
          <div style={{ color: last.error ? 'var(--danger)' : 'var(--text-muted)' }}>
            {new Date(last.finished_at || last.started_at).toLocaleString()} · {t('daily.runFor', undefined, { date: last.run_date })} ·{' '}
            {last.error
              ? t('daily.runError', undefined, { error: last.error })
              : t('daily.runSummary', undefined, { batches: last.created_batches, customers: last.customers, closed: last.closed_batches })}
            {!last.error && Array.isArray(last.skipped) && last.skipped.length > 0 && ` · ${t('daily.skippedN', undefined, { n: last.skipped.length })}`}
          </div>
        )}
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{t('daily.autoSchedule')}</div>
      </div>
      {isToday && (
        <RoleGate roles={['admin']}>
          <Button icon={Play} onClick={runNow} disabled={run.isPending}>{t('daily.runNow')}</Button>
        </RoleGate>
      )}
    </Card>
  );
}

// DR-7: the Sub Zone's collector cannot serve this customer type, so no list
// was created for those customers — shown first and in red until fixed.
function MismatchPanel({ items }) {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <div role="alert" style={{ padding: '10px 14px', marginBottom: '14px', borderRadius: 'var(--radius-md)', background: 'var(--danger-bg)', border: '1px solid var(--danger)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, fontSize: '13px' }}>
        <AlertTriangle size={15} color="var(--danger)" style={{ flexShrink: 0 }} /> {t('daily.mismatchTitle', undefined, { n: items.length })}
      </div>
      <p style={{ margin: '4px 0 6px 23px', fontSize: '12px', color: 'var(--text-muted)' }}>{t('daily.mismatchHint')}</p>
      <ul style={{ margin: '0 0 0 23px', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {items.map((m) => (
          <li key={`${m.route_id}-${m.customer_type}-${m.commercial_shift || ''}`} style={{ fontSize: '12px', overflowWrap: 'anywhere' }}>
            <strong>{m.path}</strong> — {t('daily.mismatchLine', undefined, { type: batchLabel(t, m), n: m.customers, collector: m.collector || '—' })}
          </li>
        ))}
      </ul>
    </div>
  );
}

function WarningsPanel() {
  const { t } = useI18n();
  const { data } = useDailyListWarnings();
  const w = data?.data;
  const [open, setOpen] = useState(null);
  if (!w) return null;
  const subzones = w.subzones_without_days || [];
  const customers = w.customers_without_subzone || [];
  const custTotal = w.customers_without_subzone_total ?? customers.length;
  if (subzones.length === 0 && custTotal === 0) return null;
  const section = (key, title, hint, items, total, render) => (
    <div style={{ borderTop: key === 'c' && subzones.length ? '1px solid var(--warning)' : 'none', paddingTop: key === 'c' && subzones.length ? '8px' : 0 }}>
      <button type="button" onClick={() => setOpen(open === key ? null : key)} style={warnHeadStyle}>
        <AlertTriangle size={15} color="var(--warning)" style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, textAlign: 'left' }}>{title}</span>
        {open === key ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open === key && (
        <div style={{ padding: '4px 0 6px 23px' }}>
          <p style={{ margin: '0 0 6px', fontSize: '12px', color: 'var(--text-muted)' }}>{hint}</p>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {items.slice(0, 100).map(render)}
          </ul>
          {total > Math.min(items.length, 100) && <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: '6px 0 0' }}>{t('daily.andMore', undefined, { n: total - Math.min(items.length, 100) })}</p>}
        </div>
      )}
    </div>
  );
  return (
    <div style={{ padding: '10px 14px', marginBottom: '14px', borderRadius: 'var(--radius-md)', background: 'var(--warning-bg)', border: '1px solid var(--warning)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {subzones.length > 0 && section('s', t('daily.warnSubzones', undefined, { n: subzones.length }), t('daily.warnSubzonesHint'), subzones, subzones.length, (s) => (
        <li key={s.id} style={rowItemStyle}>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{s.path}</span>
          <Link to={`/groups/${s.group_id}`} style={linkStyle}>{t('daily.editGroup')}</Link>
        </li>
      ))}
      {custTotal > 0 && section('c', t('daily.warnCustomers', undefined, { n: custTotal }), t('daily.warnCustomersHint'), customers, custTotal, (c) => (
        <li key={c.id} style={rowItemStyle}>
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{c.customer_number} · {c.name}{c.group_name ? ` · ${c.group_name}` : ''} · {c.district_name}</span>
          <Link to={`/customers/${c.id}`} style={linkStyle}>{t('daily.editCustomer')}</Link>
        </li>
      ))}
    </div>
  );
}

function batchLabel(t, b) {
  return t('daily.type.' + b.customer_type, b.customer_type) + (b.commercial_shift ? ` · ${t('cust.' + b.commercial_shift, b.commercial_shift)}` : '');
}

function SubZoneCard({ list, canEdit }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [addFor, setAddFor] = useState(null);
  const [reassignFor, setReassignFor] = useState(null);
  const c = list.counts;
  const pct = c.total > 0 ? Math.round((c.serviced / c.total) * 100) : 0;
  const days = list.work_days || [];
  return (
    <Card style={{ padding: '14px 16px' }}>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{list.path}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
        <strong style={{ fontSize: '15px' }}>{list.route_name}</strong>
        <span style={chipStyle('var(--info)')}>{t('daily.auto')}</span>
        <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '3px' }}>
          {days.length === 0
            ? <span style={{ fontSize: '11px', color: 'var(--warning)' }}>{t('subzone.noWorkDays')}</span>
            : WEEK_DAYS.filter((d) => days.includes(d)).map((d) => <span key={d} style={dayChipStyle}>{t('cust.day_' + d)}</span>)}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', fontSize: '13px', marginTop: '8px' }}>
        <span style={metaStyle}><User size={13} /> {list.collector?.name || t('daily.none')}</span>
        <span style={metaStyle}><Truck size={13} /> {list.truck?.plate_number || t('daily.none')}</span>
      </div>

      {(list.mismatches || []).map((m) => (
        <p key={`${m.customer_type}-${m.commercial_shift || ''}`} style={{ margin: '8px 0 0', fontSize: '12px', color: 'var(--danger)', fontWeight: 600 }}>
          {t('daily.mismatchLine', undefined, { type: batchLabel(t, m), n: m.customers, collector: m.collector || '—' })}
        </p>
      ))}
      {list.not_generated && !(list.mismatches || []).length && (
        <p style={{ margin: '8px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>{t('daily.notGenerated.' + list.not_generated)}</p>
      )}

      {list.batches.length > 0 && (
        <>
          <div style={{ marginTop: '10px' }}>
            <div style={{ height: '8px', borderRadius: '999px', background: 'var(--surface-2, var(--border))', overflow: 'hidden' }}>
              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--success)' }} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '6px', fontSize: '12px' }}>
              <span className="tabular-nums" style={{ fontWeight: 700 }}>{t('daily.servicedOf', undefined, { serviced: c.serviced, total: c.total })}</span>
              <span style={chipStyle('var(--danger)')}>{t('daily.missed')} {c.missed}</span>
              <span style={chipStyle('var(--warning)')}>{t('daily.pending')} {c.pending}</span>
              {c.carried > 0 && <span style={chipStyle('var(--info)')}>{t('daily.carried')} {c.carried}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '10px' }}>
            <Button variant="secondary" icon={open ? ChevronUp : ChevronDown} onClick={() => setOpen(!open)}>{open ? t('daily.closeList') : t('daily.openList')}</Button>
            {canEdit && list.batches.length === 1 && (
              <>
                <Button variant="secondary" icon={UserPlus} onClick={() => setAddFor(list.batches[0])}>{t('daily.addCustomer')}</Button>
                <Button variant="secondary" icon={Repeat} onClick={() => setReassignFor(list.batches[0])}>{t('daily.reassign')}</Button>
              </>
            )}
          </div>
          {open && list.batches.map((b) => (
            <BatchRows key={b.id} batch={b} multi={list.batches.length > 1} canEdit={canEdit}
              onAdd={() => setAddFor(b)} onReassign={() => setReassignFor(b)} />
          ))}
          {!open && list.batches.length > 1 && canEdit && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
              {list.batches.map((b) => (
                <div key={b.id} style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', fontSize: '12px' }}>
                  <strong style={{ minWidth: '110px' }}>{batchLabel(t, b)}</strong>
                  <Button variant="ghost" icon={UserPlus} style={smallBtn} onClick={() => setAddFor(b)}>{t('daily.addCustomer')}</Button>
                  <Button variant="ghost" icon={Repeat} style={smallBtn} onClick={() => setReassignFor(b)}>{t('daily.reassign')}</Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {addFor && <AddCustomerModal batch={addFor} zoneId={list.zone_id} onClose={() => setAddFor(null)} />}
      {reassignFor && <ReassignModal batch={reassignFor} zoneId={list.zone_id} onClose={() => setReassignFor(null)} />}
    </Card>
  );
}

function BatchRows({ batch, multi, canEdit, onAdd, onReassign }) {
  const { t } = useI18n();
  const toast = useToast();
  const { data, isLoading } = useBatchCustomers(batch.id);
  const remove = useRemoveDailyListCustomer();
  const reorder = useReorderDailyList();
  const move = useMoveDailyListCustomer();
  const [overrideFor, setOverrideFor] = useState(null);
  const rows = data?.data || [];
  async function doReorder() {
    try {
      await reorder.mutateAsync(batch.id);
      toast.success(t('daily.reordered'));
    } catch (e) {
      toast.error(e.message || t('common.somethingWrong'));
    }
  }
  async function doMove(customerId, direction) {
    try {
      await move.mutateAsync({ batchId: batch.id, customerId, direction });
    } catch (e) {
      toast.error(e.message || t('common.somethingWrong'));
    }
  }
  async function doRemove(customerId) {
    try {
      await remove.mutateAsync({ batchId: batch.id, customerId });
      toast.success(t('daily.removed'));
    } catch (e) {
      toast.error(e.message || t('common.somethingWrong'));
    }
  }
  return (
    <div style={{ marginTop: '12px', borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
      {multi && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
          <strong style={{ fontSize: '12px' }}>{batchLabel(t, batch)}</strong>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{batch.collector?.name || t('daily.none')} · {batch.truck?.plate_number || t('daily.none')}</span>
          {canEdit && (
            <>
              <Button variant="ghost" icon={UserPlus} style={smallBtn} onClick={onAdd}>{t('daily.addCustomer')}</Button>
              <Button variant="ghost" icon={Repeat} style={smallBtn} onClick={onReassign}>{t('daily.reassign')}</Button>
            </>
          )}
        </div>
      )}
      {batch.status === 'draft' && <p style={{ fontSize: '12px', color: 'var(--warning)', margin: '0 0 6px' }}>{t('daily.draftNoCollector')}</p>}
      {canEdit && rows.length > 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
          <Button variant="ghost" icon={RouteIcon} style={smallBtn} onClick={doReorder} disabled={reorder.isPending}>{t('daily.reorder')}</Button>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{t('daily.reorderHint')}</span>
        </div>
      )}
      {isLoading && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>…</div>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((r, i) => (
          <li key={r.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', padding: '7px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
            <span className="tabular-nums" title={t('daily.visitOrder')} style={orderNumStyle}>{r.visit_order ?? i + 1}</span>
            <span style={{ flex: '1 1 160px', minWidth: 0, overflowWrap: 'anywhere' }}>
              {r.business_name || r.name} <span style={{ color: 'var(--text-muted)' }}>({r.customer_number})</span>
            </span>
            <StatusBadge status={r.status} />
            {r.status === 'serviced' && <ProofBadge row={r} />}
            {canEdit && (
              <span style={{ display: 'inline-flex', gap: '2px' }}>
                <Button variant="ghost" icon={ArrowUp} style={iconBtn} aria-label={t('daily.moveUp')} title={t('daily.moveUp')} onClick={() => doMove(r.customer_id, 'up')} disabled={move.isPending || i === 0} />
                <Button variant="ghost" icon={ArrowDown} style={iconBtn} aria-label={t('daily.moveDown')} title={t('daily.moveDown')} onClick={() => doMove(r.customer_id, 'down')} disabled={move.isPending || i === rows.length - 1} />
              </span>
            )}
            {canEdit && r.status === 'pending' && (
              <Button variant="ghost" icon={ShieldCheck} style={smallBtn} onClick={() => setOverrideFor(r)}>{t('daily.override')}</Button>
            )}
            {r.carried_over_from && <span style={chipStyle('var(--info)')}>{t('daily.carriedFrom', undefined, { date: String(r.carried_over_from).slice(0, 10) })}</span>}
            {canEdit && r.status === 'pending' && (
              <Button variant="ghost" icon={Trash2} style={smallBtn} onClick={() => doRemove(r.customer_id)} disabled={remove.isPending}>{t('daily.remove')}</Button>
            )}
          </li>
        ))}
      </ul>
      {overrideFor && <OverrideModal batch={batch} row={overrideFor} onClose={() => setOverrideFor(null)} />}
    </div>
  );
}

// Proof of service on a serviced row: distance from the house, supervisor
// override, or the customer has no location on file.
function ProofBadge({ row }) {
  const { t } = useI18n();
  if (row.proof_flag === 'override') return <span style={chipStyle('var(--warning)')} title={row.proof_override_reason || ''}>{t('daily.proofOverride')}</span>;
  if (row.proof_flag === 'no_customer_location') return <span style={chipStyle('var(--text-muted)')}>{t('daily.proofNoLocation')}</span>;
  if (row.proof_flag === 'legacy_no_gps' || row.proof_flag === 'legacy_far') return <span style={chipStyle('var(--text-muted)')} title={t('daily.proofLegacyHint')}>{t('daily.proofLegacy')}</span>;
  if (row.proof_flag === 'suspect_exact') return <span style={chipStyle('var(--danger)')} title={t('daily.proofSuspectHint')}>⚠ {t('daily.proofSuspect')}</span>;
  if (row.proof_distance_m != null) return <span style={chipStyle('var(--success)')}>✓ {t('daily.proofMeters', undefined, { m: row.proof_distance_m })}</span>;
  return null;
}

// Supervisor "mark serviced" without the geofence — reason required, audited.
function OverrideModal({ batch, row, onClose }) {
  const { t } = useI18n();
  const toast = useToast();
  const override = useOverrideServiced();
  const [reason, setReason] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (!reason.trim()) { toast.error(t('daily.overrideReasonRequired')); return; }
    try {
      await override.mutateAsync({ batchId: batch.id, customerId: row.customer_id, reason: reason.trim() });
      toast.success(t('daily.overrideDone'));
      onClose();
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
    }
  }
  return (
    <Modal
      open
      onClose={override.isPending ? () => {} : onClose}
      title={t('daily.overrideTitle')}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={override.isPending}>{t('common.cancel')}</Button>
        <Button type="submit" form="override-form" disabled={override.isPending || !reason.trim()}>{override.isPending ? t('common.saving') : t('daily.overrideConfirm')}</Button>
      </>}
    >
      <form id="override-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <p style={{ ...hintStyle, margin: 0 }}><strong>{row.business_name || row.name}</strong> ({row.customer_number}) · {t('daily.overrideHint')}</p>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('daily.overrideReason')}</span>
          <textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
        </label>
      </form>
    </Modal>
  );
}

function AddCustomerModal({ batch, zoneId, onClose }) {
  const { t } = useI18n();
  const toast = useToast();
  const [q, setQ] = useState('');
  const term = q.trim();
  const { data, isFetching } = useCustomers({ zone_id: zoneId, q: term.length >= 2 ? term : undefined, status: 'active', customer_type: batch.customer_type });
  const add = useAddDailyListCustomer();
  const results = term.length >= 2 ? (data?.data || []).slice(0, 20) : [];
  async function doAdd(c) {
    try {
      await add.mutateAsync({ batchId: batch.id, customerId: c.id });
      toast.success(t('daily.added'));
      onClose();
    } catch (e) {
      toast.error(e.message || t('common.somethingWrong'));
    }
  }
  return (
    <Modal open onClose={add.isPending ? () => {} : onClose} title={`${t('daily.addCustomer')} — ${batchLabel(t, batch)}`}>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('daily.search')} style={{ ...inputStyle, width: '100%' }} />
      <div style={{ marginTop: '10px', minHeight: '60px' }}>
        {term.length < 2 && <p style={hintStyle}>{t('daily.typeToSearch')}</p>}
        {term.length >= 2 && !isFetching && results.length === 0 && <p style={hintStyle}>{t('daily.noMatches')}</p>}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {results.map((c) => (
            <li key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
              <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{c.business_name || c.name} <span style={{ color: 'var(--text-muted)' }}>({c.customer_number})</span></span>
              <Button variant="secondary" style={smallBtn} onClick={() => doAdd(c)} disabled={add.isPending}>{t('daily.addCustomer')}</Button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

function ReassignModal({ batch, zoneId, onClose }) {
  const { t } = useI18n();
  const toast = useToast();
  const { data } = useDailyListOptions(zoneId);
  const reassign = useReassignDailyList();
  const [collector, setCollector] = useState('');
  const [truck, setTruck] = useState('');
  // DR-7: only collectors whose type (and shift) match this list.
  const collectors = useMemo(() => (data?.data?.collectors || []).filter((c) => (
    batch.customer_type === 'commercial'
      ? c.collector_type === 'commercial' && c.commercial_shift === batch.commercial_shift
      : c.collector_type !== 'commercial'
  )), [data, batch]);
  const trucks = data?.data?.trucks || [];
  async function submit(e) {
    e.preventDefault();
    const body = {};
    if (collector) body.collector_user_id = parseInt(collector, 10);
    if (truck === 'none') body.truck_id = null;
    else if (truck) body.truck_id = parseInt(truck, 10);
    if (Object.keys(body).length === 0) { onClose(); return; }
    try {
      await reassign.mutateAsync({ batchId: batch.id, ...body });
      toast.success(t('daily.saved'));
      onClose();
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
    }
  }
  return (
    <Modal
      open
      onClose={reassign.isPending ? () => {} : onClose}
      title={t('daily.reassignTitle')}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={reassign.isPending}>{t('common.cancel')}</Button>
        <Button type="submit" form="reassign-form" disabled={reassign.isPending}>{reassign.isPending ? t('common.saving') : t('daily.reassign')}</Button>
      </>}
    >
      <form id="reassign-form" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <p style={{ ...hintStyle, margin: 0 }}>{batchLabel(t, batch)} · {t('daily.reassignHint')}</p>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('daily.collector')}</span>
          <select value={collector} onChange={(e) => setCollector(e.target.value)} style={inputStyle}>
            <option value="">{t('daily.keep')} ({batch.collector?.name || t('daily.none')})</option>
            {collectors.map((c) => <option key={c.user_id} value={String(c.user_id)}>{c.name}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('daily.truck')}</span>
          <select value={truck} onChange={(e) => setTruck(e.target.value)} style={inputStyle}>
            <option value="">{t('daily.keep')} ({batch.truck?.plate_number || t('daily.none')})</option>
            <option value="none">{t('daily.noTruck')}</option>
            {trucks.map((tk) => <option key={tk.id} value={String(tk.id)}>{tk.plate_number}{tk.model ? ` — ${tk.model}` : ''}</option>)}
          </select>
        </label>
      </form>
    </Modal>
  );
}

const inputStyle = {
  padding: '8px 10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', fontFamily: 'inherit', maxWidth: '100%',
};
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const hintStyle = { fontSize: '12px', color: 'var(--text-muted)', margin: '4px 0' };
const smallBtn = { padding: '4px 8px', fontSize: '12px' };
const iconBtn = { padding: '4px 6px', fontSize: '12px', minWidth: 0 };
const orderNumStyle = { minWidth: '24px', textAlign: 'center', fontSize: '11px', fontWeight: 800, color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: '999px', padding: '1px 6px' };
const metaStyle = { display: 'inline-flex', alignItems: 'center', gap: '5px', minWidth: 0 };
const dayChipStyle = { fontSize: '11px', padding: '1px 6px', borderRadius: '999px', border: '1px solid var(--border)', color: 'var(--text-muted)' };
const chipStyle = (c) => ({ fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', color: c, border: `1px solid ${c}`, whiteSpace: 'nowrap' });
const warnHeadStyle = { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer', color: 'var(--text)', fontWeight: 700, fontSize: '13px', fontFamily: 'inherit' };
const rowItemStyle = { display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'space-between', fontSize: '12px' };
const linkStyle = { color: 'var(--brand)', fontWeight: 700, whiteSpace: 'nowrap' };
