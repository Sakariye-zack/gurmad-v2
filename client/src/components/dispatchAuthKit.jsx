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
        <linearGradient id="windshield" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#bcd8de" />
          <stop offset="1" stopColor="#5c7d84" />
        </linearGradient>
      </defs>

      <ellipse cx="175" cy="206" rx="150" ry="11" fill="#000" opacity="0.3" />

      <path d="M56 66 L182 34 L182 152 L56 184 Z" fill="url(#hopperTop)" />
      <path d="M182 34 L252 60 L252 176 L182 152 Z" fill="url(#hopperSide)" />
      <path d="M56 66 L182 34 L252 60 L126 92 Z" fill="var(--brand)" />
      {[0, 1, 2, 3, 4].map((i) => (
        <path key={i} d={`M${66 + i * 24} ${182 - i * 0.3} L${66 + i * 24 + 4} ${68 + i * 6}`} stroke="#000" strokeOpacity="0.14" strokeWidth="2" />
      ))}
      <path d="M66 91 L174 60" stroke="#000" strokeOpacity="0.22" strokeWidth="2.5" />

      {/* Amber warning-light row along the cab-facing edge of the hopper
          roof — the single most recognizable rear-loader detail in the
          reference photo, easy to read even at small size. */}
      {[0, 1, 2, 3].map((i) => (
        <circle key={i} cx={140 + i * 16} cy={50 - i * 1.5} r="3" fill="#ffb020" opacity="0.95" />
      ))}

      <rect x="90" y="112" width="46" height="20" rx="2" fill="var(--bg)" opacity="0.85" />
      <text x="113" y="126" textAnchor="middle" fontFamily="'JetBrains Mono', monospace" fontSize="10" fontWeight="700" fill="var(--brand-dark)">G-07</text>
      <circle cx="76" cy="150" r="2.6" fill="#000" opacity="0.22" />
      <circle cx="76" cy="110" r="2.6" fill="#000" opacity="0.22" />

      {/* Rear hopper mechanism — user-requested full truck redo ("gaadhiga
          gabigiisaba iga badal"): the loose-trash approach (twice) read
          badly at this size, so the "this is a rear-loading garbage
          truck" cue now comes from the vehicle's own hardware instead —
          a tilted loading hopper mouth + hydraulic lift arm at the back
          end, the actual identifying feature of a real collection truck,
          plus a hazard-stripe rear bumper. */}
      <path d="M28 96 L56 66 L56 184 L28 172 Z" fill="var(--brand-dark)" />
      <path d="M28 96 L56 66 L64 70 L36 100 Z" fill="var(--brand)" opacity="0.85" />
      <path d="M28 150 L58 150 L58 160 L28 160 Z" fill="var(--accent)" />
      {[0, 1, 2, 3].map((i) => (
        <path key={i} d={`M${30 + i * 8} 150 L${34 + i * 8} 160`} stroke="#000" strokeOpacity="0.5" strokeWidth="3" />
      ))}
      <path d="M38 96 L20 80 L24 74 L44 90 Z" fill="var(--text-muted)" />
      <path d="M20 80 L12 70 L18 66 L26 76 Z" fill="var(--text-muted)" />
      <circle cx="20" cy="80" r="4" fill="var(--border)" />

      <path d="M182 138 L200 130 L200 152 L182 160 Z" fill="var(--accent)" opacity="0.9" />

      <path d="M252 96 L300 114 L300 174 L252 174 Z" fill="var(--accent)" />
      <path d="M252 96 L300 114 L264 126 L228 108 Z" fill="var(--accent-dark)" />
      <path d="M228 108 L264 126 L264 182 L228 182 Z" fill="var(--accent-dark)" opacity="0.94" />
      {/* Windshield — enlarged + glass-tinted (was a thin pale sliver),
          user-requested higher-fidelity pass after the reference photo. */}
      <path d="M233 113 L260 122 L260 140 L233 133 Z" fill="url(#windshield)" />
      <path d="M236 115 L244 118 L241 130 L233 127 Z" fill="#fff" opacity="0.35" />
      <path d="M233 113 L260 122 L260 140 L233 133 Z" fill="none" stroke="#0f1a10" strokeOpacity="0.35" strokeWidth="1.5" />
      <path d="M228 150 L264 164" stroke="#000" strokeOpacity="0.2" strokeWidth="1.5" />
      <rect x="246" y="152" width="10" height="3" rx="1.5" fill="var(--bg)" opacity="0.6" />
      {/* Chrome side step, below the door. */}
      <rect x="232" y="158" width="18" height="3.5" rx="1.5" fill="#c9cdc9" opacity="0.8" />
      <path d="M228 118 L219 116 L219 126 L228 128 Z" fill="var(--accent-dark)" />

      {/* Front-engine hood + grille — user shared a real rear-loader
          reference photo (chrome grille, round headlamps, low hood
          under a taller cab) and asked for that read, not a cab-forward
          van front. */}
      <rect x="266" y="140" width="30" height="26" rx="2" fill="#1a1a1a" />
      {[0, 1, 2, 3].map((i) => (
        <line key={i} x1="269" y1={145 + i * 5.5} x2="293" y2={145 + i * 5.5} stroke="#8a8f8a" strokeWidth="1.6" />
      ))}
      <rect x="264" y="168" width="34" height="6" rx="1.5" fill="#c9cdc9" />
      <circle cx="292" cy="150" r="7" fill="url(#headlamp)" />
      <circle cx="270" cy="150" r="5.5" fill="url(#headlamp)" />
      <path d="M270 168 L296 172 L296 178 L270 176 Z" fill="#1a1a1a" opacity="0.55" />
      <rect x="222" y="66" width="7" height="46" rx="2" fill="var(--text-muted)" />
      <ellipse cx="225.5" cy="66" rx="4.5" ry="2.2" fill="var(--border)" />

      <rect x="56" y="182" width="244" height="9" fill="#000" opacity="0.38" />
      <rect x="94" y="190" width="14" height="16" rx="1.5" fill="#1a1a1a" opacity="0.6" />
      <rect x="264" y="190" width="14" height="16" rx="1.5" fill="#1a1a1a" opacity="0.6" />

      {[102, 204, 276].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="200" r="19.5" fill="#141414" />
          <circle cx={cx} cy="200" r="19.5" fill="none" stroke="#000" strokeOpacity="0.4" strokeWidth="2" />
          <path d={`M${cx - 13} 190 A 19.5 19.5 0 0 1 ${cx + 4} 182`} fill="none" stroke="#3a3a3a" strokeOpacity="0.6" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx={cx} cy="200" r="10" fill="var(--text-muted)" />
          <circle cx={cx} cy="200" r="10" fill="none" stroke="#000" strokeOpacity="0.25" strokeWidth="1" />
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

// A standalone wheelie-bin illustration — user-requested, a second waste
// motif alongside IsoTruck for wherever the hero panel needs a smaller
// accent graphic. Same isometric/gradient treatment (brand/accent tokens,
// per-facet shading) so it reads as part of the same illustration family,
// not a mismatched stock icon. A tilted, slightly-open lid + a couple of
// loose scraps at the rim mirror the truck's own "overflowing" cue.
export function DustbinIcon({ style }) {
  return (
    <svg viewBox="0 0 140 160" width="100%" height="100%" style={style} aria-hidden="true">
      <defs>
        <linearGradient id="binFront" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-dark)" />
        </linearGradient>
        <linearGradient id="binSide" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--accent-dark)" />
          <stop offset="1" stopColor="#000" stopOpacity="0.3" />
        </linearGradient>
      </defs>

      <ellipse cx="70" cy="148" rx="46" ry="8" fill="#000" opacity="0.28" />

      {/* Body — tapered wheelie-bin silhouette (narrower base than rim). */}
      <path d="M34 66 L94 66 L88 138 L40 138 Z" fill="url(#binFront)" />
      <path d="M94 66 L112 74 L104 142 L88 138 Z" fill="url(#binSide)" />
      <path d="M34 66 L94 66 L112 74 L52 74 Z" fill="var(--accent)" />

      {/* Rim ribs. */}
      {[0, 1, 2].map((i) => (
        <line key={i} x1={40 + i * 16} y1="80" x2={38 + i * 15} y2="132" stroke="#000" strokeOpacity="0.14" strokeWidth="2" />
      ))}

      {/* Recycling arrows plate. */}
      <rect x="50" y="96" width="30" height="22" rx="2" fill="var(--bg)" opacity="0.85" />
      <path d="M65 100 l6 5 -3 1 1 4 -8 -2 1 -4 -3 1 Z" fill="var(--accent-dark)" transform="rotate(120 65 107)" />
      <path d="M65 100 l6 5 -3 1 1 4 -8 -2 1 -4 -3 1 Z" fill="var(--accent-dark)" />
      <path d="M65 100 l6 5 -3 1 1 4 -8 -2 1 -4 -3 1 Z" fill="var(--accent-dark)" transform="rotate(240 65 107)" />

      {/* Ajar lid + a couple of loose scraps, echoing IsoTruck's own
          overflowing-hopper detail. */}
      <path d="M28 58 L100 58 L112 66 L40 66 Z" fill="var(--brand)" />
      <path d="M28 58 L100 58 L100 50 L28 50 Z" fill="var(--brand-dark)" transform="translate(0 -4) skewX(-6)" />
      <path d="M46 44 L56 40 L58 47 L48 50 Z" fill="var(--text-muted)" opacity="0.85" />
      <circle cx="70" cy="42" r="4" fill="var(--bg)" opacity="0.8" />

      {/* Wheels. */}
      <circle cx="50" cy="146" r="8" fill="#141414" />
      <circle cx="86" cy="146" r="8" fill="#141414" />
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
