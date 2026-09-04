import React from 'react';
import { Modal, StatusBadge } from '../../components/ui/index.js';
import { useAuditRecord } from '../../hooks/useAudit.js';

const SEVERITY_MAP = { info: 'info', warning: 'warning', critical: 'danger' };

// Audit & Security Center — Implementation Spec §14. Shows exactly and
// only the fields that exist in the source v2_audit_log row — IP address,
// user-agent, and zone are NOT shown, because none of those columns exist
// (Discovery §3) — an honest note explains the absence rather than a
// fabricated or "coming soon" field.
export default function AuditDetailModal({ id, onClose }) {
  const { data, isLoading, error } = useAuditRecord(id);
  const record = data?.data;

  return (
    <Modal open={!!id} onClose={onClose} title="Audit Record" maxWidth="640px">
      {isLoading && <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Loading…</p>}
      {error && <p style={{ fontSize: '13px', color: 'var(--danger)' }}>{error.message}</p>}
      {record && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <Row label="Timestamp" value={new Date(record.created_at).toLocaleString()} />
          <Row label="Actor" value={record.actor_username || '—'} sub={record.actor_id != null ? `id ${record.actor_id}` : null} />
          <Row label="Action" value={record.action} />
          <Row label="Category" value={record.category} />
          <Row label="Severity" value={<StatusBadge status={record.severity?.toLowerCase()} map={SEVERITY_MAP} />} />
          <Row label="Outcome" value={<StatusBadge status={record.success ? 'success' : 'failed'} map={{ success: 'success', failed: 'danger' }} />} />
          <Row label="Entity" value={record.entity_type ? `${record.entity_type}${record.entity_id != null ? ` #${record.entity_id}` : ''}` : '—'} />

          <div style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '8px 10px', background: 'var(--surface-alt, var(--surface))', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
            IP address and device information are not currently captured for staff actions.
          </div>

          {record.before_data && (
            <div>
              <Label>Before</Label>
              <pre style={preStyle}>{JSON.stringify(record.before_data, null, 2)}</pre>
            </div>
          )}
          {record.after_data && (
            <div>
              <Label>After</Label>
              <pre style={preStyle}>{JSON.stringify(record.after_data, null, 2)}</pre>
            </div>
          )}
          {!record.before_data && !record.after_data && (
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No before/after detail was recorded for this event.</p>
          )}
        </div>
      )}
    </Modal>
  );
}

function Row({ label, value, sub }) {
  return (
    <div>
      <Label>{label}</Label>
      <div style={{ fontSize: '14px', marginTop: '2px' }}>{value}{sub && <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>({sub})</span>}</div>
    </div>
  );
}
function Label({ children }) {
  return <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{children}</span>;
}
const preStyle = {
  marginTop: '6px', padding: '10px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', fontSize: '12px', overflowX: 'auto', maxHeight: '220px',
};
