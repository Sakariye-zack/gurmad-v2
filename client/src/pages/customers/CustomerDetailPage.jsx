import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Users, Pencil, Hash, Archive, RotateCcw, Receipt, HandCoins, History } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState, ConfirmDialog, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useCustomer, useUpdateCustomerStatus, useCustomerCollectionHistory } from '../../hooks/useCustomers.js';
import { useInvoices, useDebts } from '../../hooks/useFinancial.js';
import CustomerFormModal from './CustomerFormModal.jsx';
import CustomerNumberEditModal from './CustomerNumberEditModal.jsx';
import CustomerPortalAccessCard from './CustomerPortalAccessCard.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';

// P1 Functional Gaps — Customer Detail: Invoices, Debts, Collection
// History only (no Cashout, no Payments aggregate, no Outstanding
// Balance total — none is defined by an approved financial source at
// the customer level; out of scope per the Master Authorization).
// Each section is gated by its own domain's existing VIEW_ROLES via
// RoleGate — this is presentation only, the server-side requireRole on
// each endpoint remains the actual authorization boundary.
const INVOICE_VIEW_ROLES = ['admin', 'cashier', 'gudoomiye', 'zone_accountant'];
const DEBT_VIEW_ROLES = ['admin', 'cashier', 'gudoomiye', 'zone_accountant', 'head_of_cashiers'];
const COLLECTION_HISTORY_VIEW_ROLES = ['admin', 'gudoomiye', 'zone_accountant'];

export default function CustomerDetailPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useCustomer(id);
  const [editOpen, setEditOpen] = useState(false);
  const [numberEditOpen, setNumberEditOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const updateStatus = useUpdateCustomerStatus(id);
  const toast = useToast();
  const customer = data?.data;

  if (isLoading) return <LoadingState label={t('cust.loading_customer')} />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!customer) return null;

  const isArchived = customer.status === 'archived';

  async function handleArchiveToggle() {
    try {
      await updateStatus.mutateAsync(isArchived ? 'active' : 'archived');
      toast.success(isArchived ? t('cust.customer_restored_to_active') : t('cust.customer_archived'));
      setArchiveConfirmOpen(false);
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <div>
      <button onClick={() => navigate('/customers')} style={backLinkStyle}>
        <ArrowLeft size={14} /> {t('cust.back_to_customers')}
      </button>

      <PageHeader
        icon={Users}
        title={customer.business_name || customer.name}
        subtitle={`${customer.customer_number} · ${customer.zone_name}`}
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <Button variant="secondary" icon={Hash} onClick={() => setNumberEditOpen(true)}>{t('cust.edit_number')}</Button>
              <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>{t('cust.edit_customer')}</Button>
              <Button
                variant={isArchived ? 'primary' : 'danger'}
                icon={isArchived ? RotateCcw : Archive}
                onClick={() => setArchiveConfirmOpen(true)}
              >
                {isArchived ? t('cust.restore') : t('cust.archive')}
              </Button>
            </div>
          </RoleGate>
        }
      />

      <DetailGrid items={[
        { label: t('portal.account.customerNumber'), value: customer.customer_number, className: 'tabular-nums' },
        { label: t('common.status'), value: <StatusBadge status={customer.status} /> },
        { label: t('cust.type'), value: <span style={{ textTransform: 'capitalize' }}>{t('cust.' + customer.customer_type, customer.customer_type)}</span> },
        { label: t('common.zone'), value: `${customer.zone_name}${customer.sub_zone ? ` — ${customer.sub_zone}` : ''}` },
        { label: t('common.phone'), value: customer.phone, className: 'tabular-nums' },
        { label: t('cust.alternate_whatsapp'), value: customer.alternate_phone || customer.whatsapp || '—' },
        { label: t('cust.email'), value: customer.email || '—' },
        { label: t('common.address'), value: customer.address_line || '—' },
        customer.customer_type === 'commercial' && { label: t('cust.commercial_shift'), value: <span style={{ textTransform: 'capitalize' }}>{customer.commercial_shift || t('cust.not_set')}</span> },
        { label: t('portal.account.collection'), value: `${customer.collection_frequency || '—'}${customer.collection_mode ? ` (${customer.collection_mode})` : ''}` },
        { label: t('cust.fee'), value: customer.fee != null ? customer.fee : '—', className: 'tabular-nums' },
      ]} />

      {customer.notes && (
        <Card style={{ ...cardPad, marginTop: '16px' }}>
          <Label>{t('cust.notes')}</Label>
          <p style={{ margin: '6px 0 0', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{customer.notes}</p>
        </Card>
      )}

      <RoleGate roles={INVOICE_VIEW_ROLES}>
        <CustomerInvoicesSection customerId={customer.id} navigate={navigate} />
      </RoleGate>
      <RoleGate roles={DEBT_VIEW_ROLES}>
        <CustomerDebtsSection customerId={customer.id} />
      </RoleGate>
      <RoleGate roles={COLLECTION_HISTORY_VIEW_ROLES}>
        <CustomerCollectionHistorySection customerId={customer.id} />
      </RoleGate>

      <CustomerPortalAccessCard customerId={customer.id} />

      <CustomerFormModal open={editOpen} onClose={() => setEditOpen(false)} customer={customer} />
      {numberEditOpen && <CustomerNumberEditModal open={numberEditOpen} onClose={() => setNumberEditOpen(false)} customer={customer} />}
      <ConfirmDialog
        open={archiveConfirmOpen}
        onClose={() => setArchiveConfirmOpen(false)}
        onConfirm={handleArchiveToggle}
        title={isArchived ? t('cust.restore_this_customer') : t('cust.archive_this_customer')}
        message={isArchived
          ? t('cust.m.restoreBody', undefined, { name: customer.name })
          : t('cust.m.archiveBody', undefined, { name: customer.name })}
        confirmLabel={isArchived ? t('cust.restore') : t('cust.archive')}
        danger={!isArchived}
        isLoading={updateStatus.isPending}
      />
    </div>
  );
}

function CustomerInvoicesSection({ customerId, navigate }) {
  const { t } = useI18n();
  const { data, isLoading, error } = useInvoices({ customer_id: customerId });
  const invoices = data?.data || [];
  return (
    <Card style={{ ...cardPad, marginTop: '16px' }}>
      <SectionHeader icon={Receipt} title={t('portal.nav.invoices')} />
      {isLoading && <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>{t('common.loading')}</p>}
      {error && <p style={{ margin: 0, fontSize: '13px', color: 'var(--danger)' }}>{error.message}</p>}
      {!isLoading && !error && invoices.length === 0 && (
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>{t('cust.no_invoices_for_this_customer')}</p>
      )}
      {!isLoading && !error && invoices.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {invoices.map((inv) => (
            <RowLink key={inv.id} onClick={() => navigate(`/financial/invoices/${inv.id}`)}>
              <strong>{inv.invoice_number}</strong>
              <span className="tabular-nums">{inv.currency} {parseFloat(inv.invoice_total).toFixed(2)}</span>
              <StatusBadge status={inv.status} map={{ unpaid: 'danger', partial: 'warning', paid: 'success', voided: 'info' }} />
            </RowLink>
          ))}
        </div>
      )}
    </Card>
  );
}

function CustomerDebtsSection({ customerId }) {
  const { t } = useI18n();
  const { data, isLoading, error } = useDebts({ customer_id: customerId });
  const debts = data?.data || [];
  return (
    <Card style={{ ...cardPad, marginTop: '16px' }}>
      <SectionHeader icon={HandCoins} title={t('nav.debts')} />
      {isLoading && <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>{t('common.loading')}</p>}
      {error && <p style={{ margin: 0, fontSize: '13px', color: 'var(--danger)' }}>{error.message}</p>}
      {!isLoading && !error && debts.length === 0 && (
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>{t('cust.no_debts_for_this_customer')}</p>
      )}
      {!isLoading && !error && debts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {debts.map((d) => (
            <RowLink key={d.id}>
              <span className="tabular-nums">{d.currency} {parseFloat(d.amount).toFixed(2)}</span>
              <span>{d.invoice_id ? t('cust.m.linkedTo', undefined, { id: d.invoice_id }) : t('cust.standalone')}</span>
              <StatusBadge status={d.status} map={{ unpaid: 'danger', paid: 'success' }} />
            </RowLink>
          ))}
        </div>
      )}
    </Card>
  );
}

function CustomerCollectionHistorySection({ customerId }) {
  const { t } = useI18n();
  const { data, isLoading, error } = useCustomerCollectionHistory(customerId);
  const rows = data?.data || [];
  return (
    <Card style={{ ...cardPad, marginTop: '16px' }}>
      <SectionHeader icon={History} title={t('portal.collections.title')} />
      {isLoading && <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>{t('common.loading')}</p>}
      {error && <p style={{ margin: 0, fontSize: '13px', color: 'var(--danger)' }}>{error.message}</p>}
      {!isLoading && !error && rows.length === 0 && (
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>{t('cust.no_collection_events_recorded_for')}</p>
      )}
      {!isLoading && !error && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {rows.map((r) => (
            <RowLink key={r.id}>
              <span>{r.status_at ? new Date(r.status_at).toLocaleDateString() : '—'}</span>
              <span style={{ color: 'var(--text-muted)' }}>{r.batch_code}</span>
              <StatusBadge status={r.status} />
            </RowLink>
          ))}
        </div>
      )}
    </Card>
  );
}

function SectionHeader({ icon: Icon, title }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
      <Icon size={16} style={{ color: 'var(--text-muted)' }} />
      <span style={{ fontSize: '13px', fontWeight: 800 }}>{title}</span>
    </div>
  );
}

function RowLink({ children, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
        padding: '8px 4px', borderBottom: '1px solid var(--border)', fontSize: '13px',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      {children}
    </div>
  );
}

function Label({ children }) {
  return <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{children}</span>;
}

const cardPad = { padding: '16px' };
const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
