import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Home, ClipboardList, RefreshCw, ShieldAlert, LogOut } from 'lucide-react';
import { useSyncQueueContext } from './SyncQueueContext.jsx';
import { useAuth } from '../auth/AuthContext.jsx';
import CompanyLogo from '../components/CompanyLogo.jsx';
import NotificationBell from '../components/notifications/NotificationBell.jsx';
import { ConfirmDialog } from '../components/ui/index.js';
import { purgeAllLocalData } from './lib/collectorStore.js';
import { discardKey } from './lib/collectorCrypto.js';
import { apiClient } from '../lib/apiClient.js';

// Live truck location — Phase 10, user-requested ('ilaa gawaadhidii ay ka
// soo muuqato': trucks should appear on the Map). Every 2 minutes while
// this shell is mounted (i.e. the collector is logged in and the app is
// open — the shell wraps every screen), take one current position reading
// and POST it. Mirrors CollectionActionScreen.jsx's own captureGps()
// exactly: bounded 5s timeout, missing/denied permission resolves to
// nothing rather than blocking or erroring, and the request itself is
// fire-and-forget from the UI's perspective — a failed or ineligible ping
// (POST /v2/collection-sync/location silently no-ops when this collector
// has no active batch today, per that route's own comment) never
// surfaces to the collector, who has no action to take about it either
// way. getCurrentPosition, not watchPosition — a single fresh fix every
// interval is enough for "roughly where is this truck right now" and
// avoids holding a continuous GPS lock (battery) for a use case that only
// needs a periodic snapshot.
const LOCATION_PING_INTERVAL_MS = 2 * 60 * 1000;
function useLocationPing() {
  useEffect(() => {
    if (!navigator.geolocation) return undefined;
    function ping() {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          apiClient.post('/v2/collection-sync/location', { lat: pos.coords.latitude, lng: pos.coords.longitude }).catch(() => {});
        },
        () => {}, // denied/unavailable — silently skip this cycle, try again next interval
        { timeout: 5000 }
      );
    }
    ping(); // first ping immediately on mount, not after waiting a full interval
    const id = setInterval(ping, LOCATION_PING_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
}

// Field Collector Mobile — Implementation Spec §6/§24. A lightweight,
// mobile-first shell distinct from the desktop staff AppShell (large touch
// targets, one-handed bottom-nav reach, per Discovery §13's field-usability
// findings) — not a redesign of the existing desktop design system, which
// this shell still consumes via components/ui/* throughout every screen.
//
// Top app bar (user-requested, Phase 10) — every screen in this shell
// previously opened straight into content with no persistent header at
// all; logout was reachable only by navigating into Account -> scrolling
// to Active Sessions -> Log out, three steps for something every native
// mobile app puts one tap away. Logo + collector's own name here (not a
// generic "GURMAD V2" — this shell is field-worker-facing, the wordmark
// carries less than knowing who's signed in) + a one-tap logout icon.
export default function CollectorShell() {
  const { activeCount } = useSyncQueueContext();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  useLocationPing();

  // Identical sequence to AccountScreen.jsx's own doLogout() (purge local
  // data -> discard the in-memory encryption key -> AuthContext logout()
  // -> navigate) — duplicated here rather than refactored into one shared
  // helper only because AccountScreen.jsx's own header explicitly frames
  // that file as the sole place this orchestration lives; kept the exact
  // same steps and ordering so the two never drift into different logout
  // behavior for the same shell.
  const doLogout = async () => {
    setLoggingOut(true);
    try {
      await purgeAllLocalData();
    } catch {
      // eslint-disable-next-line no-console
      console.error('collector_logout_purge_failed');
    } finally {
      discardKey();
      logout();
      navigate('/collector/login');
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <header style={{
        position: 'sticky', top: 0, zIndex: 40, display: 'flex', alignItems: 'center', gap: '10px',
        padding: '12px 16px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
      }}>
        <CompanyLogo height={26} fallback={<span style={{ fontWeight: 900, fontSize: '15px', color: 'var(--brand)' }}>GURMAD</span>} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {user?.full_name || user?.username}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{user?.zone || 'Collector'}</div>
        </div>
        <NotificationBell to="/collector/notifications" />
        <button
          onClick={() => setConfirmOpen(true)}
          aria-label="Log out"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: '40px', height: '40px',
            borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)',
            color: 'var(--text-muted)', cursor: 'pointer',
          }}
        >
          <LogOut size={17} />
        </button>
      </header>

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={doLogout}
        title="Log out"
        message="This will sign you out and remove all locally saved visit data from this device."
        confirmLabel="Log out"
        danger
        isLoading={loggingOut}
      />

      <main style={{ flex: 1, padding: '16px', paddingBottom: '84px', maxWidth: '520px', margin: '0 auto', width: '100%' }}>
        <Outlet />
      </main>
      <nav style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, background: 'var(--surface)',
        borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-around',
        padding: '8px 0 max(8px, env(safe-area-inset-bottom))', zIndex: 50,
      }}>
        <NavTab to="/collector" icon={Home} label="Home" end />
        <NavTab to="/collector/assignments" icon={ClipboardList} label="Assignments" />
        <NavTab to="/collector/sync" icon={RefreshCw} label="Sync" badge={activeCount} />
        <NavTab to="/collector/account" icon={ShieldAlert} label="Account" />
      </nav>
    </div>
  );
}

function NavTab({ to, icon: Icon, label, end, badge }) {
  return (
    <NavLink to={to} end={end} style={({ isActive }) => ({
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
      padding: '8px 20px', minWidth: '64px', minHeight: '44px', textDecoration: 'none',
      color: isActive ? 'var(--brand)' : 'var(--text-muted)', fontWeight: 700, fontSize: '11px', position: 'relative',
    })}>
      <div style={{ position: 'relative' }}>
        <Icon size={22} />
        {badge > 0 && (
          <span style={{
            position: 'absolute', top: '-6px', right: '-8px', background: 'var(--danger)', color: '#fff',
            borderRadius: '10px', fontSize: '10px', fontWeight: 800, minWidth: '16px', height: '16px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px',
          }}>{badge}</span>
        )}
      </div>
      {label}
    </NavLink>
  );
}
