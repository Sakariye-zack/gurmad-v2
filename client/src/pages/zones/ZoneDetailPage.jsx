import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MapPinned, Pencil, Users, Users2, Truck } from 'lucide-react';
import { PageHeader, Button, Card, DetailGrid, StatusBadge, LoadingState, ErrorState } from '../../components/ui/index.js';
import RoleGate from '../../components/RoleGate.jsx';
import { useZone } from '../../hooks/useZones.js';
import { useCustomers } from '../../hooks/useCustomers.js';
import { useEmployees } from '../../hooks/useEmployees.js';
import { useTrucks } from '../../hooks/useTrucks.js';
import ZoneFormModal from './ZoneFormModal.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';

// Zone Detail — user-requested gap-audit ('maxaa ka dhiman imika
// mashruucaygan'): this page's own placeholder said 'Customers,
// employees, collectors, and trucks assigned to this zone will appear
// here once their respective modules are implemented' — all three
// modules (and their zone_id-filtered hooks) have existed since well
// before this pass; nobody ever came back to replace the placeholder,
// the exact same class of stale-placeholder gap already fixed on
// EmployeeDetailPage.jsx earlier this phase.
export default function ZoneDetailPage() {
  const { t } = useI18n();
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useZone(id);
  const [editOpen, setEditOpen] = useState(false);
  const zone = data?.data;
  const { data: customersData } = useCustomers({ zone_id: id });
  const { data: employeesData } = useEmployees({ zone_id: id });
  const { data: trucksData } = useTrucks({ zone_id: id });
  const customers = customersData?.data || [];
  const employees = employeesData?.data || [];
  const trucks = trucksData?.data || [];

  if (isLoading) return <LoadingState label={t('zone.loading_zone')} />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!zone) return null;

  return (
    <div>
      <button onClick={() => navigate('/zones')} style={backLinkStyle}>
        <ArrowLeft size={14} /> {t('zone.back_to_zones')}
      </button>

      <PageHeader
        icon={MapPinned}
        title={zone.name}
        subtitle={zone.zone_code}
        actions={
          <RoleGate roles={['admin']}>
            <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>{t('zone.edit_zone')}</Button>
          </RoleGate>
        }
      />

      <DetailGrid items={[
        { label: t('common.status'), value: <StatusBadge status={zone.status} /> },
        { label: t('zone.sub_zone'), value: zone.sub_zone || '—' },
        { label: t('zone.area'), value: zone.area || '—' },
        { label: t('zone.collection_days'), value: (zone.collection_days || []).join(', ') || '—' },
      ]} />

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <SectionLabel icon={Users}>{t('zone.m.customersN', undefined, { n: customers.length })}</SectionLabel>
        {customers.length === 0 && <p style={emptyStyle}>{t('zone.no_customers_in_this_zone')}</p>}
        {customers.slice(0, 8).map((c) => (
          <ZoneRow key={c.id} onClick={() => navigate(`/customers/${c.id}`)} title={c.business_name || c.name} subtitle={c.customer_number} />
        ))}
        {customers.length > 8 && <p style={moreStyle}>{t('zone.m.moreCustomers', undefined, { n: customers.length - 8 })}</p>}
      </Card>

      <RoleGate roles={['admin', 'gudoomiye', 'zone_accountant']}>
        <Card style={{ padding: '16px', marginTop: '16px' }}>
          <SectionLabel icon={Users2}>{t('zone.m.employeesN', undefined, { n: employees.length })}</SectionLabel>
          {employees.length === 0 && <p style={emptyStyle}>{t('zone.no_employees_assigned_to_this')}</p>}
          {employees.slice(0, 8).map((e) => (
            <ZoneRow key={e.id} onClick={() => navigate(`/employees/${e.id}`)} title={e.name} subtitle={e.job_role || e.employee_type} />
          ))}
          {employees.length > 8 && <p style={moreStyle}>{t('zone.m.moreEmployees', undefined, { n: employees.length - 8 })}</p>}
        </Card>
      </RoleGate>

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <SectionLabel icon={Truck}>{t('zone.m.trucksN', undefined, { n: trucks.length })}</SectionLabel>
        {trucks.length === 0 && <p style={emptyStyle}>{t('zone.no_trucks_assigned_to_this')}</p>}
        {trucks.slice(0, 8).map((t) => (
          <ZoneRow key={t.id} onClick={() => navigate(`/trucks/${t.id}`)} title={t.plate_number} subtitle={t.model || t.status} />
        ))}
        {trucks.length > 8 && <p style={moreStyle}>{t('zone.m.moreTrucks', undefined, { n: trucks.length - 8 })}</p>}
      </Card>

      <ZoneFormModal open={editOpen} onClose={() => setEditOpen(false)} zone={zone} />
    </div>
  );
}

function SectionLabel({ icon: Icon, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)', marginBottom: '8px' }}>
      <Icon size={13} /> {children}
    </div>
  );
}
function ZoneRow({ title, subtitle, onClick }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '13px', cursor: 'pointer' }}>
      <span>{title}</span>
      <span style={{ color: 'var(--text-muted)' }}>{subtitle}</span>
    </div>
  );
}
const emptyStyle = { margin: 0, fontSize: '13px', color: 'var(--text-muted)' };
const moreStyle = { margin: '8px 0 0', fontSize: '12px', color: 'var(--text-muted)' };
const backLinkStyle = {
  display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none',
  color: 'var(--text-muted)', fontWeight: 700, fontSize: '12px', cursor: 'pointer', padding: 0, marginBottom: '16px',
};
