import React, { useState } from 'react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import { useCreateZone, useUpdateZone } from '../../hooks/useZones.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const EMPTY = { name: '', zone_code: '', sub_zone: '', area: '', status: 'active', collection_days: [] };

function toFormState(zone) {
  return zone ? {
    name: zone.name || '',
    zone_code: zone.zone_code || '',
    sub_zone: zone.sub_zone || '',
    area: zone.area || '',
    status: zone.status || 'active',
    collection_days: zone.collection_days || [],
  } : EMPTY;
}

// Create Zone + Edit Zone — one shared form surface (Design_System.md §12:
// Modal is the standard interruption pattern), driven by whether `zone` is
// passed. Covers both required Discovery surfaces without duplicating the
// validation/error-handling logic twice.
//
// Only mounted while `open` is true (see the two call sites) — that's what
// gives the form a clean initial state on every open, without a setState-
// in-effect resync.
export default function ZoneFormModal({ open, onClose, zone }) {
  if (!open) return null;
  return <ZoneFormModalContent onClose={onClose} zone={zone} />;
}

function ZoneFormModalContent({ onClose, zone }) {
  const isEdit = !!zone;
  const [form, setForm] = useState(() => toFormState(zone));
  const [fieldErrors, setFieldErrors] = useState({});
  const toast = useToast();
  const createZone = useCreateZone();
  const updateZone = useUpdateZone(zone?.id);
  const busy = createZone.isPending || updateZone.isPending;

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function toggleDay(day) {
    setForm((f) => ({
      ...f,
      collection_days: f.collection_days.includes(day)
        ? f.collection_days.filter((d) => d !== day)
        : [...f.collection_days, day],
    }));
  }

  function validate() {
    const errs = {};
    if (!form.name.trim()) errs.name = 'Name is required.';
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,49}$/.test(form.zone_code.trim())) {
      errs.zone_code = 'Zone code must be 2-50 letters/digits/hyphens.';
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validate()) return;
    const payload = {
      name: form.name.trim(),
      zone_code: form.zone_code.trim().toUpperCase(),
      sub_zone: form.sub_zone.trim() || null,
      area: form.area.trim() || null,
      status: form.status,
      collection_days: form.collection_days,
    };
    try {
      if (isEdit) {
        await updateZone.mutateAsync(payload);
        toast.success(`${payload.name} updated.`);
      } else {
        await createZone.mutateAsync(payload);
        toast.success(`${payload.name} created.`);
      }
      onClose();
    } catch (err) {
      toast.error(err.message || 'Something went wrong.');
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={isEdit ? 'Edit Zone' : 'Create Zone'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="zone-form" disabled={busy}>{busy ? 'Saving…' : 'Save Zone'}</Button>
        </>
      }
    >
      <form id="zone-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <Field label="Zone name" error={fieldErrors.name}>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Zone code" error={fieldErrors.zone_code} hint="Unique, e.g. FARAH-OMAR">
          <input value={form.zone_code} onChange={(e) => set('zone_code', e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Sub-zone">
          <input value={form.sub_zone} onChange={(e) => set('sub_zone', e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Area">
          <input value={form.area} onChange={(e) => set('area', e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Status">
          <select value={form.status} onChange={(e) => set('status', e.target.value)} style={inputStyle}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </Field>
        <Field label="Collection days">
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {DAYS.map((d) => {
              const active = form.collection_days.includes(d);
              return (
                <button
                  type="button"
                  key={d}
                  onClick={() => toggleDay(d)}
                  style={{
                    padding: '6px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                    border: `1px solid ${active ? 'var(--brand)' : 'var(--border)'}`,
                    background: active ? 'var(--success-bg)' : 'var(--surface)',
                    color: active ? 'var(--brand)' : 'var(--text-muted)',
                  }}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </Field>
      </form>
    </Modal>
  );
}

function Field({ label, error, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span style={{ fontSize: '12px', fontWeight: 700 }}>{label}</span>
      {children}
      {hint && !error && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{hint}</span>}
      {error && <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{error}</span>}
    </label>
  );
}

const inputStyle = {
  padding: '9px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%',
};
