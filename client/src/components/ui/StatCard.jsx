import React from 'react';
import Card from './Card.jsx';

export default function StatCard({ label, value, sub, icon: Icon, accent = 'var(--brand)', onClick }) {
  return (
    <Card
      onClick={onClick}
      style={{
        padding: '20px', cursor: onClick ? 'pointer' : 'default',
        borderLeft: `3px solid ${accent}`,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</div>
          <div className="tabular-nums" style={{ fontSize: '26px', fontWeight: 800, marginTop: '6px' }}>{value}</div>
          {sub && <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>{sub}</div>}
        </div>
        {Icon && <Icon size={20} color={accent} style={{ flexShrink: 0 }} />}
      </div>
    </Card>
  );
}
