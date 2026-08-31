import React, { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import MobileTabBar from './MobileTabBar.jsx';
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
  const useMobileShell = isMobile || isFieldRole;

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {!useMobileShell && <Sidebar />}
      <main style={{ flex: 1, padding: useMobileShell ? '16px' : '24px', paddingBottom: useMobileShell ? '80px' : '24px', maxWidth: '1400px' }}>
        <Outlet />
      </main>
      {useMobileShell && <MobileTabBar />}
    </div>
  );
}
