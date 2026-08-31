import React from 'react';

const VARIANTS = {
  primary: { background: 'var(--brand)', color: '#fff', border: 'none' },
  secondary: { background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)' },
  danger: { background: 'var(--danger)', color: '#fff', border: 'none' },
  ghost: { background: 'transparent', color: 'var(--text-muted)', border: 'none' },
};

// The one Button every V2 page uses — no page hand-rolls its own button
// styling. Per Design_System.md §5: a destructive/financial submit is never
// the default-focused element in a form context (callers control that via
// autoFocus placement, not this component).
export default function Button({ variant = 'primary', icon: Icon, children, disabled, style, ...rest }) {
  const v = VARIANTS[variant] || VARIANTS.primary;
  return (
    <button
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
        padding: '10px 16px', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '14px',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
        transition: 'transform 0.1s ease, opacity 0.1s ease',
        ...v, ...style,
      }}
      {...rest}
    >
      {Icon && <Icon size={16} />}
      {children}
    </button>
  );
}
