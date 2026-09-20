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

// Zone Detail — user-requested gap-audit ('maxaa ka dhiman imika
// mashruucaygan'): this page's own placeholder said 'Customers,
// employees, collectors, and trucks assigned to this zone will appear
// here once their respective modules are implemented' — all three
// modules (and their zone_id-filtered hooks) have existed since well
// before this pass; nobody ever came back to replace the placeholder,
// the exact same class of stale-placeholder gap already fixed on
// EmployeeDetailPage.jsx earlier this phase.
export default function ZoneDetailPage() {
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

  if (isLoading) return <LoadingState label="Loading zone…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;
  if (!zone) return null;

  return (
    <div>
      <button onClick={() => navigate('/zones')} style={backLinkStyle}>
        <ArrowLeft size={14} /> Back to Zones
      </button>

      <PageHeader
        icon={MapPinned}
        title={zone.name}
        subtitle={zone.zone_code}
        actions={
          <RoleGate roles={['admin']}>
            <Button variant="secondary" icon={Pencil} onClick={() => setEditOpen(true)}>Edit Zone</Button>
          </RoleGate>
        }
      />

      <DetailGrid items={[
        { label: 'Status', value: <StatusBadge status={zone.status} /> },
        { label: 'Sub-zone', value: zone.sub_zone || '—' },
        { label: 'Area', value: zone.area || '—' },
        { label: 'Collection days', value: (zone.collection_days || []).join(', ') || '—' },
      ]} />

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <SectionLabel icon={Users}>Customers ({customers.length})</SectionLabel>
        {customers.length === 0 && <p style={emptyStyle}>No customers in this zone yet.</p>}
        {customers.slice(0, 8).map((c) => (
          <ZoneRow key={c.id} onClick={() => navigate(`/customers/${c.id}`)} title={c.business_name || c.name} subtitle={c.customer_number} />
        ))}
        {customers.length > 8 && <p style={moreStyle}>+ {customers.length - 8} more — see the full Customers list.</p>}
      </Card>

      <RoleGate roles={['admin', 'gudoomiye', 'zone_accountant']}>
        <Card style={{ padding: '16px', marginTop: '16px' }}>
          <SectionLabel icon={Users2}>Employees ({employees.length})</SectionLabel>
          {employees.length === 0 && <p style={emptyStyle}>No employees assigned to this zone yet.</p>}
          {employees.slice(0, 8).map((e) => (
            <ZoneRow key={e.id} onClick={() => navigate(`/employees/${e.id}`)} title={e.name} subtitle={e.job_role || e.employee_type} />
          ))}
          {employees.length > 8 && <p style={moreStyle}>+ {employees.length - 8} more — see the full Employees list.</p>}
        </Card>
      </RoleGate>

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <SectionLabel icon={Truck}>Trucks ({trucks.length})</SectionLabel>
        {trucks.length === 0 && <p style={emptyStyle}>No trucks assigned to this zone yet.</p>}
        {trucks.slice(0, 8).map((t) => (
          <ZoneRow key={t.id} onClick={() => navigate(`/trucks/${t.id}`)} title={t.plate_number} subtitle={t.model || t.status} />
        ))}
        {trucks.length > 8 && <p style={moreStyle}>+ {trucks.length - 8} more — see the full Trucks list.</p>}
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
