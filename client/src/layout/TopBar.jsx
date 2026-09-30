import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, ChevronDown, Camera, ShieldCheck, UserCircle2, LogOut, Users, Receipt, Users2, PanelLeftClose, PanelLeftOpen, Menu } from 'lucide-react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useGlobalSearch } from '../hooks/useSearch.js';
import { useUploadAvatar } from '../hooks/useAvatar.js';
import { useToast } from '../components/ui/index.js';
import Avatar from '../components/Avatar.jsx';
import NotificationBell from '../components/notifications/NotificationBell.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import LanguageToggle from '../components/LanguageToggle.jsx';
import { useI18n } from '../i18n/I18nContext.jsx';

// Top Bar — Phase 10, user-requested ('dashboardka waxaad iigu soo
// dartaa search bar oo waliba global search ah, notificationka,
// profile ka iigu soo dar, sawir soo saaran karo, iga qurxi'): a
// conventional app top bar (search + notifications + profile + theme),
// replacing the cramped bell/theme-toggle pair previously squeezed into
// Sidebar.jsx's own small header next to the logo. Desktop, non-field
// roles only — field roles (cashier/collector) already have their own
// dedicated FieldTopBar.jsx/CollectorShell.jsx headers, which this does
// not replace.
export default function TopBar({ showToggleButton, onToggle, isMobile, sidebarOpen, drawerOpen, toggleButtonRef }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const searchRef = useRef(null);
  const profileRef = useRef(null);
  const fileInputRef = useRef(null);
  const uploadAvatar = useUploadAvatar();
  const { data: searchData, isLoading: searching } = useGlobalSearch(query);
  const results = searchData?.data || { customers: [], invoices: [], employees: [] };
  const hasResults = results.customers.length + results.invoices.length + results.employees.length > 0;

  // Click-outside closes both popovers — the standard pattern this app
  // doesn't otherwise have a shared component for yet.
  useEffect(() => {
    function onClick(e) {
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
      if (profileRef.current && !profileRef.current.contains(e.target)) setProfileOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  function goTo(path) {
    navigate(path);
    setQuery('');
    setSearchOpen(false);
  }

  async function handlePhotoChange(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast.error('Photo exceeds the 2MB size limit.'); return; }
    try {
      await uploadAvatar.mutateAsync(file);
      setAvatarVersion((v) => v + 1);
      toast.success('Profile photo updated.');
    } catch (err) {
      toast.error(err.message || 'Failed to upload photo.');
    }
  }

  return (
    <header style={{
      position: 'sticky', top: 0, zIndex: 80, display: 'flex', alignItems: 'center', gap: '16px',
      padding: '10px 20px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
      minHeight: '60px',
    }}>
      {/* Sidebar collapse/menu toggle — user-reported ('meel ku haboon
          dhig, meel cidlo ah bay iska taalaye'): moved here from its own
          floating fixed-position button (AppShell.jsx), which sat above
          the page content with empty space around it. Lives in normal
          flow now, right beside the search box it was always meant to
          sit next to. */}
      {showToggleButton && (
        <button
          ref={toggleButtonRef}
          onClick={onToggle}
          aria-label={isMobile ? 'Open menu' : (sidebarOpen ? 'Hide navigation' : 'Show navigation')}
          aria-expanded={isMobile ? drawerOpen : sidebarOpen}
          aria-controls={isMobile ? 'mobile-nav-drawer' : 'app-sidebar'}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            width: '38px', height: '38px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
            background: 'var(--bg)', color: 'var(--text)', cursor: 'pointer',
          }}
        >
          {isMobile ? <Menu size={17} /> : (sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />)}
        </button>
      )}

      {/* Global Search */}
      <div ref={searchRef} style={{ position: 'relative', flex: '0 1 380px', minWidth: 0 }}>
        <Search size={15} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSearchOpen(true); }}
          onFocus={() => setSearchOpen(true)}
          placeholder={t('topbar.searchPlaceholder')}
          style={{
            width: '100%', padding: '9px 12px 9px 34px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
            background: 'var(--bg)', color: 'var(--text)', fontSize: '13px', fontFamily: 'inherit', boxSizing: 'border-box',
          }}
        />
        {searchOpen && query.trim().length >= 2 && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, width: '100%', minWidth: '340px', maxHeight: '420px', overflowY: 'auto',
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', zIndex: 90,
          }}>
            {searching && <div style={{ padding: '14px', fontSize: '13px', color: 'var(--text-muted)' }}>Searching…</div>}
            {!searching && !hasResults && <div style={{ padding: '14px', fontSize: '13px', color: 'var(--text-muted)' }}>No matches.</div>}
            {!searching && results.customers.length > 0 && (
              <SearchGroup label="Customers" icon={Users}>
                {results.customers.map((c) => (
                  <SearchRow key={c.id} onClick={() => goTo(`/customers/${c.id}`)}
                    title={c.business_name || c.name} subtitle={`${c.customer_number}${c.zone_name ? ` — ${c.zone_name}` : ''}`} />
                ))}
              </SearchGroup>
            )}
            {!searching && results.invoices.length > 0 && (
              <SearchGroup label="Invoices" icon={Receipt}>
                {results.invoices.map((i) => (
                  <SearchRow key={i.id} onClick={() => goTo(`/financial/invoices/${i.id}`)}
                    title={i.invoice_number} subtitle={`${i.customer_name} — $${parseFloat(i.invoice_total).toFixed(2)} (${i.status})`} />
                ))}
              </SearchGroup>
            )}
            {!searching && results.employees.length > 0 && (
              <SearchGroup label="Employees" icon={Users2}>
                {results.employees.map((e) => (
                  <SearchRow key={e.id} onClick={() => goTo(`/employees/${e.id}`)}
                    title={e.name} subtitle={`${e.job_role || e.employee_type}${e.zone_name ? ` — ${e.zone_name}` : ''}`} />
                ))}
              </SearchGroup>
            )}
          </div>
        )}
      </div>

      <div style={{ flex: 1 }} />

      {/* Notifications + Language + Theme */}
      <NotificationBell />
      <LanguageToggle />
      <ThemeToggle />

      {/* Profile */}
      <div ref={profileRef} style={{ position: 'relative' }}>
        <button
          onClick={() => setProfileOpen((v) => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px 4px 4px', borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border)', background: 'var(--bg)', cursor: 'pointer',
          }}
        >
          <Avatar name={user?.full_name || user?.username} size={28} version={avatarVersion} />
          <span style={{ fontSize: '13px', fontWeight: 700, maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user?.full_name || user?.username}
          </span>
          <ChevronDown size={14} color="var(--text-muted)" />
        </button>

        {profileOpen && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: '220px',
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', zIndex: 90,
            padding: '6px', display: 'flex', flexDirection: 'column', gap: '2px',
          }}>
            <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border)', marginBottom: '4px' }}>
              <div style={{ fontSize: '13px', fontWeight: 700 }}>{user?.full_name || user?.username}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'capitalize' }}>{user?.role}{user?.zone ? ` — ${user.zone}` : ''}</div>
            </div>
            <MenuItem icon={Camera} label={uploadAvatar.isPending ? t('topbar.uploading') : t('topbar.changePhoto')} onClick={() => fileInputRef.current?.click()} disabled={uploadAvatar.isPending} />
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg" onChange={handlePhotoChange} style={{ display: 'none' }} />
            <MenuItem icon={ShieldCheck} label={t('nav.accountSecurity')} onClick={() => { setProfileOpen(false); navigate('/account/security'); }} />
            <MenuItem icon={UserCircle2} label={t('nav.myHr')} onClick={() => { setProfileOpen(false); navigate('/account/my-hr'); }} />
            <div style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
            <MenuItem icon={LogOut} label={t('nav.logout')} onClick={() => { setProfileOpen(false); logout(); navigate('/login'); }} danger />
          </div>
        )}
      </div>
    </header>
  );
}

function SearchGroup({ label, icon: Icon, children }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 12px 4px', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>
        <Icon size={12} /> {label}
      </div>
      {children}
    </div>
  );
}

function SearchRow({ title, subtitle, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{ padding: '8px 12px', cursor: 'pointer', fontSize: '13px' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{ fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{subtitle}</div>
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: '9px', width: '100%', padding: '8px 10px', borderRadius: 'var(--radius-sm)',
        border: 'none', background: 'none', cursor: disabled ? 'default' : 'pointer', fontSize: '13px', fontWeight: 600, textAlign: 'left',
        color: danger ? 'var(--danger)' : 'var(--text)', opacity: disabled ? 0.6 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'var(--bg)'; }}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <Icon size={15} /> {label}
    </button>
  );
}
