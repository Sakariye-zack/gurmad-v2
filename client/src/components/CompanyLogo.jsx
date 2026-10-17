import React, { useState } from 'react';

// Phase 10 Gap Audit fix — the uploaded company logo (Settings > Company
// Information) only ever rendered inside the Settings form's own preview;
// nowhere else in the app (Sidebar, staff/Customer Portal/Collector login
// screens) displayed it at all. Shared across all three, since the
// backend endpoint it hits (GET /api/v2/settings/company/logo) is now
// deliberately public/unauthenticated (Phase 10, user-confirmed) — this
// is a plain <img>, no token, no fetch hook needed.
//
// Falls back to `fallback` (typically the "GURMAD V2" wordmark text) when
// no logo is set yet or the request fails — never a broken-image icon.
export default function CompanyLogo({ fallback, height = 32, style, full = false }) {
  const [failed, setFailed] = useState(false);
  if (failed) return fallback;
  return (
    <img
      src={full ? '/api/v2/settings/company/logo' : '/api/v2/settings/company/logo-trimmed'}
      alt="Company logo"
      height={height}
      style={{ display: 'block', maxWidth: '160px', objectFit: 'contain', ...style }}
      onError={() => setFailed(true)}
    />
  );
}
