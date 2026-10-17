import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Receipt, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, StatCard, Modal, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useInvoices, useCreateInvoice } from '../../hooks/useFinancial.js';
import { useCustomers } from '../../hooks/useCustomers.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

const STATUS_MAP = { unpaid: 'danger', partial: 'warning', paid: 'success', voided: 'info' };

export default function InvoicesListPage() {
  // Deep-linkable status — user-requested ('dashboardka adminka mid
  // kasta hadan ku dhufto waa in details ku ii soo baxaan'): the
  // Dashboard's Outstanding Balance/Debt cards now navigate here with
  // ?status=unpaid.
  const { t } = useI18n();
  const [searchParams] = useSearchParams();
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || '');
  const [search, setSearch] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useInvoices({ status: statusFilter || undefined, q: search || undefined });
  const invoices = data?.data || [];
  const unpaidCount = invoices.filter((i) => i.status === 'unpaid').length;
  const partialCount = invoices.filter((i) => i.status === 'partial').length;

  return (
    <div>
      <PageHeader
        icon={Receipt}
        title={t('portal.nav.invoices')}
        subtitle={t('fin.financial_documents_what_each_custom')}
        actions={
          <RoleGate roles={['admin', 'cashier']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>{t('fin.create_invoice')}</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label={t('fin.total_invoices')} value={error ? '—' : invoices.length} icon={Receipt} />
        <StatCard label={t('status.unpaid')} value={error ? '—' : unpaidCount} icon={Receipt} accent="var(--danger)" />
        <StatCard label={t('status.partial')} value={error ? '—' : partialCount} icon={Receipt} accent="var(--warning)" />
      </div>

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder={t('fin.search_invoice_customer_name_or')}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="">{t('cust.all_statuses')}</option>
          <option value="unpaid">{t('status.unpaid')}</option>
          <option value="partial">{t('status.partial')}</option>
          <option value="paid">{t('status.paid')}</option>
          <option value="voided">{t('status.voided')}</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && invoices.length === 0}
        emptyTitle={t('portal.invoices.empty')}
        emptySubtitle={t('fin.create_the_first_invoice_to')}
        columns={[{ label: t('portal.col.invoice') }, { label: t('fin.customer') }, { label: t('common.total') }, { label: t('common.status') }, { label: t('fin.created') }]}
      >
        {invoices.map((inv) => (
          <tr key={inv.id} onClick={() => navigate(`/financial/invoices/${inv.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong>{inv.invoice_number}</strong></td>
            <td style={cellStyle}>{inv.customer_name} <span style={{ color: 'var(--text-muted)' }}>({inv.customer_number})</span></td>
            <td style={cellStyle} className="tabular-nums">{inv.currency} {parseFloat(inv.invoice_total).toFixed(2)}</td>
            <td style={cellStyle}><StatusBadge status={inv.status} map={STATUS_MAP} /></td>
            <td style={cellStyle}>{new Date(inv.created_at).toLocaleDateString()}</td>
          </tr>
        ))}
      </DataTable>

      <InvoiceFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

function InvoiceFormModal({ open, onClose }) {
  if (!open) return null;
  return <InvoiceFormContent onClose={onClose} />;
}

function InvoiceFormContent({ onClose }) {
  const { t } = useI18n();
  const [customerId, setCustomerId] = useState('');
  const [total, setTotal] = useState('');
  const [discount, setDiscount] = useState('0');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const { data: customersData } = useCustomers({});
  const createInvoice = useCreateInvoice();
  const toast = useToast();
  const customers = customersData?.data || [];
  const selectedCustomer = customers.find((c) => String(c.id) === customerId);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!customerId || !total) { setError(t('fin.customer_and_invoice_total_are')); return; }
    try {
      const result = await createInvoice.mutateAsync({
        customer_id: parseInt(customerId, 10),
        invoice_total: parseFloat(total),
        discount_amount: parseFloat(discount) || 0,
        notes: notes || undefined,
      });
      toast.success(t('fin.m.created', undefined, { number: result.data.invoice_number }));
      onClose();
    } catch (err) {
      setError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      onClose={createInvoice.isPending ? () => {} : onClose}
      title={t('fin.create_invoice')}
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={createInvoice.isPending}>{t('common.cancel')}</Button>
        <Button type="submit" form="invoice-form" disabled={createInvoice.isPending}>{createInvoice.isPending ? t('common.saving') : t('fin.create_invoice')}</Button>
      </>}
    >
      <form id="invoice-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('fin.customer')}</span>
          <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); const c = customers.find((x) => String(x.id) === e.target.value); if (c?.fee != null) setTotal(String(c.fee)); }} style={inputStyle}>
            <option value="">{t('fin.select_a_customer_2')}</option>
            {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_number} — {c.business_name || c.name}</option>)}
          </select>
        </label>
        {selectedCustomer?.fee != null && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {t('fin.m.feePrefilled', undefined, { fee: selectedCustomer.fee })}
          </span>
        )}
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('fin.invoice_total')}</span>
          <input type="number" min="0" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('fin.discount_optional')}</span>
          <input type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} style={inputStyle} />
        </label>
        <label style={fieldStyle}>
          <span style={labelStyle}>{t('fin.notes_optional')}</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} style={inputStyle} />
        </label>
        {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
      </form>
    </Modal>
  );
}

const cellStyle = { padding: '12px 14px' };
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '4px' };
const labelStyle = { fontSize: '12px', fontWeight: 700 };
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
