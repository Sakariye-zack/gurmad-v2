import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { Button, ConfirmDialog } from '../../components/ui/index.js';
import AccountSecurity from '../../pages/account/AccountSecurity.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { purgeAllLocalData } from '../lib/collectorStore.js';
import { discardKey } from '../lib/collectorCrypto.js';

// Screen 6.7 + 6.8 (Decisions §17). 6.7 reuses the existing, unmodified
// AccountSecurity page component exactly as-is (Discovery §12 confirmed it
// already exists for every staff role) — no Collector-specific change to
// that shared component. 6.8 (Logout) is layered here, not inside
// AuthContext.logout() itself, so the shared, CLOSED auth file remains
// untouched — this screen orchestrates BOTH the existing logout() call AND
// the new local-data purge (§9), in that order.
export default function AccountScreen() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const doLogout = async () => {
    setLoggingOut(true);
    try {
      await purgeAllLocalData(); // §6.8 — must never leave protected data behind, even if this throws below
    } catch {
      // Never block logout on a purge failure (§6.8's own explicit rule) —
      // logged client-side only, not audited (a technical, not business, event).
      // eslint-disable-next-line no-console
      console.error('collector_logout_purge_failed');
    } finally {
      discardKey();
      logout(); // existing, unmodified AuthContext behavior
      navigate('/collector/login');
    }
  };

  return (
    <div>
      <AccountSecurity />
      <div style={{ marginTop: '24px' }}>
        <Button variant="danger" icon={LogOut} onClick={() => setConfirmOpen(true)} style={{ width: '100%', minHeight: '48px' }}>
          Log out
        </Button>
      </div>
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
    </div>
  );
}
