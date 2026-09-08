import React, { useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { X } from 'lucide-react';
import { NAV } from './Sidebar.jsx';
import RoleGate from '../components/RoleGate.jsx';

// Sidebar / Navigation UX — Implementation Spec §7/§9/§13/§15. The mobile
// drawer for non-field roles. Imports the exact same NAV array and RoleGate
// component Sidebar.jsx already uses — structurally, not by convention,
// this cannot drift out of sync with the desktop nav's own RBAC filtering,
// since it is the same array reference and the same gating component.
//
// Focus trap / restoration (Spec §13): on open, focus moves to the close
// button; while open, Tab/Shift+Tab cycle only within the drawer's own
// focusable elements; on close (by any method), focus returns to the
// trigger button the caller passed in via triggerRef.
export default function MobileNavDrawer({ open, onClose, triggerRef }) {
  const closeButtonRef = useRef(null);
  const drawerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    // Focus the close button as soon as the drawer opens.
    closeButtonRef.current?.focus();

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = drawerRef.current?.querySelectorAll(
        'a[href], button:not([disabled])'
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    // Lock body scroll while the drawer is open (Spec §15/§16 — a
    // genuinely new pattern for this codebase, per Discovery; implemented
    // minimally, restored unconditionally on close/unmount).
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      // Focus restoration (Spec §13): back to whichever trigger opened it.
      triggerRef?.current?.focus();
    };
  }, [open, onClose, triggerRef]);

  if (!open) return null;

  function handleNavigate() {
    // Spec §15: tap-to-navigate-and-dismiss.
    onClose();
  }

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 90,
          transition: 'opacity 0.2s ease',
        }}
        aria-hidden="true"
      />
      <div
        id="mobile-nav-drawer"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
        style={{
          position: 'fixed', top: 0, left: 0, bottom: 0, width: '260px', maxWidth: '80vw',
          background: 'var(--surface)', borderRight: '1px solid var(--border)', zIndex: 91,
          display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-md)',
          transition: 'transform 0.2s ease', transform: 'translateX(0)',
        }}
      >
        <div style={{ padding: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontWeight: 900, fontSize: '18px', color: 'var(--brand)' }}>GURMAD V2</span>
          {/* QA Defect #1 fix: 44x44 clickable/touchable area (was 28x28,
              20px icon + 4px padding). Icon itself stays 20px — only the
              interactive hit area grows, via fixed width/height + flex
              centering instead of padding, so it meets the >=44x44
              touch-target requirement without enlarging the visible glyph. */}
          <button
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="Close menu"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', width: '44px', height: '44px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <X size={20} />
          </button>
        </div>
        <nav style={{ flex: 1, padding: '8px', display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto' }}>
          {NAV.map((item) => {
            const link = (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={handleNavigate}
                style={({ isActive }) => ({
                  display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px',
                  borderRadius: 'var(--radius-sm)', textDecoration: 'none', fontWeight: 700, fontSize: '13px',
                  color: isActive ? 'var(--brand)' : 'var(--text-muted)',
                  background: isActive ? 'var(--success-bg)' : 'transparent',
                })}
              >
                <item.icon size={17} />
                {item.label}
              </NavLink>
            );
            if (item.roles || item.permission) {
              return <RoleGate key={item.to} roles={item.roles} permission={item.permission}>{link}</RoleGate>;
            }
            return link;
          })}
        </nav>
      </div>
    </>
  );
}
