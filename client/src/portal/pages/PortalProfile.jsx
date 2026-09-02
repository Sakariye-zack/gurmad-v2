import React, { useEffect, useState } from 'react';
import { Card, DetailGrid, LoadingState, ErrorState, Button, useToast } from '../../components/ui/index.js';
import { portalApiClient } from '../apiClient.js';

export default function PortalProfile() {
  const toast = useToast();
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    portalApiClient.get('/me')
      .then((res) => setProfile(res.data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleChangePassword(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await portalApiClient.put('/me/password', { currentPassword, newPassword });
      toast.success('Password changed successfully.');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading profile…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!profile) return null;

  return (
    <div>
      <h2 style={{ margin: '0 0 16px' }}>My Profile</h2>
      <Card style={{ padding: '16px' }}>
        <DetailGrid items={[
          { label: 'Customer Number', value: profile.customer_number },
          { label: 'Name', value: profile.business_name || profile.name },
          { label: 'Phone', value: profile.phone },
          { label: 'Zone', value: profile.zone_name },
          { label: 'Address', value: profile.address_line || '—' },
          { label: 'Collection', value: `${profile.collection_frequency || '—'}${profile.collection_mode ? ` (${profile.collection_mode})` : ''}` },
        ]} />
      </Card>

      <Card style={{ padding: '16px', marginTop: '16px' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: '14px' }}>Change Password</h3>
        <form onSubmit={handleChangePassword} style={{ maxWidth: '320px' }}>
          <label style={labelStyle}>Current Password</label>
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} style={inputStyle} required />
          <label style={labelStyle}>New Password</label>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={inputStyle} required minLength={8} />
          <Button type="submit" disabled={saving} style={{ marginTop: '14px' }}>{saving ? 'Saving…' : 'Change Password'}</Button>
        </form>
      </Card>
    </div>
  );
}

const labelStyle = { display: 'block', fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', marginTop: '12px', marginBottom: '6px' };
const inputStyle = { width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '14px', boxSizing: 'border-box' };
