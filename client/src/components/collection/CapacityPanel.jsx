import React from 'react';
import { Truck } from 'lucide-react';
import { StatCard, StatusBadge, Card } from '../ui/index.js';

// Shared capacity display — Batch List/Detail, Add-Task truck selection, and
// the reschedule-target picker all use this so "what capacity looks like"
// is defined once, never redesigned per surface (final hardening pass, §A).
// Presentation only — every number here comes straight from the server's
// own live-computed `capacity` object (GET /v2/batches/:id or the batches
// list), never recalculated client-side. Enforcement stays server-side.
const STATUS_LABEL = { within: 'Within Capacity', near: 'Near Capacity', over: 'Over Capacity' };
const STATUS_VARIANT = { within: 'success', near: 'warning', over: 'danger' };

export default function CapacityPanel({ capacity, compact = false }) {
  if (!capacity || capacity.status === 'no_truck') {
    if (compact) return <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No truck</span>;
    return (
      <Card style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Truck size={16} color="var(--text-muted)" />
        <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>No truck assigned yet — capacity will show once a truck is assigned to a task.</span>
      </Card>
    );
  }
  if (capacity.status === 'not_configured') {
    if (compact) return <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Capacity not configured</span>;
    return (
      <Card style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Truck size={16} color="var(--text-muted)" />
        <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Assigned truck has no capacity configured — capacity cannot be checked.</span>
      </Card>
    );
  }

  const { capacity: cap, load, remaining, utilizationPercent, status } = capacity;

  if (compact) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <span className="tabular-nums" style={{ fontSize: '13px', fontWeight: 700 }}>{load}/{cap}</span>
        <span className="tabular-nums" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{utilizationPercent}%</span>
        <StatusBadge status={STATUS_LABEL[status]} map={{ [STATUS_LABEL[status].toLowerCase()]: STATUS_VARIANT[status] }} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}>
        <StatCard label="Truck Capacity" value={cap} icon={Truck} />
        <StatCard label="Current Load" value={load} accent={status === 'over' ? 'var(--danger)' : 'var(--info)'} />
        <StatCard label="Remaining" value={Math.max(remaining, 0)} accent={remaining < 0 ? 'var(--danger)' : 'var(--success)'} />
        <StatCard label="Utilization" value={`${utilizationPercent}%`} accent={STATUS_VARIANT[status] === 'danger' ? 'var(--danger)' : STATUS_VARIANT[status] === 'warning' ? 'var(--warning)' : 'var(--success)'} />
      </div>
      <div style={{ marginTop: '10px' }}>
        <StatusBadge status={STATUS_LABEL[status]} map={{ [STATUS_LABEL[status].toLowerCase()]: STATUS_VARIANT[status] }} />
        {status === 'over' && (
          <span style={{ marginLeft: '8px', fontSize: '12px', color: 'var(--danger)' }}>
            {load - cap} over capacity — this batch cannot start until it is resolved.
          </span>
        )}
      </div>
    </div>
  );
}

// Small inline preview used by pickers (target-batch reschedule list,
// truck-selection dropdown) to show "what would happen" before the user
// commits — a client-side PREVIEW only. The server re-checks authoritatively
// on submit regardless of what this shows (final hardening pass, §B/§C).
export function CapacityPreview({ capacityBefore, additionalLoad = 1 }) {
  if (!capacityBefore || capacityBefore.status === 'no_truck' || capacityBefore.status === 'not_configured' || capacityBefore.capacity == null) {
    return <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No capacity limit to preview.</span>;
  }
  const resultingLoad = capacityBefore.load + additionalLoad;
  const wouldExceed = resultingLoad > capacityBefore.capacity;
  return (
    <span className="tabular-nums" style={{ fontSize: '12px', color: wouldExceed ? 'var(--danger)' : 'var(--text-muted)', fontWeight: wouldExceed ? 700 : 400 }}>
      {capacityBefore.load} → {resultingLoad} / {capacityBefore.capacity}
      {wouldExceed && ` — exceeds capacity by ${resultingLoad - capacityBefore.capacity}`}
    </span>
  );
}
