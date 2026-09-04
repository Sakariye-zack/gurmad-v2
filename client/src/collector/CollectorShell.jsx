import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { ClipboardList, RefreshCw, ShieldAlert } from 'lucide-react';
import { useSyncQueueContext } from './SyncQueueContext.jsx';

// Field Collector Mobile — Implementation Spec §6/§24. A lightweight,
// mobile-first shell distinct from the desktop staff AppShell (large touch
// targets, one-handed bottom-nav reach, per Discovery §13's field-usability
// findings) — not a redesign of the existing desktop design system, which
// this shell still consumes via components/ui/* throughout every screen.
export default function CollectorShell() {
  const { activeCount } = useSyncQueueContext();
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <main style={{ flex: 1, padding: '16px', paddingBottom: '84px', maxWidth: '520px', margin: '0 auto', width: '100%' }}>
        <Outlet />
      </main>
      <nav style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, background: 'var(--surface)',
        borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-around',
        padding: '8px 0 max(8px, env(safe-area-inset-bottom))', zIndex: 50,
      }}>
        <NavTab to="/collector" icon={ClipboardList} label="Assignments" end />
        <NavTab to="/collector/sync" icon={RefreshCw} label="Sync" badge={activeCount} />
        <NavTab to="/collector/account" icon={ShieldAlert} label="Account" />
      </nav>
    </div>
  );
}

function NavTab({ to, icon: Icon, label, end, badge }) {
  return (
    <NavLink to={to} end={end} style={({ isActive }) => ({
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
      padding: '8px 20px', minWidth: '64px', minHeight: '44px', textDecoration: 'none',
      color: isActive ? 'var(--brand)' : 'var(--text-muted)', fontWeight: 700, fontSize: '11px', position: 'relative',
    })}>
      <div style={{ position: 'relative' }}>
        <Icon size={22} />
        {badge > 0 && (
          <span style={{
            position: 'absolute', top: '-6px', right: '-8px', background: 'var(--danger)', color: '#fff',
            borderRadius: '10px', fontSize: '10px', fontWeight: 800, minWidth: '16px', height: '16px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px',
          }}>{badge}</span>
        )}
      </div>
      {label}
    </NavLink>
  );
}
