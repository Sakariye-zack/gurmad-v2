import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Plus } from 'lucide-react';
import { PageHeader, Button, DataTable, StatusBadge, FilterBar } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useCustomers } from '../../hooks/useCustomers.js';
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
          { label: t('common.zone') }, { label: t('common.status') },
        ]}
      >
        {customers.map((c) => (
          <tr key={c.id} onClick={() => navigate(`/customers/${c.id}`)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
            <td style={cellStyle}><strong className="tabular-nums">{c.customer_number}</strong></td>
            <td style={cellStyle}>{c.business_name || c.name}</td>
            <td style={cellStyle}><span style={{ textTransform: 'capitalize' }}>{t('cust.' + c.customer_type, c.customer_type)}</span></td>
            <td style={cellStyle} className="tabular-nums">{c.phone}</td>
            <td style={cellStyle}>{c.zone_name}</td>
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
