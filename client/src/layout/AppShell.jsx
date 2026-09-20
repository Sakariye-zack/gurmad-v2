import React, { useEffect, useRef, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import MobileTabBar from './MobileTabBar.jsx';
import MobileNavDrawer from './MobileNavDrawer.jsx';
import FieldTopBar from './FieldTopBar.jsx';
import TopBar from './TopBar.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

const FIELD_ROLES = ['collector', 'cashier'];

export default function AppShell() {
  const { user } = useAuth();
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const isFieldRole = FIELD_ROLES.includes((user?.role || '').toLowerCase());

  // Sidebar / Navigation UX — Implementation Spec §10. Session-only state:
  // plain useState, no localStorage, no Context, no backend persistence.
  // Resets to the default (visible) on every fresh mount (i.e. a hard
  // reload), persists across in-app route navigation since AppShell itself
  // doesn't remount on route change (unchanged, pre-existing behavior).
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const toggleButtonRef = useRef(null);

  function handleToggleClick() {
    if (isMobile) {
      setDrawerOpen((v) => !v);
      return;
    }
    // Spec §16: suppress any transient horizontal scrollbar flash during
    // the desktop hide/show transition.
    setIsTransitioning(true);
    setSidebarOpen((v) => !v);
    window.setTimeout(() => setIsTransitioning(false), 220);
  }

  // Spec §4: this is the critical structural fix — MobileTabBar's render
  // condition changes from `isMobile || isFieldRole` to `isFieldRole`
  // alone. A non-field role never sees MobileTabBar; below 768px they get
  // the drawer (with the exact same RBAC-filtered NAV as desktop) instead.
  const showFieldTabBar = isFieldRole;
  const showDesktopSidebar = !isFieldRole && !isMobile && sidebarOpen;
  // The outer trigger hides while the mobile drawer is open — the drawer
  // owns its own close button in that same top-left corner (Spec §15); two
  // overlapping controls in one spot would be a genuine layout/accessibility
  // defect, not a stylistic choice.
  const showToggleButton = !isFieldRole && !(isMobile && drawerOpen);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', overflowX: isTransitioning ? 'hidden' : 'visible' }}>
      {showDesktopSidebar && <Sidebar />}

      {!isFieldRole && isMobile && (
        <MobileNavDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} triggerRef={toggleButtonRef} />
      )}

      {/* minWidth: 0 overrides the flex item's default min-width:auto — without
          it, wide content (e.g. DataTable) refuses to shrink below its
          natural width and pushes the whole page wider than the viewport.
          Found during Phase 3 Module 1 tablet-width QA (844px page vs 768px
          viewport); DataTable's own overflow-x:auto wrapper only works once
          this ancestor is actually allowed to shrink to the flexed width.
          Unchanged by Sidebar / Navigation UX — this property is preserved
          exactly, in every Sidebar/drawer state (Implementation Spec §16). */}
      <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Top Bar — Phase 10, user-requested (search/notifications/
            profile/theme). Desktop, non-field roles only; field roles
            keep their own FieldTopBar below, unchanged. Sits OUTSIDE the
            padded content wrapper so it bleeds edge-to-edge like
            FieldTopBar's own header already does.
            User-reported ('meel ku haboon dhig, meel cidlo ah bay iska
            taalaye'): the sidebar-collapse toggle used to float as its
            own fixed-position button in an empty stretch of page above
            the content — now rendered as TopBar's own leading element
            instead, in normal flow right next to the search box, not a
            separate floating control with dead space around it. */}
        {!showFieldTabBar && (
          <TopBar
            showToggleButton={showToggleButton}
            onToggle={handleToggleClick}
            isMobile={isMobile}
            sidebarOpen={sidebarOpen}
            drawerOpen={drawerOpen}
            toggleButtonRef={toggleButtonRef}
          />
        )}
        <div style={{
          flex: 1,
          // User-reported gap (Phase 10): field roles (cashier) had no
          // header at all — see FieldTopBar.jsx. paddingTop drops to 0
          // here (was a flat 16px) because FieldTopBar now owns that
          // top space itself via its own padding + sticky positioning;
          // its own bottom margin (-16px…16px) reclaims the 16px side
          // gutters so it bleeds edge-to-edge while <Outlet/> content
          // keeps the same 16px it always had. Non-field roles no longer
          // need the old fixed-toggle-button top offset now that TopBar
          // itself occupies that space in normal flow.
          paddingTop: showFieldTabBar ? 0 : '24px',
          paddingLeft: showFieldTabBar ? '16px' : '24px',
          paddingRight: showFieldTabBar ? '16px' : '24px',
          paddingBottom: showFieldTabBar ? '80px' : '24px',
          maxWidth: '1400px',
        }}>
          {showFieldTabBar && <FieldTopBar />}
          <Outlet />
        </div>
      </main>
      {showFieldTabBar && <MobileTabBar />}
    </div>
  );
}
