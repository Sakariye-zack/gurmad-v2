import React from 'react';
import { Search } from 'lucide-react';

export default function FilterBar({ searchValue, onSearchChange, searchPlaceholder = 'Search…', children }) {
  return (
    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '14px' }}>
      <div style={{ position: 'relative', flex: '1 1 220px', minWidth: '180px' }}>
        <Search size={15} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
        <input
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          style={{
            width: '100%', padding: '9px 12px 9px 32px', borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', boxSizing: 'border-box',
          }}
        />
      </div>
      {children}
    </div>
  );
}
