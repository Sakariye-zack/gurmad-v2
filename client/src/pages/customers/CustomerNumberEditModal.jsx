import React, { useState } from 'react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import { useUpdateCustomerNumber } from '../../hooks/useCustomers.js';

// Dedicated Customer Number edit surface — deliberately separate from the
// general Edit Customer form (Discovery §23): a sensitive, audited,
// hard-uniqueness action gets its own small, focused flow, not folded into
// a big form where it's easy to change by accident.
export default function CustomerNumberEditModal({ open, onClose, customer }) {
  if (!open) return null;
  return <Content onClose={onClose} customer={customer} />;
}

function Content({ onClose, customer }) {
  const [value, setValue] = useState(customer.customer_number);
  const [error, setError] = useState('');
  const toast = useToast();
  const updateNumber = useUpdateCustomerNumber(customer.id);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      await updateNumber.mutateAsync(value.trim());
      toast.success(`Customer Number updated to ${value.trim().toUpperCase()}.`);
      onClose();
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={updateNumber.isPending ? () => {} : onClose}
      title="Edit Customer Number"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={updateNumber.isPending}>Cancel</Button>
          <Button type="submit" form="customer-number-form" disabled={updateNumber.isPending}>
            {updateNumber.isPending ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form id="customer-number-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
          Current: <strong>{customer.customer_number}</strong>. This customer&rsquo;s internal record and all
          its history (billing, debts, collection tasks) stay linked by internal ID and are unaffected by this change.
        </p>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>New Customer Number</span>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="C-01"
            style={{ padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '14px' }}
          />
          {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
        </label>
      </form>
    </Modal>
  );
}
