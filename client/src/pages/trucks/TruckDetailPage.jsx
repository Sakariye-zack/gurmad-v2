import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Truck, Pencil } from 'lucide-react';
import { PageHeader, Button, Card, StatusBadge, LoadingState, ErrorState, ConfirmDialog, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useTruck, useUpdateTruckStatus } from '../../hooks/useTrucks.js';
import TruckFormModal from './TruckFormModal.jsx';
import { complianceState, COMPLIANCE_LABELS, COMPLIANCE_BADGE_MAP } from './complianceState.js';

// Lifecycle vocabulary is frozen (OD-3): Active / Maintenance / Inactive /
// Retired. Retired is a confirmed, permanent one-way terminal state
// (backend-enforced, Module 4 final review) — the UI mirrors that by never
// offering a way out of Retired, rather than offering a button the backend
// would just reject.
const TRANSITIONS = {
  active: ['maintenance', 'inactive', 'retired'],
  maintenance: ['active', 'inactive', 'retired'],
  inactive: ['active', 'maintenance', 'retired'],
  retired: [],
};
const STATUS_LABELS = { active: 'Active', maintenance: 'Maintenance', inactive: 'Inactive', retired: 'Retired' };

export default function TruckDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useTruck(id);
  const [editOpen, setEditOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState(null);
  const updateStatus = useUpdateTruckStatus(id);
  const toast = useToast();
  const truck = data?.data;

  if (isLoading) return <LoadingState label="Loading truck…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!truck) return null;

  const cs = complianceState(truck);
  const availableTransitions = TRANSITIONS[truck.status] || [];

  async function handleStatusChange() {
    try {
      await updateStatus.mutateAsync(pendingStatus);
      toast.success(`Status changed to ${STATUS_LABELS[pendingStatus]}.`);
      setPendingStatus(null);
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
      setPendingStatus(null);
    }
  }

  return (
    <div>
      <button onClick={() => navigate('/trucks')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Trucks
      </button>

      <PageHeader
        icon={Truck}
        title={truck.plate_number}
        subtitle={`${truck.model || 'No model set'}${truck.zone_name ? ` · ${truck.zone_name}` : ' · Company-wide'}`}
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>Edit Truck</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '20px' }}>
        <Card style={cardPad}><Label>Status</Label><div style={{ marginTop: '6px' }}><StatusBadge status={truck.status} /></div></Card>
        <Card style={cardPad}><Label>Zone</Label><Value>{truck.zone_name || '— (company-wide)'}</Value></Card>
        <Card style={cardPad}><Label>Driver</Label><Value>{truck.driver_name || '— (unassigned)'}</Value></Card>
        <Card style={cardPad}><Label>Collector</Label><Value>{truck.collector_name || '— (unassigned)'}</Value></Card>
        <Card style={cardPad}><Label>Capacity</Label><Value className="tabular-nums">{truck.capacity != null ? truck.capacity : '—'}</Value></Card>
        <Card style={cardPad}>
          <Label>Compliance</Label>
          <div style={{ marginTop: '6px' }}>
            <StatusBadge status={COMPLIANCE_LABELS[cs]} map={{ [COMPLIANCE_LABELS[cs].toLowerCase()]: COMPLIANCE_BADGE_MAP[cs] }} />
          </div>
        </Card>
      </div>

      <RoleGate roles={['admin', 'gudoomiye']}>
        {availableTransitions.length > 0 && (
          <Card style={{ ...cardPad, marginBottom: '20px' }}>
            <Label>Change lifecycle status</Label>
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' }}>
              {availableTransitions.map((s) => (
                <Button key={s} variant={s === 'retired' ? 'danger' : 'secondary'} onClick={() => setPendingStatus(s)}>
                  Mark as {STATUS_LABELS[s]}
                </Button>
              ))}
            </div>
          </Card>
        )}
        {truck.status === 'retired' && (
          <Card style={{ ...cardPad, marginBottom: '20px' }}>
            <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
              This truck is Retired — a permanent, terminal status. Historical records remain preserved.
              Returning a retired truck to service requires a separate, future business decision.
            </p>
          </Card>
        )}
      </RoleGate>

      <span style={sectionLabelStyle}>Compliance details</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
        <Card style={cardPad}><Label>Insurance expiry</Label><Value className="tabular-nums">{truck.insurance_expiry || '—'}</Value></Card>
        <Card style={cardPad}><Label>Registration expiry</Label><Value className="tabular-nums">{truck.registration_expiry || '—'}</Value></Card>
        <Card style={cardPad}><Label>Road tax expiry</Label><Value className="tabular-nums">{truck.road_tax_expiry || '—'}</Value></Card>
      </div>

      {truck.notes && (
        <Card style={{ ...cardPad, marginTop: '16px' }}>
          <Label>Notes</Label>
          <p style={{ margin: '6px 0 0', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{truck.notes}</p>
        </Card>
      )}

      <Card style={{ ...cardPad, marginTop: '16px' }}>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>
          Fuel logs, maintenance history, and collection task assignment for this truck will appear here
          once their respective modules are implemented, per the approved one-module-at-a-time sequence.
        </p>
      </Card>

      <TruckFormModal open={editOpen} onClose={() => setEditOpen(false)} truck={truck} />
      <ConfirmDialog
        open={!!pendingStatus}
        onClose={() => setPendingStatus(null)}
        onConfirm={handleStatusChange}
        title={`Mark as ${pendingStatus ? STATUS_LABELS[pendingStatus] : ''}?`}
        message={pendingStatus === 'retired'
          ? `${truck.plate_number} will be permanently retired from active fleet operations. All history remains intact — this does not delete anything.`
          : `${truck.plate_number}'s status will change to ${pendingStatus ? STATUS_LABELS[pendingStatus] : ''}.`}
        confirmLabel={pendingStatus ? `Mark as ${STATUS_LABELS[pendingStatus]}` : 'Confirm'}
        danger={pendingStatus === 'retired'}
        isLoading={updateStatus.isPending}
      />
    </div>
  );
}

function Label({ children }) {
  return <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{children}</span>;
}
function Value({ children, className }) {
  return <div className={className} style={{ marginTop: '6px', fontSize: '15px', fontWeight: 700 }}>{children}</div>;
}

const cardPad = { padding: '16px' };
const sectionLabelStyle = {
  display: 'block', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--text-muted)', margin: '0 0 10px',
};
const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
