import React, { useEffect, useState } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { PageHeader, Button, Card, LoadingState, ErrorState, useToast } from '../../components/ui/index.js';
import { useCompanySettings, useUpdateCompanySettings, useUpdateCompanyLogo } from '../../hooks/useSettings.js';
import { apiClient } from '../../lib/apiClient.js';

// System Settings — Phase 1 (Company Settings). Admin-only (Sidebar/router
// gate this page; the backend independently re-enforces it — frontend
// gating is never authoritative on its own). Exactly one section — Company
// Information — per the approved scope. No Finance/Collection/Security/
// Notifications/Mapbox section is rendered, not even as a placeholder.
const TIMEZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

export default function SettingsPage() {
  const { data, isLoading, error, refetch } = useCompanySettings();
  const settings = data?.data;
  const updateSettings = useUpdateCompanySettings();
  const updateLogo = useUpdateCompanyLogo();
  const toast = useToast();

  const [form, setForm] = useState({ company_name: '', address: '', phone: '', email: '', timezone: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [logoFile, setLogoFile] = useState(null);
  const [logoPreviewUrl, setLogoPreviewUrl] = useState(null);
  const [logoError, setLogoError] = useState('');

  useEffect(() => {
    if (settings) {
      setForm({
        company_name: settings.company_name || '', address: settings.address || '',
        phone: settings.phone || '', email: settings.email || '', timezone: settings.timezone || '',
      });
    }
  }, [settings]);

  useEffect(() => {
    let revoked = false;
    let url = null;
    if (settings?.logo_url) {
      apiClient.fetchAuthorizedFileUrl(settings.logo_url).then((u) => {
        if (!revoked) { url = u; setLogoPreviewUrl(u); }
      }).catch(() => {});
    } else {
      setLogoPreviewUrl(null);
    }
    return () => { revoked = true; if (url) URL.revokeObjectURL(url); };
  }, [settings?.logo_url]);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function validate() {
    const errs = {};
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errs.email = 'Enter a valid email address.';
    if (form.timezone && !TIMEZONES.includes(form.timezone) && TIMEZONES.length > 0) errs.timezone = 'Select a valid timezone.';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!validate()) return;
    try {
      await updateSettings.mutateAsync({
        company_name: form.company_name.trim() || null,
        address: form.address.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        timezone: form.timezone || null,
      });
      toast.success('Company settings saved.');
    } catch (err) {
      toast.error(err.message || 'Failed to save company settings.');
    }
  }

  async function handleLogoUpload() {
    if (!logoFile) return;
    setLogoError('');
    try {
      await updateLogo.mutateAsync(logoFile);
      toast.success('Logo updated.');
      setLogoFile(null);
    } catch (err) {
      setLogoError(err.message || 'Failed to upload logo.');
    }
  }

  if (isLoading) return <LoadingState label="Loading company settings…" />;
  if (error) return <ErrorState message={error.message} onRetry={refetch} />;

  return (
    <div>
      <PageHeader icon={SettingsIcon} title="System Settings" subtitle="Company-wide configuration — Admin only." />

      {!settings && (
        <Card style={{ padding: '16px', marginBottom: '16px' }}>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '13px' }}>
            Company information has not been configured yet.
          </p>
        </Card>
      )}

      <Card style={{ padding: '20px' }}>
        <span style={sectionLabelStyle}>Company Information</span>
        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '12px' }}>
          <Field label="Company name">
            <input value={form.company_name} onChange={(e) => set('company_name', e.target.value)} style={inputStyle} maxLength={150} />
          </Field>
          <Field label="Address">
            <textarea value={form.address} onChange={(e) => set('address', e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} maxLength={2000} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <Field label="Phone">
              <input value={form.phone} onChange={(e) => set('phone', e.target.value)} style={inputStyle} maxLength={20} />
            </Field>
            <Field label="Email" error={fieldErrors.email}>
              <input value={form.email} onChange={(e) => set('email', e.target.value)} style={inputStyle} />
            </Field>
          </div>
          <Field label="Timezone" error={fieldErrors.timezone}>
            <select value={form.timezone} onChange={(e) => set('timezone', e.target.value)} style={inputStyle}>
              <option value="">Not set</option>
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </Field>

          <Field label="Logo">
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
              {logoPreviewUrl && (
                <img src={logoPreviewUrl} alt="Company logo" style={{ width: '64px', height: '64px', objectFit: 'contain', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--surface)' }} />
              )}
              <input
                type="file" accept="image/png,image/jpeg" capture="environment"
                onChange={(e) => setLogoFile(e.target.files?.[0] || null)}
                style={{ ...inputStyle, width: 'auto', flex: '1 1 200px' }}
              />
              <Button type="button" variant="secondary" onClick={handleLogoUpload} disabled={!logoFile || updateLogo.isPending}>
                {updateLogo.isPending ? 'Uploading…' : 'Upload Logo'}
              </Button>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', display: 'block' }}>PNG or JPEG, up to 2MB.</span>
            {logoError && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{logoError}</span>}
          </Field>

          <div>
            <Button type="submit" disabled={updateSettings.isPending}>{updateSettings.isPending ? 'Saving…' : 'Save Company Information'}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function Field({ label, error, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '12px', fontWeight: 700 }}>{label}</span>
      {children}
      {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
    </label>
  );
}

const sectionLabelStyle = {
  display: 'block', fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)',
};
const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit', boxSizing: 'border-box',
};
