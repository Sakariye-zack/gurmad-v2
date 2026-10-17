import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, StatCard, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import CapacityPanel from '../../components/collection/CapacityPanel.jsx';
import { useBatches, useCreateBatch, useCycles } from '../../hooks/useCollectionOps.js';
import { useZonesList, useCustomers } from '../../hooks/useCustomers.js';
import { useGroups, useGroupEligibleCustomers } from '../../hooks/useGroups.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

const STATUS_LABELS = { draft: 'Draft', assigned: 'Assigned', in_progress: 'In Progress', partially_completed: 'Partially Completed', completed: 'Completed', cancelled: 'Cancelled' };

export default function BatchesListPage() {
  const { t, tc } = useI18n();
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useBatches({ status: statusFilter || undefined, search: search || undefined });
  const batches = data?.data || [];
  const inProgressCount = batches.filter((b) => b.status === 'in_progress').length;
  const draftCount = batches.filter((b) => b.status === 'draft').length;

  return (
    <div>
      <PageHeader
        icon={ClipboardList}
        title={t('nav.batches')}
        subtitle={t('coll.collection_batches_customer_groups_s')}
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>{t('coll.create_batch')}</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label={t('coll.total_batches')} value={error ? '—' : (data?.data?.length ?? '—')} icon={ClipboardList} />
        <StatCard label={t('status.in_progress')} value={error ? '—' : inProgressCount} icon={ClipboardList} accent="var(--info)" />
        <StatCard label={t('status.draft')} value={error ? '—' : draftCount} icon={ClipboardList} accent="var(--warning)" />
      </div>

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder={t('coll.search_by_batch_code')}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">{t('cust.all_statuses')}</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{tc('status.' + k, v)}</option>)}
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && batches.length === 0}
        emptyTitle={t('coll.no_batches_yet')}
        emptySubtitle={t('coll.create_the_first_batch_to')}
        columns={[{ label: t('common.batch') }, { label: t('common.zone') }, { label: t('cust.type') }, { label: t('nav.customers') }, { label: t('coll.capacity') }, { label: t('common.status') }]}
      >
        {batches.map((b) => (
          <tr key={b.id} onClick={() => navigate(`/collection-cycles/batches/${b.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong>{b.batch_code}</strong></td>
            <td style={cellStyle}>{b.zone_name}</td>
            <td style={cellStyle}>
              <span style={{ textTransform: 'capitalize' }}>{t('cust.' + b.customer_type, b.customer_type)}</span>
              {b.commercial_shift && <span style={{ color: 'var(--text-muted)' }}> ({t('cust.' + b.commercial_shift, b.commercial_shift)})</span>}
            </td>
            <td style={cellStyle} className="tabular-nums">{b.total_customers}</td>
            <td style={cellStyle}><CapacityPanel capacity={b.capacity} compact /></td>
            <td style={cellStyle}><StatusBadge status={STATUS_LABELS[b.status]} map={{ draft: 'info', assigned: 'warning', 'in progress': 'warning', 'partially completed': 'warning', completed: 'success', cancelled: 'danger' }} /></td>
          </tr>
        ))}
      </DataTable>

      <BatchFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function BatchFormModal({ open, onClose }) {
  if (!open) return null;
  return <BatchFormContent onClose={onClose} />;
}

function BatchFormContent({ onClose }) {
  const { t } = useI18n();
  const [zoneId, setZoneId] = useState('');
  const [cycleId, setCycleId] = useState('');
  const [customerType, setCustomerType] = useState('residential');
  const [shift, setShift] = useState('day');
  const [startDate, setStartDate] = useState('');
  const [selectedCustomers, setSelectedCustomers] = useState([]);
  // Group & Group-Based Collection — Change Request, Spec §9/§22. A Group
  // picker + Customer Type filter, as an alternative selection path to the
  // existing hand-picked customer list below — reuses the exact same
  // POST /batches call and the exact same DR-7/cross-zone validation
  // (Spec §11: "DR-7 remains authoritative" regardless of selection path).
  const [groupId, setGroupId] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [error, setError] = useState('');
  const { data: zonesData } = useZonesList();
  const { data: cyclesData } = useCycles({ is_active: true });
  const { data: groupsData } = useGroups({ zone_id: zoneId || undefined, status: 'active' });
  const { data: eligibleData } = useGroupEligibleCustomers(groupId || undefined, typeFilter);
  // Only allow selecting customers once a zone is chosen — a batch's
  // customers must belong to its own zone (found and fixed during Module 5
  // browser QA, alongside the matching backend check). useCustomers has no
  // `enabled` gate of its own, so the empty-zone case is handled by simply
  // not rendering any options below, not by skipping the fetch.
  const { data: customersData } = useCustomers({ zone_id: zoneId || undefined, customer_type: customerType, group_id: groupId || undefined });
  const createBatch = useCreateBatch();
  const toast = useToast();
  const zones = zonesData?.data || [];
  const cycles = (cyclesData?.data || []).filter((c) => !zoneId || String(c.zone_id) === zoneId);
  const groups = zoneId ? (groupsData?.data || []) : [];
  const eligibleCustomers = zoneId ? (customersData?.data || []) : [];
  const eligiblePreview = groupId ? eligibleData?.data : null;

  function toggleCustomer(id) {
    setSelectedCustomers((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!zoneId || !cycleId || !startDate) { setError(t('coll.zone_cycle_and_start_date')); return; }
    try {
      const result = await createBatch.mutateAsync({
        zone_id: parseInt(zoneId, 10), cycle_id: parseInt(cycleId, 10), customer_type: customerType,
        commercial_shift: customerType === 'commercial' ? shift : undefined, start_date: startDate,
        // Group-based path: pass group_id + customer_type_filter and let
        // the backend resolve eligible customers (Spec §9 step 2) — no
        // explicit customer_ids, so DR-7/cross-zone validation runs on the
        // server-resolved set exactly as it would for a hand-picked one.
        // Manual path (no group selected): customer_ids as before.
        ...(groupId ? { group_id: parseInt(groupId, 10), customer_type_filter: typeFilter } : { customer_ids: selectedCustomers }),
      });
      toast.success(t('fin.m.created', undefined, { number: result.data.batch_code }));
      onClose();
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      onClose={createBatch.isPending ? () => {} : onClose}
      title={t('coll.create_batch')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createBatch.isPending}>{t('common.cancel')}</Button>
          <Button type="submit" form="batch-form" disabled={createBatch.isPending}>{createBatch.isPending ? t('common.saving') : t('coll.create_batch')}</Button>
        </>
      }
    >
      <form id="batch-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('common.zone')}</span>
          <select value={zoneId} onChange={(e) => { setZoneId(e.target.value); setCycleId(''); setSelectedCustomers([]); }} style={inputStyle}>
            <option value="">{t('cust.select_a_zone')}</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('coll.collection_cycle')}</span>
          <select value={cycleId} onChange={(e) => setCycleId(e.target.value)} style={inputStyle} disabled={!zoneId}>
            <option value="">{zoneId ? t('coll.select_a_cycle') : t('cust.select_a_zone_first')}</option>
            {cycles.map((c) => <option key={c.id} value={c.id}>{c.cycle_type} — {c.start_date} to {c.end_date}</option>)}
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('coll.group_optional_resolve_customers_by')}</span>
          <select value={groupId} onChange={(e) => { setGroupId(e.target.value); setSelectedCustomers([]); }} style={inputStyle} disabled={!zoneId}>
            <option value="">{zoneId ? t('coll.no_group_pick_customers_manually') : t('cust.select_a_zone_first')}</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.code}</option>)}
          </select>
        </label>
        {groupId && (
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('coll.customer_type_filter')}</span>
            <div style={{ display: 'flex', gap: '8px' }}>
              {['all', 'residential', 'commercial'].map((ty) => (
                <button type="button" key={ty} onClick={() => setTypeFilter(ty)} style={{ flex: 1, padding: '9px', borderRadius: 'var(--radius-sm)', fontWeight: 700, fontSize: '13px', cursor: 'pointer', textTransform: 'capitalize', border: `1px solid ${typeFilter === ty ? 'var(--brand)' : 'var(--border)'}`, background: typeFilter === ty ? 'var(--success-bg)' : 'var(--surface)', color: typeFilter === ty ? 'var(--brand)' : 'var(--text-muted)' }}>{ty === 'all' ? t('cust.all_types') : t('cust.' + ty, ty)}</button>
              ))}
            </div>
            {eligiblePreview && (
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {t('coll.m.eligible', undefined, { count: eligiblePreview.count, residential: eligiblePreview.customer_type_breakdown.residential, commercial: eligiblePreview.customer_type_breakdown.commercial })}
              </span>
            )}
          </label>
        )}
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('cust.customer_type')}</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            {['residential', 'commercial'].map((ty) => (
              <button type="button" key={ty} onClick={() => setCustomerType(ty)} style={{ flex: 1, padding: '9px', borderRadius: 'var(--radius-sm)', fontWeight: 700, fontSize: '13px', cursor: 'pointer', textTransform: 'capitalize', border: `1px solid ${customerType === ty ? 'var(--brand)' : 'var(--border)'}`, background: customerType === ty ? 'var(--success-bg)' : 'var(--surface)', color: customerType === ty ? 'var(--brand)' : 'var(--text-muted)' }}>{ty === 'all' ? t('cust.all_types') : t('cust.' + ty, ty)}</button>
            ))}
          </div>
        </label>
        {customerType === 'commercial' && (
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('cust.commercial_shift')}</span>
            <select value={shift} onChange={(e) => setShift(e.target.value)} style={inputStyle}>
              <option value="day">{t('cust.day')}</option>
              <option value="night">{t('cust.night')}</option>
            </select>
          </label>
        )}
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('coll.start_date')}</span>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
        </label>
        {!groupId && (
          <label style={fieldStyle}>
            <span style={labelStyle}>{t('coll.m.customersSelected', undefined, { n: selectedCustomers.length })}</span>
            <div style={{ maxHeight: '160px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '8px' }}>
              {!zoneId && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('coll.select_a_zone_to_see')}</span>}
              {zoneId && eligibleCustomers.length === 0 && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t('coll.m.noTypeCustomers', undefined, { type: t('cust.' + customerType, customerType) })}</span>}
              {eligibleCustomers.map((c) => (
                <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', fontSize: '13px' }}>
                  <input type="checkbox" checked={selectedCustomers.includes(c.id)} onChange={() => toggleCustomer(c.id)} />
                  {c.customer_number} — {c.business_name || c.name}
                </label>
              ))}
            </div>
          </label>
        )}
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

const cellStyle = { padding: '12px 14px' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
