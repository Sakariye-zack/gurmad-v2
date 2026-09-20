import React from 'react';
import { useMyAvatarUrl } from '../hooks/useAvatar.js';

// Personal profile photo — Phase 10, user-requested. Falls back to a
// colored initials bubble (never a broken-image icon) while loading, on
// 404 (no photo set yet), or on any fetch error — the same defensive
// fallback pattern CompanyLogo.jsx already established for the one
// company-wide logo, applied here to each user's own picture.
function initials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function Avatar({ name, size = 32, version = 0, style }) {
  const { url } = useMyAvatarUrl(version);
  const dim = `${size}px`;

  if (url) {
    return (
      <img
        src={url}
        alt={name || 'Profile photo'}
        width={size}
        height={size}
        style={{ width: dim, height: dim, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, ...style }}
      />
    );
  }
  return (
    <div
      style={{
        width: dim, height: dim, borderRadius: '50%', flexShrink: 0,
        background: 'var(--brand)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: `${Math.max(11, size * 0.4)}px`, fontWeight: 800, letterSpacing: '0.01em',
        ...style,
      }}
    >
      {initials(name)}
    </div>
  );
}
