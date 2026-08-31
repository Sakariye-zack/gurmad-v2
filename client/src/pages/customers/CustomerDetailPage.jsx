import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Users, Pencil, Hash, Archive, RotateCcw } from 'lucide-react';
import { PageHeader, Button, Card, StatusBadge, LoadingState, ErrorState, ConfirmDialog, useToast } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useCustomer, useUpdateCustomerStatus } from '../../hooks/useCustomers.js';
import CustomerFormModal from './CustomerFormModal.jsx';
import CustomerNumberEditModal from './CustomerNumberEditModal.jsx';

export default function CustomerDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useCustomer(id);
  const [editOpen, setEditOpen] = useState(false);
  const [numberEditOpen, setNumberEditOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const updateStatus = useUpdateCustomerStatus(id);
  const toast = useToast();
  const customer = data?.data;

  if (isLoading) return <LoadingState label="Loading customer…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!customer) return null;

  const isArchived = customer.status === 'archived';

  async function handleArchiveToggle() {
    try {
      await updateStatus.mutateAsync(isArchived ? 'active' : 'archived');
      toast.success(isArchived ? 'Customer restored to active.' : 'Customer archived.');
      setArchiveConfirmOpen(false);
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    }
  }

  return (
    <div>
      <button onClick={() => navigate('/customers')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Customers
      </button>

      <PageHeader
        icon={Users}
        title={customer.business_name || customer.name}
        subtitle={`${customer.customer_number} · ${customer.zone_name}`}
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <Button variant="secondary" icon={Hash} onClick={() => setNumberEditOpen(true)}>Edit Number</Button>
              <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>Edit Customer</Button>
              <Button
                variant={isArchived ? 'primary' : 'danger'}
                icon={isArchived ? RotateCcw : Archive}
                onClick={() => setArchiveConfirmOpen(true)}
              >
                {isArchived ? 'Restore' : 'Archive'}
              </Button>
            </div>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
        <Card style={cardPad}><Label>Customer Number</Label><Value className="tabular-nums">{customer.customer_number}</Value></Card>
        <Card style={cardPad}><Label>Type</Label><Value style={{ textTransform: 'capitalize' }}>{customer.customer_type}</Value></Card>
        <Card style={cardPad}><Label>Status</Label><div style={{ marginTop: '6px' }}><StatusBadge status={customer.status} /></div></Card>
        <Card style={cardPad}><Label>Zone</Label><Value>{customer.zone_name}{customer.sub_zone ? ` — ${customer.sub_zone}` : ''}</Value></Card>
        <Card style={cardPad}><Label>Phone</Label><Value className="tabular-nums">{customer.phone}</Value></Card>
        <Card style={cardPad}><Label>Alternate / WhatsApp</Label><Value>{customer.alternate_phone || customer.whatsapp || '—'}</Value></Card>
        <Card style={cardPad}><Label>Email</Label><Value>{customer.email || '—'}</Value></Card>
        <Card style={cardPad}><Label>Address</Label><Value>{customer.address_line || '—'}</Value></Card>
        {customer.customer_type === 'commercial' && (
          <Card style={cardPad}><Label>Commercial shift</Label><Value style={{ textTransform: 'capitalize' }}>{customer.commercial_shift || 'Not set'}</Value></Card>
        )}
        <Card style={cardPad}><Label>Collection</Label><Value>{customer.collection_frequency || '—'} {customer.collection_mode ? `(${customer.collection_mode})` : ''}</Value></Card>
        <Card style={cardPad}><Label>Fee</Label><Value className="tabular-nums">{customer.fee != null ? customer.fee : '—'}</Value></Card>
      </div>

      {customer.notes && (
        <Card style={{ ...cardPad, marginTop: '16px' }}>
          <Label>Notes</Label>
          <p style={{ margin: '6px 0 0', fontSize: '13px', whiteSpace: 'pre-wrap' }}>{customer.notes}</p>
        </Card>
      )}

      <Card style={{ ...cardPad, marginTop: '16px' }}>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>
          Billing, debts, collection history, and task activity for this customer will appear here
          once their respective modules are implemented, per the approved one-module-at-a-time sequence.
        </p>
      </Card>

      <CustomerFormModal open={editOpen} onClose={() => setEditOpen(false)} customer={customer} />
      {numberEditOpen && <CustomerNumberEditModal open={numberEditOpen} onClose={() => setNumberEditOpen(false)} customer={customer} />}
      <ConfirmDialog
        open={archiveConfirmOpen}
        onClose={() => setArchiveConfirmOpen(false)}
        onConfirm={handleArchiveToggle}
        title={isArchived ? 'Restore this customer?' : 'Archive this customer?'}
        message={isArchived
          ? `${customer.name} will become active again and reappear in the default customer list.`
          : `${customer.name} will be hidden from the default customer list. All history and relationships (invoices, debts, tasks) remain intact — this does not delete anything.`}
        confirmLabel={isArchived ? 'Restore' : 'Archive'}
        danger={!isArchived}
        isLoading={updateStatus.isPending}
      />
    </div>
  );
}

function Label({ children }) {
  return <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>{children}</span>;
}
function Value({ children, style, className }) {
  return <div className={className} style={{ marginTop: '6px', fontSize: '15px', fontWeight: 700, ...style }}>{children}</div>;
}

const cardPad = { padding: '16px' };
const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
