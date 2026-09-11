import React from 'react';

// Shared visual kit for the three login screens (staff Login.jsx, Customer
// Portal PortalLogin.jsx, Collector LoginScreen.jsx) — factored out so the
// "fleet dispatch manifest" identity (hazard tape, isometric truck, route
// motif, monospace manifest labels, embossed medallion) is defined once
// and stays visually consistent across all three, not hand-copied three
// times. Built entirely from the app's own --brand/--accent/--bg palette
// (design-system/tokens.css); the two Google Fonts (Oswald, JetBrains
// Mono) are loaded once in index.html.
export const DISPLAY_FONT = "'Oswald', ui-sans-serif, sans-serif";
export const MONO_FONT = "'JetBrains Mono', ui-monospace, monospace";

export const hazardTape = 'repeating-linear-gradient(-45deg, var(--brand) 0 14px, var(--accent) 14px 28px)';

export const dispatchFieldLabelStyle = {
  display: 'block',
  fontFamily: MONO_FONT,
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '0.12em',
  color: 'var(--text-muted)',
  marginBottom: '8px',
};

export const dispatchInputStyle = {
  width: '100%',
  padding: '13px 14px',
  borderRadius: '4px',
  // Longhand, not shorthand `border` — a focus-state override that only
  // touches borderColor mixed with shorthand `border` is a real React
  // style-diffing warning, not just noise (found + fixed in the staff
  // Login page first).
  borderWidth: '2px',
  borderStyle: 'solid',
  borderColor: 'var(--border)',
  background: 'var(--bg)',
  color: 'var(--text)',
  boxSizing: 'border-box',
  fontFamily: MONO_FONT,
  fontSize: '14px',
  transition: 'border-color 0.12s ease, box-shadow 0.12s ease',
};

export function dispatchFocusRing(active) {
  return active ? { borderColor: 'var(--brand)', boxShadow: '0 0 0 4px color-mix(in srgb, var(--brand) 22%, transparent)' } : {};
}

// Isometric collection truck — per-facet gradients/shading fake real
// depth without a 3D engine. Corrugated hopper ribs, a riveted manifest
// plate, a hazard-stripe corner, a cab with door seam/mirror/headlamp/
// grille, an exhaust stack, mudflaps, and trig-computed 5-spoke wheel
// hubs. Not a stock icon.
export function IsoTruck({ style }) {
  return (
    <svg viewBox="0 0 340 220" width="100%" height="100%" style={style} aria-hidden="true">
      <defs>
        <linearGradient id="hopperTop" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--brand)" />
          <stop offset="1" stopColor="var(--brand-dark)" />
        </linearGradient>
        <linearGradient id="hopperSide" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--brand-dark)" />
          <stop offset="1" stopColor="#000" stopOpacity="0.18" />
        </linearGradient>
        <radialGradient id="headlamp" cx="0.5" cy="0.5" r="0.6">
          <stop offset="0" stopColor="#fff6d8" />
          <stop offset="1" stopColor="#e8c96a" />
        </radialGradient>
      </defs>

      <ellipse cx="175" cy="206" rx="150" ry="11" fill="#000" opacity="0.3" />
      <path d="M50 172 L60 168 L60 186 L50 190 Z" fill="var(--text-muted)" opacity="0.5" />

      <path d="M56 66 L182 34 L182 152 L56 184 Z" fill="url(#hopperTop)" />
      <path d="M182 34 L252 60 L252 176 L182 152 Z" fill="url(#hopperSide)" />
      <path d="M56 66 L182 34 L252 60 L126 92 Z" fill="var(--brand)" />
      {[0, 1, 2, 3, 4].map((i) => (
        <path key={i} d={`M${66 + i * 24} ${182 - i * 0.3} L${66 + i * 24 + 4} ${68 + i * 6}`} stroke="#000" strokeOpacity="0.14" strokeWidth="2" />
      ))}
      <path d="M66 91 L174 60" stroke="#000" strokeOpacity="0.22" strokeWidth="2.5" />
      <rect x="90" y="112" width="46" height="20" rx="2" fill="var(--bg)" opacity="0.85" />
      <text x="113" y="126" textAnchor="middle" fontFamily="'JetBrains Mono', monospace" fontSize="10" fontWeight="700" fill="var(--brand-dark)">G-07</text>
      <circle cx="76" cy="150" r="2.6" fill="#000" opacity="0.22" />
      <circle cx="76" cy="110" r="2.6" fill="#000" opacity="0.22" />

      <path d="M182 138 L200 130 L200 152 L182 160 Z" fill="var(--accent)" opacity="0.9" />

      <path d="M252 96 L300 114 L300 174 L252 174 Z" fill="var(--accent)" />
      <path d="M252 96 L300 114 L264 126 L228 108 Z" fill="var(--accent-dark)" />
      <path d="M228 108 L264 126 L264 182 L228 182 Z" fill="var(--accent-dark)" opacity="0.94" />
      <path d="M236 112 L256 120 L256 142 L236 138 Z" fill="var(--bg)" opacity="0.9" />
      <path d="M228 150 L264 164" stroke="#000" strokeOpacity="0.2" strokeWidth="1.5" />
      <rect x="246" y="152" width="10" height="3" rx="1.5" fill="var(--bg)" opacity="0.6" />
      <path d="M228 118 L219 116 L219 126 L228 128 Z" fill="var(--accent-dark)" />
      <circle cx="292" cy="150" r="7" fill="url(#headlamp)" />
      <path d="M270 168 L296 172 L296 178 L270 176 Z" fill="#1a1a1a" opacity="0.55" />
      <rect x="222" y="66" width="7" height="46" rx="2" fill="var(--text-muted)" />
      <ellipse cx="225.5" cy="66" rx="4.5" ry="2.2" fill="var(--border)" />

      <rect x="56" y="182" width="244" height="9" fill="#000" opacity="0.38" />
      <rect x="94" y="190" width="14" height="16" rx="1.5" fill="#1a1a1a" opacity="0.6" />
      <rect x="264" y="190" width="14" height="16" rx="1.5" fill="#1a1a1a" opacity="0.6" />

      {[102, 204, 276].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="200" r="18" fill="#141414" />
          <circle cx={cx} cy="200" r="18" fill="none" stroke="#000" strokeOpacity="0.4" strokeWidth="2" />
          <circle cx={cx} cy="200" r="9.5" fill="var(--text-muted)" />
          <circle cx={cx} cy="200" r="9.5" fill="none" stroke="#000" strokeOpacity="0.25" strokeWidth="1" />
          {[0, 72, 144, 216, 288].map((deg) => {
            const r1 = 2.2, r2 = 8.6;
            const rad = (deg * Math.PI) / 180;
            return (
              <line key={deg} x1={cx + r1 * Math.cos(rad)} y1={200 + r1 * Math.sin(rad)} x2={cx + r2 * Math.cos(rad)} y2={200 + r2 * Math.sin(rad)} stroke="#141414" strokeWidth="2" />
            );
          })}
        </g>
      ))}
    </svg>
  );
}

// A stop-and-go collection route: a dashed line threading between a few
// waypoint dots, ending at a filled pin.
export function RouteMotif({ style }) {
  return (
    <svg viewBox="0 0 260 200" width="260" height="200" style={style} aria-hidden="true">
      <path d="M8 170 C 60 170, 60 110, 110 110 S 160 40, 210 40" fill="none" stroke="var(--brand)" strokeWidth="2.5" strokeDasharray="1 9" strokeLinecap="round" opacity="0.55" />
      <circle cx="8" cy="170" r="4" fill="var(--brand)" opacity="0.6" />
      <circle cx="110" cy="110" r="4" fill="var(--accent)" opacity="0.6" />
      <circle cx="210" cy="40" r="5.5" fill="var(--accent)" opacity="0.75" />
    </svg>
  );
}

export function DispatchStatChip({ label, value }) {
  return (
    <div style={{ padding: '10px 14px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '6px', minWidth: '84px' }}>
      <div style={{ fontFamily: MONO_FONT, fontSize: '18px', fontWeight: 700, color: '#fff', lineHeight: 1 }}>{value}</div>
      <div style={{ fontFamily: MONO_FONT, fontSize: '9px', letterSpacing: '0.1em', color: 'rgba(255,255,255,0.55)', marginTop: '5px', textTransform: 'uppercase' }}>{label}</div>
    </div>
  );
}

// The embossed logo medallion — a conic-gradient rim ring (padding trick:
// outer disc in brand colors, inner disc inset 2.5px) plus a layered
// inset shadow, reading as a raised, stamped inspection seal.
export function DispatchMedallion({ size = 62, logoHeight = 32, fallback }) {
  return (
    <div
      style={{
        width: `${size}px`, height: `${size}px`, flexShrink: 0, borderRadius: '50%', padding: '2.5px',
        background: 'conic-gradient(from 200deg, var(--brand), var(--accent), var(--brand))',
        boxShadow: '0 8px 18px -6px color-mix(in srgb, var(--brand) 55%, transparent)',
      }}
    >
      <div
        style={{
          width: '100%', height: '100%', borderRadius: '50%',
          background: 'linear-gradient(155deg, var(--surface), var(--bg))',
          boxShadow: '0 1px 0 rgba(255,255,255,0.5) inset, 0 -1px 4px rgba(0,0,0,0.18) inset',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <CompanyLogoSlot height={logoHeight} fallback={fallback} />
      </div>
    </div>
  );
}

// Deferred import to avoid a circular concern — CompanyLogo itself has no
// dependency on this file, this is just kept local to the medallion.
import CompanyLogo from './CompanyLogo.jsx';
function CompanyLogoSlot({ height, fallback }) {
  return <CompanyLogo height={height} fallback={fallback} style={{ borderRadius: '50%' }} />;
}
