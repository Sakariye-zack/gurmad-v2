import { useEffect } from 'react';
import { useCompanyName } from './useSettings.js';

// User-requested: the browser tab (title + favicon) should reflect the
// real company branding (Settings > Company Information), not the
// generic static icon-192.png/'Gurmad V2' placeholder baked into
// index.html — on every page, including the login screen, not just
// once logged in (Sidebar.jsx/MobileNavDrawer.jsx already set the title
// once authenticated; this covers the whole app, pre- and post-login).
//
// The favicon swap is existence-checked via a real fetch first (never a
// blind href swap) so an unset logo never leaves a broken/blank tab icon
// — same "never show a broken image" rule CompanyLogo.jsx already
// follows for the in-app logo.
export function useDynamicBranding() {
  const { data } = useCompanyName();
  const companyName = data?.data?.company_name;

  useEffect(() => {
    document.title = companyName || 'GURMAD V2';
  }, [companyName]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v2/settings/company/logo', { method: 'HEAD' })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) return;
        // A 404 (no logo set) intentionally leaves the static
        // icon-192.png default in place — never swapped to a broken URL.
        // The square, padded icon endpoint (not the raw, usually wide
        // logo) is what both the tab favicon and the iOS home-screen icon
        // need to stay legible at 16-180px; the installed-PWA icon comes
        // from the dynamic manifest instead (settings.js).
        const v = Date.now();
        const favicon = document.querySelector('link[rel="icon"]');
        if (favicon) favicon.href = `/api/v2/settings/company/icon/192.png?v=${v}`;
        const apple = document.querySelector('link[rel="apple-touch-icon"]');
        if (apple) apple.href = `/api/v2/settings/company/icon/180.png?v=${v}`;
      })
      .catch(() => {
        // Network hiccup — leave whatever favicon is already showing.
      });
    return () => { cancelled = true; };
  }, [companyName]);
}
