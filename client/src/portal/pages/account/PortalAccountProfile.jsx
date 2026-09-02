import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { DetailGrid, LoadingState, ErrorState } from '../../../components/ui/index.js';
import PortalPageHeader from '../../components/PortalPageHeader.jsx';
import PortalCard from '../../components/PortalCard.jsx';
import { portalApiClient } from '../../apiClient.js';

// Rebuild — Implementation Spec §21: split from the original PortalProfile.jsx
// into a read-only identity page (this file) and a dedicated Security page
// (PortalAccountSecurity.jsx) — every field the original page showed still
// appears, just regrouped, matching the Discovery's own "content splits,
// not deleted" commitment.
export default function PortalAccountProfile() {
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
      <PortalPageHeader title="My Account" subtitle="Profile and security settings" />
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px', borderBottom: '1px solid var(--border)' }}>
        <NavLink to="/portal/account/profile" end style={({ isActive }) => tabStyle(isActive)}>Profile</NavLink>
        <NavLink to="/portal/account/security" style={({ isActive }) => tabStyle(isActive)}>Security</NavLink>
      </div>

      {loading ? <LoadingState label="Loading profile…" /> : error ? <ErrorState message={error} onRetry={load} /> : profile && (
        <PortalCard>
          <DetailGrid items={[
            { label: 'Customer Number', value: profile.customer_number },
            { label: 'Name', value: profile.business_name || profile.name },
            { label: 'Phone', value: profile.phone },
            { label: 'Zone', value: profile.zone_name },
            { label: 'Address', value: profile.address_line || '—' },
            { label: 'Collection', value: `${profile.collection_frequency || '—'}${profile.collection_mode ? ` (${profile.collection_mode})` : ''}` },
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
