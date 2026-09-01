import React from 'react';
import Card from './Card.jsx';

// A single cohesive info panel — replaces the "many small boxed StatCards
// for plain label/value fields" pattern. One Card, a responsive two-column
// grid of label/value rows separated by hairlines, not six disconnected
// bordered-and-shadowed boxes for what is really one record's details.
// Design_System.md's StatCard stays reserved for actual counts/metrics
// (Dashboard, List-page StatCards) — this is for a single record's fields.
export default function DetailGrid({ items }) {
  return (
    <Card style={{ padding: '4px 20px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', columnGap: '24px' }}>
        {items.filter(Boolean).map((item) => (
          <div
            key={item.label}
            style={{ padding: '14px 0', borderBottom: '1px solid var(--border)' }}
          >
            <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>
              {item.label}
            </span>
            <div style={{ marginTop: '6px', fontSize: '15px', fontWeight: 700 }} className={item.className}>
              {item.value}
            </div>
            {item.hint && <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>{item.hint}</div>}
          </div>
        ))}
      </div>
    </Card>
  );
}
