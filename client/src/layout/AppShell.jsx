import React, { useEffect, useRef, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { PanelLeftClose, PanelLeftOpen, Menu } from 'lucide-react';
import Sidebar from './Sidebar.jsx';
import MobileTabBar from './MobileTabBar.jsx';
import MobileNavDrawer from './MobileNavDrawer.jsx';
import FieldTopBar from './FieldTopBar.jsx';
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

      {showToggleButton && (
        <button
          ref={toggleButtonRef}
          onClick={handleToggleClick}
          aria-label={isMobile ? 'Open menu' : (sidebarOpen ? 'Hide navigation' : 'Show navigation')}
          aria-expanded={isMobile ? drawerOpen : sidebarOpen}
          aria-controls={isMobile ? 'mobile-nav-drawer' : 'app-sidebar'}
          style={{
            // When the desktop Sidebar is visible, the button sits just past
            // its 240px width so it never overlaps the Sidebar's own header
            // (its "GURMAD V2" wordmark occupies the same top-left corner
            // this control would otherwise sit on top of). Hidden/mobile:
            // top-left of the viewport, matching Spec §11. 44x44 — Hardening
            // touch-target check: meets the standard WCAG minimum, the
            // original 36x36 did not.
            position: 'fixed', top: '16px', left: showDesktopSidebar ? '252px' : '16px', zIndex: 92,
            width: '44px', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--text)', cursor: 'pointer',
          }}
        >
          {isMobile ? <Menu size={17} /> : (sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />)}
        </button>
      )}

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
      <main style={{
        flex: 1, minWidth: 0,
        // User-reported gap (Phase 10): field roles (cashier) had no
        // header at all — see FieldTopBar.jsx. paddingTop drops to 0
        // here (was a flat 16px) because FieldTopBar now owns that
        // top space itself via its own padding + sticky positioning;
        // its own bottom margin (-16px…16px) reclaims the 16px side
        // gutters so it bleeds edge-to-edge while <Outlet/> content
        // keeps the same 16px it always had.
        paddingTop: showFieldTabBar ? 0 : (showToggleButton ? '56px' : '24px'),
        paddingLeft: showFieldTabBar ? '16px' : '24px',
        paddingRight: showFieldTabBar ? '16px' : '24px',
        paddingBottom: showFieldTabBar ? '80px' : '24px',
        maxWidth: '1400px',
      }}>
        {showFieldTabBar && <FieldTopBar />}
        <Outlet />
      </main>
      {showFieldTabBar && <MobileTabBar />}
    </div>
  );
}
