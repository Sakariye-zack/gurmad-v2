import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Boxes, Pencil, Plus } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, StatCard, LoadingState, ErrorState, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useGroup, useGroupSummary, useGroupCollectorPerformance, useCreateRoute, useUpdateRoute } from '../../hooks/useGroups.js';
import GroupFormModal from './GroupFormModal.jsx';

// Group Detail — Group & Group-Based Collection CR, Spec §8. Group
// information, Zone, status, customer/route counts and lists, and current
// collection activity (Group-level report summary) — all live-derived,
// never hardcoded (mirrors ZoneDetailPage's own foundation-first pattern).
export default function GroupDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useGroup(id);
  const { data: summaryData } = useGroupSummary(id);
  const { data: perfData } = useGroupCollectorPerformance(id);
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

  if (isLoading) return <LoadingState label="Loading group…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!group) return null;

  return (
    <div>
      <button onClick={() => navigate('/groups')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Groups
      </button>

      <PageHeader
        icon={Boxes}
        title={group.code}
        subtitle={group.zone_name}
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>Edit Group</Button>
          </RoleGate>
        }
      />

      <DetailGrid items={[
        { label: 'Status', value: <StatusBadge status={group.status} /> },
        { label: 'Zone', value: group.zone_name },
        { label: 'Customers', value: group.customer_count },
        { label: 'Routes', value: group.route_count },
      ]} />

      {summary && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '14px', margin: '20px 0' }}>
          <StatCard label="Assigned" value={summary.assigned} />
          <StatCard label="Serviced" value={summary.serviced} accent="var(--success)" />
          <StatCard label="Missed" value={summary.missed} accent="var(--danger)" />
          <StatCard label="Skipped" value={summary.skipped} accent="var(--warning)" />
          <StatCard label="Rescheduled" value={summary.rescheduled} />
          <StatCard label="Remaining" value={summary.remaining} />
          <StatCard label="Completion" value={summary.completion_pct != null ? `${summary.completion_pct}%` : '—'} accent="var(--brand)" />
        </div>
      )}

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <strong style={{ fontSize: '13px' }}>Routes ({group.routes?.length || 0})</strong>
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button variant="secondary" icon={Plus} onClick={() => setRouteFormOpen(true)}>Add Route</Button>
          </RoleGate>
        </div>
        {(!group.routes || group.routes.length === 0) && (
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>No routes yet in this Group.</p>
        )}
        {group.routes && group.routes.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <tbody>
              {group.routes.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 4px' }}><strong>{r.code}</strong>{r.name && r.name !== r.code ? ` — ${r.name}` : ''}</td>
                  <td style={{ padding: '8px 4px' }} className="tabular-nums">{r.customer_count} customers</td>
                  <td style={{ padding: '8px 4px' }}><StatusBadge status={r.status} /></td>
                  <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                    <RoleGate roles={['admin', 'gudoomiye']}>
                      <Button variant="ghost" icon={Pencil} style={{ padding: '4px 8px', fontSize: '12px' }} onClick={() => setEditRouteTarget(r)}>Edit</Button>
                    </RoleGate>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {performance.length > 0 && (
        <Card style={{ padding: '16px', marginTop: '16px' }}>
          <strong style={{ fontSize: '13px' }}>Collector performance in this Group</strong>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', marginTop: '8px' }}>
            <tbody>
              {performance.map((p) => (
                <tr key={p.collector_id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '8px 4px' }}>{p.collector_name}</td>
                  <td style={{ padding: '8px 4px' }} className="tabular-nums">{p.serviced} serviced</td>
                  <td style={{ padding: '8px 4px' }} className="tabular-nums">{p.missed} missed</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '16px' }}>
        Collector assignment for this Group is always an operational task/batch (Collection Operations), never
        a permanent link — the same Group can be assigned to a different collector on a different date.
      </p>

      <GroupFormModal open={editOpen} onClose={() => setEditOpen(false)} group={group} />
      <RouteFormModal open={routeFormOpen} onClose={() => setRouteFormOpen(false)} groupId={group.id} />
      <EditRouteModal route={editRouteTarget} onClose={() => setEditRouteTarget(null)} onDone={refetch} />
    </div>
  );
}

function EditRouteModal({ route, onClose, onDone }) {
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
    if (!code.trim()) { setError('Route code is required.'); return; }
    try {
      await update.mutateAsync({ code: code.trim(), name: name.trim() || null, status });
      toast.success('Route updated.');
      onDone?.();
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={update.isPending ? () => {} : onClose}
      title="Edit Route"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={update.isPending}>Cancel</Button>
        <Button type="submit" form="edit-route-form" disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save Changes'}</Button>
      </>}
    >
      <form id="edit-route-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>Route code</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>Name (optional)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function RouteFormModal({ open, onClose, groupId }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const createRoute = useCreateRoute();
  const toast = useToast();
  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!code.trim()) { setError('Route code is required.'); return; }
    try {
      await createRoute.mutateAsync({ group_id: groupId, code: code.trim(), name: name.trim() || null });
      toast.success(`${code} created.`);
      setCode(''); setName(''); setError('');
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={createRoute.isPending ? () => {} : onClose}
      title="Add Route"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={createRoute.isPending}>Cancel</Button>
          <Button type="submit" form="route-form" disabled={createRoute.isPending}>{createRoute.isPending ? 'Saving…' : 'Save Route'}</Button>
        </>
      }
    >
      <form id="route-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>Route code</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} style={inputStyle} placeholder="e.g. Route 07-A" />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>Name (optional)</span>
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
