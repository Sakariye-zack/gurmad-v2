import React from 'react';
import { Inbox } from 'lucide-react';

export default function EmptyState({ icon: Icon = Inbox, title, subtitle }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '48px 16px', textAlign: 'center', color: 'var(--text-muted)' }}>
      <Icon size={26} color="var(--border)" />
      <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text)' }}>{title}</div>
      {subtitle && <div style={{ fontSize: '13px' }}>{subtitle}</div>}
    </div>
  );
}
