import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Truck, Pencil } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, ConfirmDialog, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useTruck, useUpdateTruckStatus } from '../../hooks/useTrucks.js';
import { useFuelRecords, useMaintenanceRecords } from '../../hooks/useFleet.js';
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
  const { data: fuelData } = useFuelRecords({ truck_id: id });
  const { data: maintenanceData } = useMaintenanceRecords({ truck_id: id });
  const fuelRecords = fuelData?.data || [];
  const maintenanceRecords = maintenanceData?.data || [];

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

      <div style={{ marginBottom: '20px' }}>
        <DetailGrid items={[
          { label: 'Status', value: <StatusBadge status={truck.status} /> },
          { label: 'Compliance', value: <StatusBadge status={COMPLIANCE_LABELS[cs]} map={{ [COMPLIANCE_LABELS[cs].toLowerCase()]: COMPLIANCE_BADGE_MAP[cs] }} /> },
          { label: 'Zone', value: truck.zone_name || '— (company-wide)' },
          { label: 'Capacity', value: truck.capacity != null ? truck.capacity : '—', className: 'tabular-nums' },
          { label: 'Driver', value: truck.driver_name || '— (unassigned)' },
          { label: 'Collector', value: truck.collector_name || '— (unassigned)' },
        ]} />
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
      <DetailGrid items={[
        { label: 'Insurance expiry', value: truck.insurance_expiry || '—', className: 'tabular-nums' },
        { label: 'Registration expiry', value: truck.registration_expiry || '—', className: 'tabular-nums' },
        { label: 'Road tax expiry', value: truck.road_tax_expiry || '—', className: 'tabular-nums' },
      ]} />

      {truck.notes && (
        <Card style={{ ...cardPad, marginTop: '16px' }}>
          <Label>Notes</Label>
          <p style={{ margin: '6px 0 0', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{truck.notes}</p>
        </Card>
      )}

      {/* User-requested gap-audit ('maxaa ka dhiman imika mashruucaygan'):
          this placeholder claimed fuel/maintenance modules weren't
          implemented yet — both have existed (with truck_id filtering)
          since Fleet Management shipped; nobody ever came back to
          replace this stale text with the real history. Collection task
          assignment genuinely has no dedicated module yet — that part of
          the original sentence stays honest. */}
      <Card style={{ ...cardPad, marginTop: '16px' }}>
        <Label>Fuel Log ({fuelRecords.length})</Label>
        {fuelRecords.length === 0 && <p style={emptyStyle}>No fuel records for this truck yet.</p>}
        {fuelRecords.slice(0, 6).map((f) => (
          <div key={f.id} style={rowStyle}>
            <span>{new Date(f.record_date).toLocaleDateString()} — {parseFloat(f.liters).toFixed(2)}L</span>
            <span style={{ color: 'var(--text-muted)' }}>${parseFloat(f.cost).toFixed(2)}{f.needs_review && ' · Review'}</span>
          </div>
        ))}
        {fuelRecords.length > 6 && <p style={moreStyle}>+ {fuelRecords.length - 6} more — see Fleet Fuel.</p>}
      </Card>

      <Card style={{ ...cardPad, marginTop: '16px' }}>
        <Label>Maintenance History ({maintenanceRecords.length})</Label>
        {maintenanceRecords.length === 0 && <p style={emptyStyle}>No maintenance records for this truck yet.</p>}
        {maintenanceRecords.slice(0, 6).map((m) => (
          <div key={m.id} style={rowStyle}>
            <span>{m.description}</span>
            <span style={{ color: 'var(--text-muted)' }}>${parseFloat(m.cost).toFixed(2)}</span>
          </div>
        ))}
        {maintenanceRecords.length > 6 && <p style={moreStyle}>+ {maintenanceRecords.length - 6} more — see Fleet Maintenance.</p>}
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

const cardPad = { padding: '16px' };
const emptyStyle = { margin: '6px 0 0', fontSize: '13px', color: 'var(--text-muted)' };
const moreStyle = { margin: '8px 0 0', fontSize: '12px', color: 'var(--text-muted)' };
const rowStyle = { display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' };
const sectionLabelStyle = {
  display: 'block', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em',
  color: 'var(--text-muted)', margin: '20px 0 10px',
};
const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
