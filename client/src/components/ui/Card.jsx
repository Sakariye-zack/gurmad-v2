import React from 'react';

export default function Card({ children, style, ...rest }) {
  return (
    <div
      style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)',
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
