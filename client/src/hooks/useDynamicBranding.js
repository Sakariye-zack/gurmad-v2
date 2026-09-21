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
        const link = document.querySelector('link[rel="icon"]');
        if (!link) return;
        if (res.ok) {
          link.href = `/api/v2/settings/company/logo?v=${Date.now()}`;
        }
        // A 404 (no logo set) intentionally leaves the static
        // icon-192.png default in place — never swapped to a broken URL.
      })
      .catch(() => {
        // Network hiccup — leave whatever favicon is already showing.
      });
    return () => { cancelled = true; };
  }, [companyName]);
}
