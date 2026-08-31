import React from 'react';

// PageHeader: icon + title + subtitle + one optional single primary action.
// Design_System.md §1 rule 1: "One primary action per page" — this component
// only accepts one `actions` node, not an array, so a page can't accidentally
// stack three competing CTAs into the header the way a couple of current-
// system pages did.
export default function PageHeader({ icon: Icon, title, subtitle, actions }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px', marginBottom: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        {Icon && (
          <div style={{ width: '44px', height: '44px', borderRadius: 'var(--radius-md)', background: 'var(--success-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <Icon size={22} color="var(--brand)" />
          </div>
        )}
        <div>
          <h1>{title}</h1>
          {subtitle && <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: '13px' }}>{subtitle}</p>}
        </div>
      </div>
      {actions}
    </div>
  );
}
