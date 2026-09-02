import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import PortalCard from './PortalCard.jsx';

// A positive/attention-adjacent banner (e.g. "you're all caught up") — not
// the same as EmptyState (which is for "no records at all"). Used by
// PortalDashboard's attention card when there is nothing to flag.
export default function PortalEmptyBanner({ title, subtitle, icon: Icon = CheckCircle2 }) {
  return (
    <PortalCard style={{ display: 'flex', alignItems: 'center', gap: '12px', borderLeft: '3px solid var(--brand)' }}>
      <Icon size={22} color="var(--brand)" />
      <div>
        <div style={{ fontWeight: 800, fontSize: '14px' }}>{title}</div>
        {subtitle && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '2px' }}>{subtitle}</div>}
      </div>
    </PortalCard>
  );
}
