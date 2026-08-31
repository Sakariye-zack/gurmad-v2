import React from 'react';
import { Loader2 } from 'lucide-react';

export default function LoadingState({ label = 'Loading…' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '48px 16px', color: 'var(--text-muted)' }}>
      <Loader2 size={24} className="spin" style={{ animation: 'v2-spin 0.9s linear infinite' }} />
      <div style={{ fontSize: '13px', fontWeight: 600 }}>{label}</div>
      <style>{'@keyframes v2-spin { to { transform: rotate(360deg); } }'}</style>
    </div>
  );
}
