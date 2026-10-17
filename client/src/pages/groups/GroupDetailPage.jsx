import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Boxes, Pencil, Plus } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, StatCard, LoadingState, ErrorState, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useGroup, useGroupSummary, useGroupCollectorPerformance, useCreateRoute, useUpdateRoute, useGroupCustomers } from '../../hooks/useGroups.js';
import GroupFormModal from './GroupFormModal.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';

// Group Detail — Group & Group-Based Collection CR, Spec §8. Group
// information, Zone, status, customer/route counts and lists, and current
// collection activity (Group-level report summary) — all live-derived,
// never hardcoded (mirrors ZoneDetailPage's own foundation-first pattern).
export default function GroupDetailPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useGroup(id);
  const { data: summaryData } = useGroupSummary(id);
  const { data: perfData } = useGroupCollectorPerformance(id);
  // User-requested gap-audit sweep ('sii wad qaybaha kale'): useGroupCustomers()
  // already existed in useGroups.js, fully wired to the backend (GET
  // /v2/groups/:id/customers, paginated), but nothing here ever called it —
  // this page only ever showed a bare customer COUNT (DetailGrid above),
  // never the actual list, and CustomersListPage.jsx has no group filter
  // either, so there was no path anywhere from a Group to its customers.
  const { data: customersData } = useGroupCustomers(id);
  const [editOpen, setEditOpen] = useState(false);
  const [routeFormOpen, setRouteFormOpen] = useState(false);
  // User-requested gap-audit sweep ('sii wad qaybaha kale'): useUpdateRoute()
  // already existed in useGroups.js, fully wired to the backend (PUT
  // /v2/routes/:id), but nothing here ever called it — Add Route existed,
  // a typo'd code or a status change on an existing route did not.
  const [editRouteTarget, setEditRouteTarget] = useState(null);
  const group = data?.data;
  const summary = summaryData?.data;
  const performance = perfData?.data || [];
  const customers = customersData?.data || [];
  const customersMeta = customersData?.meta;

  if (isLoading) return <LoadingState label={t('group.loading_group')} />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!group) return null;

  return (
    <div>
      <button onClick={() => navigate('/groups')} style={backLinkStyle}>
        <ArrowLeft size={14} /> {t('group.back_to_groups')}
      </button>

      <PageHeader
        icon={Boxes}
        title={group.code}
        subtitle={group.zone_name}
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>{t('group.edit_group')}</Button>
          </RoleGate>
        }
      />

      <DetailGrid items={[
        { label: t('common.status'), value: <StatusBadge status={group.status} /> },
        { label: t('common.zone'), value: group.zone_name },
        { label: t('nav.customers'), value: group.customer_count },
        { label: t('group.routes'), value: group.route_count },
      ]} />

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '14px', margin: '20px 0' }}>
          <StatCard label={t('status.assigned')} value={summary.assigned} />
          <StatCard label={t('status.serviced')} value={summary.serviced} accent="var(--success)" />
          <StatCard label={t('status.missed')} value={summary.missed} accent="var(--danger)" />
          <StatCard label={t('status.skipped')} value={summary.skipped} accent="var(--warning)" />
          <StatCard label={t('status.rescheduled')} value={summary.rescheduled} />
          <StatCard label={t('group.remaining')} value={summary.remaining} />
          <StatCard label={t('group.completion')} value={summary.completion_pct != null ? `${summary.completion_pct}%` : '—'} accent="var(--brand)" />
        </div>
      )}

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <strong style={{ fontSize: '13px' }}>{t('group.m.routesN', undefined, { n: group.routes?.length || 0 })}</strong>
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button variant="secondary" icon={Plus} onClick={() => setRouteFormOpen(true)}>{t('group.add_route')}</Button>
          </RoleGate>
        </div>
        {(!group.routes || group.routes.length === 0) && (
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>{t('group.no_routes_yet_in_this')}</p>
        )}
        {group.routes && group.routes.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <tbody>
              {group.routes.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 4px' }}><strong>{r.code}</strong>{r.name && r.name !== r.code ? ` — ${r.name}` : ''}</td>
                  <td style={{ padding: '8px 4px' }} className="tabular-nums">{t('group.m.nCustomers', undefined, { n: r.customer_count })}</td>
                  <td style={{ padding: '8px 4px' }}><StatusBadge status={r.status} /></td>
                  <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                    <RoleGate roles={['admin', 'gudoomiye']}>
                      <Button variant="ghost" icon={Pencil} style={{ padding: '4px 8px', fontSize: '12px' }} onClick={() => setEditRouteTarget(r)}>{t('group.edit')}</Button>
                    </RoleGate>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <strong style={{ fontSize: '13px' }}>
          {t('cust.customers')} {customersMeta ? `(${customersMeta.total})` : ''}
        </strong>
        {customers.length === 0 && <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>{t('group.no_customers_in_this_group')}</p>}
        {customers.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginTop: '8px' }}>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => navigate(`/customers/${c.id}`)}>
                  <td style={{ padding: '8px 4px' }}>{c.business_name || c.name} <span style={{ color: 'var(--text-muted)' }}>({c.customer_number})</span></td>
                  <td style={{ padding: '8px 4px', textTransform: 'capitalize' }}>{t('cust.' + c.customer_type, c.customer_type)}</td>
                  <td style={{ padding: '8px 4px' }}><StatusBadge status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {customersMeta && customersMeta.total > customers.length && (
          <p style={{ margin: '10px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>
            {t('group.m.showing', undefined, { shown: customers.length, total: customersMeta.total })}
          </p>
        )}
      </Card>

      {performance.length > 0 && (
        <Card style={{ padding: '16px', marginTop: '16px' }}>
          <strong style={{ fontSize: '13px' }}>{t('group.collector_performance_in_this_group')}</strong>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginTop: '8px' }}>
            <tbody>
              {performance.map((p) => (
                <tr key={p.collector_id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 4px' }}>{p.collector_name}</td>
                  <td style={{ padding: '8px 4px' }} className="tabular-nums">{t('group.m.nServiced', undefined, { n: p.serviced })}</td>
                  <td style={{ padding: '8px 4px' }} className="tabular-nums">{t('group.m.nMissed', undefined, { n: p.missed })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '16px' }}>
        {t('group.collector_assignment_for_this_group')}
      </p>

      <GroupFormModal open={editOpen} onClose={() => setEditOpen(false)} group={group} />
      <RouteFormModal open={routeFormOpen} onClose={() => setRouteFormOpen(false)} groupId={group.id} />
      <EditRouteModal route={editRouteTarget} onClose={() => setEditRouteTarget(null)} onDone={refetch} />
    </div>
  );
}

function EditRouteModal({ route, onClose, onDone }) {
  const { t } = useI18n();
  const [code, setCode] = useState(route?.code || '');
  const [name, setName] = useState(route?.name || '');
  const [status, setStatus] = useState(route?.status || 'active');
  const [error, setError] = useState('');
  const update = useUpdateRoute(route?.id);
  const toast = useToast();

  React.useEffect(() => {
    if (route) { setCode(route.code); setName(route.name || ''); setStatus(route.status); setError(''); }
  }, [route]);

  if (!route) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!code.trim()) { setError(t('group.route_code_is_required')); return; }
    try {
      await update.mutateAsync({ code: code.trim(), name: name.trim() || null, status });
      toast.success(t('group.route_updated'));
      onDone?.();
      onClose();
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      onClose={update.isPending ? () => {} : onClose}
      title={t('group.edit_route')}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={update.isPending}>{t('common.cancel')}</Button>
        <Button type="submit" form="edit-route-form" disabled={update.isPending}>{update.isPending ? t('common.saving') : t('group.save_changes')}</Button>
      </>}
    >
      <form id="edit-route-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('group.route_code')}</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('group.name_optional')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('common.status')}</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
            <option value="active">{t('status.active')}</option>
            <option value="inactive">{t('status.inactive')}</option>
          </select>
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function RouteFormModal({ open, onClose, groupId }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const createRoute = useCreateRoute();
  const toast = useToast();
  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!code.trim()) { setError(t('group.route_code_is_required')); return; }
    try {
      await createRoute.mutateAsync({ group_id: groupId, code: code.trim(), name: name.trim() || null });
      toast.success(t('fin.m.created', undefined, { number: code }));
      setCode(''); setName(''); setError('');
      onClose();
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      onClose={createRoute.isPending ? () => {} : onClose}
      title={t('group.add_route')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createRoute.isPending}>{t('common.cancel')}</Button>
          <Button type="submit" form="route-form" disabled={createRoute.isPending}>{createRoute.isPending ? t('common.saving') : t('group.save_route')}</Button>
        </>
      }
    >
      <form id="route-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('group.route_code')}</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} style={inputStyle} placeholder="e.g. Route 07-A" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('group.name_optional')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
