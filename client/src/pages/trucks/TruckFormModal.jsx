import React, { useState } from 'react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import { useCreateTruck, useUpdateTruck, useDriverOptions, useCollectorOptions } from '../../hooks/useTrucks.js';
import { useZonesList } from '../../hooks/useCustomers.js';

const EMPTY = {
  plate_number: '', model: '', capacity: '', zone_id: '', driver_id: '', collector_id: '',
  insurance_expiry: '', registration_expiry: '', road_tax_expiry: '', notes: '',
};

function toFormState(truck) {
  if (!truck) return EMPTY;
  return {
    plate_number: truck.plate_number || '', model: truck.model || '', capacity: truck.capacity ?? '',
    zone_id: truck.zone_id != null ? String(truck.zone_id) : '',
    driver_id: truck.driver_id != null ? String(truck.driver_id) : '',
    collector_id: truck.collector_id != null ? String(truck.collector_id) : '',
    insurance_expiry: truck.insurance_expiry || '', registration_expiry: truck.registration_expiry || '',
    road_tax_expiry: truck.road_tax_expiry || '', notes: truck.notes || '',
  };
}

// Create Truck + Edit Truck — one shared form. Lifecycle status is changed
// via a dedicated action on Truck Detail, not this form, same pattern as
// every prior module. Only mounted while `open` is true.
export default function TruckFormModal({ open, onClose, truck }) {
  if (!open) return null;
  return <Content onClose={onClose} truck={truck} />;
}

function Content({ onClose, truck }) {
  const isEdit = !!truck;
  const [form, setForm] = useState(() => toFormState(truck));
  const [fieldErrors, setFieldErrors] = useState({});
  const toast = useToast();
  const createTruck = useCreateTruck();
  const updateTruck = useUpdateTruck(truck?.id);
  const { data: zonesData } = useZonesList();
  const { data: driversData } = useDriverOptions();
  const { data: collectorsData } = useCollectorOptions();
  const zones = zonesData?.data || [];
  const drivers = driversData?.data || [];
  const collectors = collectorsData?.data || [];
  const busy = createTruck.isPending || updateTruck.isPending;

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function validate() {
    const errs = {};
    if (!form.plate_number.trim()) errs.plate_number = 'Plate number is required.';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validate()) return;

    const payload = {
      plate_number: form.plate_number.trim(), model: form.model.trim() || null,
      capacity: form.capacity === '' ? null : parseInt(form.capacity, 10),
      zone_id: form.zone_id ? parseInt(form.zone_id, 10) : null,
      driver_id: form.driver_id ? parseInt(form.driver_id, 10) : null,
      collector_id: form.collector_id ? parseInt(form.collector_id, 10) : null,
      insurance_expiry: form.insurance_expiry || null,
      registration_expiry: form.registration_expiry || null,
      road_tax_expiry: form.road_tax_expiry || null,
      notes: form.notes.trim() || null,
    };
    try {
      if (isEdit) {
        await updateTruck.mutateAsync(payload);
        toast.success(`${payload.plate_number} updated.`);
      } else {
        await createTruck.mutateAsync(payload);
        toast.success(`${payload.plate_number} created.`);
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
      title={isEdit ? 'Edit Truck' : 'Create Truck'}
      maxWidth="620px"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="truck-form" disabled={busy}>{busy ? 'Saving…' : 'Save Truck'}</Button>
        </>
      }
    >
      <form id="truck-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label="Plate number" error={fieldErrors.plate_number}>
            <input value={form.plate_number} onChange={(e) => set('plate_number', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Model">
            <input value={form.model} onChange={(e) => set('model', e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label="Capacity">
            <input type="number" value={form.capacity} onChange={(e) => set('capacity', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Zone" hint="Optional — leave unset for a company-wide/shared truck.">
            <select value={form.zone_id} onChange={(e) => set('zone_id', e.target.value)} style={inputStyle}>
              <option value="">No zone (company-wide)</option>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label="Driver">
            <select value={form.driver_id} onChange={(e) => set('driver_id', e.target.value)} style={inputStyle}>
              <option value="">Unassigned</option>
              {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label="Collector">
            <select value={form.collector_id} onChange={(e) => set('collector_id', e.target.value)} style={inputStyle}>
              <option value="">Unassigned</option>
              {collectors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        </div>

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '10px', marginTop: '2px' }}>
          <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--text-muted)' }}>
            Compliance
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '14px' }}>
          <Field label="Insurance expiry">
            <input type="date" value={form.insurance_expiry} onChange={(e) => set('insurance_expiry', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Registration expiry">
            <input type="date" value={form.registration_expiry} onChange={(e) => set('registration_expiry', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Road tax expiry">
            <input type="date" value={form.road_tax_expiry} onChange={(e) => set('road_tax_expiry', e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <Field label="Notes">
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} maxLength={2000} />
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
  background: 'var(--surface)', color: 'var(--text)', fontSize: '14px', width: '100%', fontFamily: 'inherit',
};
