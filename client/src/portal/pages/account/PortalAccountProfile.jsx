import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { DetailGrid, LoadingState, ErrorState } from '../../../components/ui/index.js';
import PortalPageHeader from '../../components/PortalPageHeader.jsx';
import PortalCard from '../../components/PortalCard.jsx';
import { portalApiClient } from '../../apiClient.js';
import { useI18n } from '../../../i18n/I18nContext.jsx';

// Rebuild — Implementation Spec §21: split from the original PortalProfile.jsx
// into a read-only identity page (this file) and a dedicated Security page
// (PortalAccountSecurity.jsx) — every field the original page showed still
// appears, just regrouped, matching the Discovery's own "content splits,
// not deleted" commitment.
export default function PortalAccountProfile() {
  const { t } = useI18n();
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    setError(null);
    portalApiClient.get('/me')
      .then((res) => setProfile(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <div>
      <PortalPageHeader title={t('portal.myAccount')} subtitle={t('portal.account.subtitle')} />
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', borderBottom: '1px solid var(--border)' }}>
        <NavLink to="/portal/account/profile" end style={({ isActive }) => tabStyle(isActive)}>{t('portal.account.profile')}</NavLink>
        <NavLink to="/portal/account/security" style={({ isActive }) => tabStyle(isActive)}>{t('portal.account.security')}</NavLink>
      </div>

      {loading ? <LoadingState label={t('portal.account.loadingProfile')} /> : error ? <ErrorState message={error} onRetry={load} /> : profile && (
        <PortalCard>
          <DetailGrid items={[
            { label: t('portal.account.customerNumber'), value: profile.customer_number },
            { label: t('common.name'), value: profile.business_name || profile.name },
            { label: t('common.phone'), value: profile.phone },
            { label: t('common.zone'), value: profile.zone_name },
            { label: t('common.address'), value: profile.address_line || '—' },
            { label: t('portal.account.collection'), value: `${profile.collection_frequency || '—'}${profile.collection_mode ? ` (${profile.collection_mode})` : ''}` },
          ]} />
        </PortalCard>
      )}
    </div>
  );
}

function tabStyle(isActive) {
  return {
    padding: '8px 4px', marginRight: '20px', fontSize: '13px', fontWeight: 700, textDecoration: 'none',
    color: isActive ? 'var(--brand)' : 'var(--text-muted)',
    borderBottom: isActive ? '2px solid var(--brand)' : '2px solid transparent',
  };
}
