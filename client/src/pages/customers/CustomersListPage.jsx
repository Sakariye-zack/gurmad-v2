import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar, Card } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useCustomers, useNumberRequests } from '../../hooks/useCustomers.js';
import CustomerFormModal from './CustomerFormModal.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';

export default function CustomersListPage() {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active'); // active | archived | all — OD-1: hidden by default
  const [typeFilter, setTypeFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useCustomers({
    q: search || undefined,
    status: statusFilter === 'active' ? undefined : statusFilter,
    customer_type: typeFilter || undefined,
  });
  const customers = data?.data || [];
  const { user } = useAuth();
  const canSeeRequests = ['admin', 'gudoomiye'].includes((user?.role || '').toLowerCase());
  const { data: reqData } = useNumberRequests({ enabled: canSeeRequests });
  const pendingRequests = reqData?.data || [];

  return (
    <div>
      <PageHeader
        icon={Users}
        title={t('nav.customers')}
        subtitle={t('cust.residential_and_commercial_customers')}
        actions={
          <RoleGate roles={['admin', 'gudoomiye']}>
            <Button icon={Plus} onClick={() => setFormOpen(true)}>{t('cust.create_customer')}</Button>
          </RoleGate>
        }
      />

      {pendingRequests.length > 0 && (
        <Card style={{ padding: '12px 16px', marginBottom: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '6px' }}>{t('cust.m.pendingChanges')} ({pendingRequests.length})</div>
          {pendingRequests.map((r) => (
            <div key={r.id} style={{ fontSize: '13px', padding: '2px 0' }} className="tabular-nums">
              <a href={'/customers/' + r.customer_id} onClick={(e) => { e.preventDefault(); navigate('/customers/' + r.customer_id); }}>{r.customer_name}</a>
              {' — '}{r.old_number} → {r.new_number}
            </div>
          ))}
        </Card>
      )}

      <FilterBar searchValue={search} onSearchChange={setSearch} searchPlaceholder={t('cust.search_by_customer_number_name')}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={selectStyle}>
          <option value="active">{t('status.active')}</option>
          <option value="archived">{t('status.archived')}</option>
          <option value="all">{t('cust.all_statuses')}</option>
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={selectStyle}>
          <option value="">{t('cust.all_types')}</option>
          <option value="residential">{t('cust.residential')}</option>
          <option value="commercial">{t('cust.commercial')}</option>
        </select>
      </FilterBar>

      <DataTable
        loading={isLoading}
        error={error?.message}
        onRetry={refetch}
        isEmpty={!isLoading && !error && customers.length === 0}
        emptyTitle={search ? t('cust.no_customers_match_your_search') : t('cust.no_customers_yet')}
        emptySubtitle={search ? t('cust.try_a_different_name_phone') : t('cust.create_the_first_customer_to')}
        columns={[
          { label: t('cust.customer') }, { label: t('common.name') }, { label: t('cust.type') }, { label: t('common.phone') },
          { label: t('common.zone') }, { label: t('cust.door_col', 'Door #') }, { label: t('common.status') },
        ]}
      >
        {customers.map((c) => (
          <tr key={c.id} onClick={() => navigate(`/customers/${c.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong className="tabular-nums">{c.customer_number}</strong></td>
            <td style={cellStyle}>{c.business_name || c.name}</td>
            <td style={cellStyle}><span style={{ textTransform: 'capitalize' }}>{t('cust.' + c.customer_type, c.customer_type)}</span></td>
            <td style={cellStyle} className="tabular-nums">{c.phone}</td>
            <td style={cellStyle}>{c.zone_name}</td>
            <td style={cellStyle} className="tabular-nums">{c.door_number || '—'}</td>
            <td style={cellStyle}><StatusBadge status={c.status} /></td>
          </tr>
        ))}
      </DataTable>

      <CustomerFormModal open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}

const cellStyle = { padding: '12px 14px' };
const selectStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '13px',
};
