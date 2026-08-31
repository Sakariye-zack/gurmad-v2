import React from 'react';
import { LayoutDashboard, Users, ClipboardList, Wallet, Plus } from 'lucide-react';
import { PageHeader, StatCard, Button } from '../components/ui/index.js';
import RoleGate from '../components/RoleGate.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import { useCurrentZone } from '../hooks/useCurrentZone.js';

// Foundation-phase placeholder — proves the shell, RoleGate, and zone-scope
// hook work end-to-end. No real business data; a business module (per the
// approved sequence) builds the real Dashboard content next.
export default function Dashboard() {
  const { user } = useAuth();
  const { zone, isZoneScoped } = useCurrentZone();

  return (
    <div>
      <PageHeader
        icon={LayoutDashboard}
        title="Dashboard"
        subtitle={isZoneScoped ? `Zone-scoped view — ${zone}` : 'All-zone view'}
        actions={
          <RoleGate roles={['admin']}>
            <Button icon={Plus}>Manage Zones</Button>
          </RoleGate>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <StatCard label="Active Batches" value="—" icon={ClipboardList} />
        <StatCard label="Customers" value="—" icon={Users} accent="var(--info)" />
        <StatCard label="Today's Collections" value="—" icon={Wallet} accent="var(--warning)" />
      </div>

      <div style={{ padding: '16px', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)', color: 'var(--text-muted)', fontSize: '13px' }}>
        This is the V2 Foundation placeholder — real Dashboard content is built in a later module phase, per the approved development sequence.
        <br /><br />
        Logged in as <strong>{user?.full_name || user?.username}</strong> ({user?.role}
        {user?.zone ? `, zone: ${user.zone}` : ''}).
        <br /><br />
        <RoleGate roles={['admin', 'cashier']} fallback={<em>Record Payment is hidden for your role (RoleGate: admin/cashier only).</em>}>
          <Button variant="secondary" icon={Wallet}>Record Payment (visible to Admin/Cashier)</Button>
        </RoleGate>
      </div>
    </div>
  );
}
