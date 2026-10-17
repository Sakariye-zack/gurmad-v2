import React, { useState } from 'react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import { useUpdateCustomerNumber } from '../../hooks/useCustomers.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

// Dedicated Customer Number edit surface — deliberately separate from the
// general Edit Customer form (Discovery §23): a sensitive, audited,
// hard-uniqueness action gets its own small, focused flow, not folded into
// a big form where it's easy to change by accident.
export default function CustomerNumberEditModal({ open, onClose, customer }) {
  if (!open) return null;
  return <Content onClose={onClose} customer={customer} />;
}

function Content({ onClose, customer }) {
  const { t } = useI18n();
  const [value, setValue] = useState(customer.customer_number);
  const [error, setError] = useState('');
  const toast = useToast();
  const updateNumber = useUpdateCustomerNumber(customer.id);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    try {
      await updateNumber.mutateAsync(value.trim());
      toast.success(t('cust.m.numberUpdated', undefined, { number: value.trim().toUpperCase() }));
      onClose();
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      onClose={updateNumber.isPending ? () => {} : onClose}
      title={t('cust.edit_customer_number')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={updateNumber.isPending}>{t('common.cancel')}</Button>
          <Button type="submit" form="customer-number-form" disabled={updateNumber.isPending}>
            {updateNumber.isPending ? t('common.saving') : t('cust.save')}
          </Button>
        </>
      }
    >
      <form id="customer-number-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
          {t('cust.m.currentLabel')} <strong>{customer.customer_number}</strong>. {t('cust.m.numberNote')}
        </p>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700 }}>{t('cust.new_customer_number')}</span>
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
