import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Receipt, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, Modal, ConfirmDialog, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { usePayrollRecord, useAddPayrollItem, useSettlePayrollRecord, useReversePayrollRecord, useDeletePayrollItem } from '../../hooks/usePayroll.js';

const STATUS_MAP = { open: 'info', processing: 'warning', finalized: 'success', paid: 'success', reversed: 'danger' };

export default function PayrollRecordDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, isLoading, error, refetch } = usePayrollRecord(id);
  const [itemFormOpen, setItemFormOpen] = useState(false);
  const [settleOpen, setSettleOpen] = useState(false);
  const [reverseConfirmOpen, setReverseConfirmOpen] = useState(false);
  const reverseMutation = useReversePayrollRecord();
  // User-requested gap-audit sweep ('sii wad'): useDeletePayrollItem()
  // already existed in usePayroll.js, fully wired to the backend
  // (DELETE .../items/:itemId, admin-only, open/processing only —
  // matches this page's own isEditable gate), but 'Add Item' had no
  // counterpart — a mistakenly-added earning/deduction had no way to
  // be removed short of an admin editing the database directly.
  const deleteItem = useDeletePayrollItem();
  const record = data?.data;

  if (isLoading) return <LoadingState label="Loading payroll record…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!record) return null;

  const isEditable = record.status === 'open' || record.status === 'processing';
  const isFinalized = record.status === 'finalized';

  async function handleReverse(reason) {
    try {
      await reverseMutation.mutateAsync({ id: record.id, reason });
      toast.success('Payroll record reversed. A new open record was created.');
      setReverseConfirmOpen(false);
      refetch();
    } catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }
  async function handleDeleteItem(itemId) {
    try {
      await deleteItem.mutateAsync({ id: record.id, itemId });
      toast.success('Line item removed.');
      refetch();
    } catch (err) { toast.error(err.message || 'Something went wrong.'); }
  }

  return (
    <div>
      <button onClick={() => navigate(-1)} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back
      </button>

      <PageHeader
        icon={Receipt}
        title={`Payroll — ${record.period?.label || ''}`}
        subtitle="Structured payslip view — derived directly from the finalized payroll record."
        actions={
          <RoleGate roles={['admin']}>
            <div style={{ display: 'flex', gap: '8px' }}>
              {isEditable && <Button icon={Plus} variant="secondary" onClick={() => setItemFormOpen(true)}>Add Item</Button>}
              {isFinalized && <Button icon={RotateCcw} variant="danger" onClick={() => setReverseConfirmOpen(true)}>Reverse</Button>}
            </div>
          </RoleGate>
        }
      />

      <div style={{ marginBottom: '16px' }}><StatusBadge status={record.status} map={STATUS_MAP} /></div>

      <DetailGrid items={[
        { label: 'Salary Snapshot', value: parseFloat(record.salary_snapshot).toFixed(2), className: 'tabular-nums' },
        { label: 'Earnings', value: parseFloat(record.earnings_total).toFixed(2), className: 'tabular-nums' },
        { label: 'Deductions', value: parseFloat(record.deductions_total).toFixed(2), className: 'tabular-nums' },
        { label: 'Net Salary', value: <strong>{parseFloat(record.net_salary).toFixed(2)}</strong>, className: 'tabular-nums' },
      ]} />

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <Label>Line Items</Label>
        {record.items.length === 0 && <p style={{ margin: '8px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>No line items.</p>}
        {record.items.map((item) => (
          <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
            <span>{item.description} {item.source_type === 'cashout_shortage' && <span style={{ color: 'var(--text-muted)' }}>(cashout shortage #{item.source_id})</span>}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span className="tabular-nums" style={{ color: item.item_type === 'earning' ? 'var(--success)' : 'var(--danger)' }}>
                {item.item_type === 'earning' ? '+' : '-'}{parseFloat(item.amount).toFixed(2)}
              </span>
              {isEditable && (
                <RoleGate roles={['admin']}>
                  <button
                    onClick={() => handleDeleteItem(item.id)}
                    disabled={deleteItem.isPending}
                    aria-label={`Remove ${item.description}`}
                    style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: '2px' }}
                  >
                    <Trash2 size={14} />
                  </button>
                </RoleGate>
              )}
            </div>
          </div>
        ))}
      </Card>

      {record.settlement ? (
        <Card style={{ padding: '16px', marginTop: '16px' }}>
          <Label>Settlement</Label>
          <p style={{ margin: '8px 0 0', fontSize: '13px' }}>
            {record.settlement.method === 'cash' ? 'Cash' : `Mobile Money${record.settlement.provider ? ` (${record.settlement.provider})` : ''}`} —
            {' '}{parseFloat(record.settlement.amount).toFixed(2)} on {new Date(record.settlement.settled_at).toLocaleDateString()}
            {record.settlement.reference && ` · Ref: ${record.settlement.reference}`}
          </p>
        </Card>
      ) : isFinalized && (
        <RoleGate roles={['admin', 'head_of_cashiers']}>
          <Card style={{ padding: '16px', marginTop: '16px' }}>
            <Button onClick={() => setSettleOpen(true)}>Settle Payroll</Button>
          </Card>
        </RoleGate>
      )}

      <PayrollItemFormModal open={itemFormOpen} onClose={() => setItemFormOpen(false)} recordId={record.id} />
      <SettleFormModal open={settleOpen} onClose={() => setSettleOpen(false)} recordId={record.id} />
      <ConfirmDialog
        open={reverseConfirmOpen}
        onClose={() => setReverseConfirmOpen(false)}
        onConfirm={() => handleReverse(document.getElementById('reverse-reason')?.value)}
        title="Reverse this payroll record?"
        message={<span style={{ display: 'block' }}>
          The original record will be marked reversed and preserved. A new open payroll record will be created for correction.
          <input id="reverse-reason" placeholder="Reason for reversal" style={{ ...inputStyle, marginTop: '10px' }} />
        </span>}
        confirmLabel="Reverse"
        danger
        isLoading={reverseMutation.isPending}
      />
    </div>
  );
}

function PayrollItemFormModal({ open, onClose, recordId }) {
  const [itemType, setItemType] = useState('earning');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const add = useAddPayrollItem();
  const toast = useToast();

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) { setError('Amount must be a positive number.'); return; }
    if (!description.trim()) { setError('Description is required.'); return; }
    try {
      await add.mutateAsync({ id: recordId, item_type: itemType, amount: amt, description: description.trim() });
      toast.success('Line item added.');
      setAmount(''); setDescription('');
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={add.isPending ? () => {} : onClose}
      title="Add Payroll Item"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={add.isPending}>Cancel</Button>
        <Button type="submit" form="payroll-item-form" disabled={add.isPending}>{add.isPending ? 'Saving…' : 'Add Item'}</Button>
      </>}
    >
      <form id="payroll-item-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Type</span>
          <select value={itemType} onChange={(e) => setItemType(e.target.value)} style={inputStyle}>
            <option value="earning">Earning / Allowance</option>
            <option value="deduction">Deduction</option>
          </select>
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Amount</span>
          <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} style={inputStyle} />
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function SettleFormModal({ open, onClose, recordId }) {
  const [method, setMethod] = useState('cash');
  const [provider, setProvider] = useState('');
  const [reference, setReference] = useState('');
  const [error, setError] = useState('');
  const settle = useSettlePayrollRecord();
  const toast = useToast();

  if (!open) return null;

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      await settle.mutateAsync({ id: recordId, method, provider: provider || undefined, reference: reference || undefined });
      toast.success('Payroll settled.');
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={settle.isPending ? () => {} : onClose}
      title="Settle Payroll"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={settle.isPending}>Cancel</Button>
        <Button type="submit" form="settle-form" disabled={settle.isPending}>{settle.isPending ? 'Settling…' : 'Settle'}</Button>
      </>}
    >
      <form id="settle-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>Method</span>
          <select value={method} onChange={(e) => setMethod(e.target.value)} style={inputStyle}>
            <option value="cash">Cash</option>
            <option value="mobile_money">Mobile Money</option>
          </select>
        </label>
        {method === 'mobile_money' && (
          <label style={fieldStyle}>
            <span style={labelStyle}>Provider (optional)</span>
            <input value={provider} onChange={(e) => setProvider(e.target.value)} style={inputStyle} placeholder="e.g. ZAAD" />
          </label>
        )}
        <label style={fieldStyle}>
          <span style={labelStyle}>Reference (optional)</span>
          <input value={reference} onChange={(e) => setReference(e.target.value)} style={inputStyle} />
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

function Label({ children }) {
  return <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{children}</span>;
}

const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit', marginTop: '8px',
};
