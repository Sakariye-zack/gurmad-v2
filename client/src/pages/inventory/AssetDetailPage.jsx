import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Boxes, Repeat, Ban } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, Modal, ConfirmDialog, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useAsset, useAssetTransferHistory, useTransferAsset, useRetireAsset } from '../../hooks/useInventory.js';
import { useEmployees } from '../../hooks/useEmployees.js';

const STATUS_MAP = { active: 'success', assigned: 'info', in_maintenance: 'warning', retired: 'danger' };

export default function AssetDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [transferOpen, setTransferOpen] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const { data, isLoading, error, refetch } = useAsset(id);
  const { data: historyData } = useAssetTransferHistory(id);
  const asset = data?.data;
  const history = historyData?.data || [];

  if (isLoading) return <LoadingState label="Loading asset…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!asset) return null;

  const isRetired = asset.status === 'retired';

  return (
    <div>
      <button onClick={() => navigate('/inventory/assets')} style={backLinkStyle}><ArrowLeft size={14} /> Back to Assets</button>
      <PageHeader
        icon={Boxes}
        title={asset.name}
        subtitle={asset.asset_tag || 'Company asset'}
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <Button icon={Repeat} variant="secondary" disabled={isRetired} onClick={() => setTransferOpen(true)}>Assign / Transfer</Button>
              <RoleGate roles={['admin']}>
                <Button icon={Ban} variant="danger" disabled={isRetired} onClick={() => setRetireOpen(true)}>Retire</Button>
              </RoleGate>
            </div>
          </RoleGate>
        }
      />
      <div style={{ marginBottom: '16px' }}><StatusBadge status={asset.status} map={STATUS_MAP} /></div>

      <DetailGrid items={[
        { label: 'Category', value: asset.category || '—' },
        { label: 'Serial number', value: asset.serial_number || '—' },
        { label: 'Zone', value: asset.zone_name || 'Company-wide' },
        { label: 'Store location', value: asset.store_location_name || '—' },
        { label: 'Assigned to', value: asset.assigned_employee_name || '—' },
        { label: 'Acquisition cost', value: asset.acquisition_cost ?? '—', className: 'tabular-nums' },
        { label: 'Acquisition date', value: asset.acquisition_date ? new Date(asset.acquisition_date).toLocaleDateString() : '—' },
        { label: 'Condition', value: asset.condition || '—' },
      ]} />

      {isRetired && (
        <Card style={{ padding: '16px', marginTop: '16px' }}>
          <Label>Retirement</Label>
          <p style={{ margin: '8px 0 0', fontSize: '13px' }}>{asset.retired_reason || '—'}</p>
          <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--text-muted)' }}>{asset.retired_at ? new Date(asset.retired_at).toLocaleString() : ''}</p>
        </Card>
      )}

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <Label>Transfer History</Label>
        {history.length === 0 && <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>No transfers recorded yet.</p>}
        {history.map((t) => (
          <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
            <span>{t.from_employee_name || 'Unassigned'} → {t.to_employee_name || 'Unassigned'}</span>
            <span style={{ color: 'var(--text-muted)' }}>{new Date(t.transferred_at).toLocaleDateString()}</span>
          </div>
        ))}
      </Card>

      <TransferModal open={transferOpen} onClose={() => setTransferOpen(false)} asset={asset} />
      <RetireDialog open={retireOpen} onClose={() => setRetireOpen(false)} asset={asset} />
    </div>
  );
}

function TransferModal({ open, onClose, asset }) {
  const [employeeId, setEmployeeId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const { data: employeesData } = useEmployees({ status: 'active' });
  const transfer = useTransferAsset();
  const toast = useToast();
  const employees = employeesData?.data || [];
  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault(); setError('');
    if (!reason.trim()) { setError('Reason is required.'); return; }
    try {
      await transfer.mutateAsync({ id: asset.id, to_employee_id: employeeId || null, reason: reason.trim() });
      toast.success('Asset transferred.'); setEmployeeId(''); setReason(''); onClose();
    } catch (err) { setError(err.message || 'Something went wrong.'); }
  }

  return (
    <Modal open onClose={transfer.isPending ? () => {} : onClose} title="Assign / Transfer Asset"
      footer={<><Button variant="secondary" onClick={onClose} disabled={transfer.isPending}>Cancel</Button><Button type="submit" form="transfer-asset-form" disabled={transfer.isPending}>{transfer.isPending ? 'Saving…' : 'Confirm'}</Button></>}>
      <form id="transfer-asset-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Assign to employee (leave blank to unassign)</span>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} style={inputStyle}>
            <option value="">Unassigned</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name || e.name}</option>)}
          </select>
        </label>
        <label style={fieldStyle}><span style={labelStyle}>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} style={inputStyle} /></label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function RetireDialog({ open, onClose, asset }) {
  const [reason, setReason] = useState('');
  const retire = useRetireAsset();
  const toast = useToast();

  async function handleConfirm() {
    if (!reason.trim()) return;
    try { await retire.mutateAsync({ id: asset.id, reason: reason.trim() }); toast.success('Asset retired.'); setReason(''); onClose(); }
    catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={handleConfirm}
      title={`Retire ${asset.name}?`}
      message={
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <span>This is permanent — a retired asset cannot be reactivated or edited. History remains intact.</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Retirement reason" style={inputStyle} />
        </div>
      }
      confirmLabel="Retire"
      danger
      isLoading={retire.isPending}
    />
  );
}

function Label({ children }) {
  return <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{children}</span>;
}
const backLinkStyle = { display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = { padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit' };
