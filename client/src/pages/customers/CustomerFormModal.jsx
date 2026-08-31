import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import { useCreateCustomer, useUpdateCustomer, useCheckDuplicate, useZonesList } from '../../hooks/useCustomers.js';

const EMPTY = {
  customer_type: 'residential', name: '', business_name: '', phone: '', alternate_phone: '',
  whatsapp: '', email: '', address_line: '', zone_id: '', sub_zone: '', commercial_shift: '',
  collection_frequency: '', collection_mode: '', fee: '', notes: '',
};

function toFormState(customer) {
  if (!customer) return EMPTY;
  return {
    customer_type: customer.customer_type || 'residential',
    name: customer.name || '', business_name: customer.business_name || '', phone: customer.phone || '',
    alternate_phone: customer.alternate_phone || '', whatsapp: customer.whatsapp || '', email: customer.email || '',
    address_line: customer.address_line || '', zone_id: String(customer.zone_id || ''), sub_zone: customer.sub_zone || '',
    commercial_shift: customer.commercial_shift || '', collection_frequency: customer.collection_frequency || '',
    collection_mode: customer.collection_mode || '', fee: customer.fee ?? '', notes: customer.notes || '',
  };
}

// Create Customer + Edit Customer — one shared form surface (Discovery §15:
// one Customer domain, not two disconnected Residential/Commercial systems
// — customer_type toggles which extra fields render). Only mounted while
// `open` is true, same pattern as ZoneFormModal (clean initial state on
// every open, no setState-in-effect resync).
export default function CustomerFormModal({ open, onClose, customer }) {
  if (!open) return null;
  return <CustomerFormModalContent onClose={onClose} customer={customer} />;
}

function CustomerFormModalContent({ onClose, customer }) {
  const isEdit = !!customer;
  const [form, setForm] = useState(() => toFormState(customer));
  const [fieldErrors, setFieldErrors] = useState({});
  const [duplicateMatches, setDuplicateMatches] = useState(null);
  const [duplicateAcknowledged, setDuplicateAcknowledged] = useState(false);
  const toast = useToast();
  const createCustomer = useCreateCustomer();
  const updateCustomer = useUpdateCustomer(customer?.id);
  const checkDuplicate = useCheckDuplicate();
  const { data: zonesData } = useZonesList();
  const zones = zonesData?.data || [];
  const busy = createCustomer.isPending || updateCustomer.isPending;
  const isCommercial = form.customer_type === 'commercial';

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    if (duplicateMatches) { setDuplicateMatches(null); setDuplicateAcknowledged(false); }
  }

  async function runDuplicateCheck() {
    if (isEdit) return; // duplicate check is a create-time UX aid only
    if (!form.phone && !(isCommercial && form.business_name)) return;
    const result = await checkDuplicate.mutateAsync({
      phone: form.phone, business_name: form.business_name, address_line: form.address_line, customer_type: form.customer_type,
    });
    setDuplicateMatches(result.data || []);
  }

  function validate() {
    const errs = {};
    if (!form.name.trim()) errs.name = 'Name is required.';
    if (!form.phone.trim()) errs.phone = 'Phone is required.';
    if (!form.zone_id) errs.zone_id = 'Zone is required.';
    if (isCommercial && !form.business_name.trim()) errs.business_name = 'Business name is required for commercial customers.';
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errs.email = 'Enter a valid email address.';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validate()) return;

    if (!isEdit && duplicateMatches === null) {
      await runDuplicateCheck();
      return; // show the warning (if any) before actually submitting
    }
    if (!isEdit && duplicateMatches?.length > 0 && !duplicateAcknowledged) {
      toast.error('Please review the possible duplicate above and confirm before continuing.');
      return;
    }

    const payload = {
      customer_type: form.customer_type, name: form.name.trim(), phone: form.phone.trim(),
      zone_id: parseInt(form.zone_id, 10),
      business_name: isCommercial ? form.business_name.trim() : null,
      alternate_phone: form.alternate_phone.trim() || null, whatsapp: form.whatsapp.trim() || null,
      email: form.email.trim() || null, address_line: form.address_line.trim() || null,
      sub_zone: form.sub_zone.trim() || null, commercial_shift: isCommercial ? (form.commercial_shift || null) : null,
      collection_frequency: form.collection_frequency.trim() || null, collection_mode: form.collection_mode.trim() || null,
      fee: form.fee === '' ? null : parseFloat(form.fee), notes: form.notes.trim() || null,
    };
    try {
      if (isEdit) {
        await updateCustomer.mutateAsync(payload);
        toast.success(`${payload.name} updated.`);
      } else {
        const result = await createCustomer.mutateAsync(payload);
        toast.success(`${result.data.customer_number} — ${payload.name} created.`);
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
      title={isEdit ? 'Edit Customer' : 'Create Customer'}
      maxWidth="620px"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" form="customer-form" disabled={busy || checkDuplicate.isPending}>
            {busy ? 'Saving…' : (!isEdit && duplicateMatches === null ? 'Check & Continue' : 'Save Customer')}
          </Button>
        </>
      }
    >
      <form id="customer-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <Field label="Customer type">
          <div style={{ display: 'flex', gap: '8px' }}>
            {['residential', 'commercial'].map((t) => (
              <button
                type="button" key={t}
                onClick={() => set('customer_type', t)}
                style={{
                  flex: 1, padding: '9px', borderRadius: 'var(--radius-sm)', fontWeight: 700, fontSize: '13px', cursor: 'pointer',
                  border: `1px solid ${form.customer_type === t ? 'var(--brand)' : 'var(--border)'}`,
                  background: form.customer_type === t ? 'var(--success-bg)' : 'var(--surface)',
                  color: form.customer_type === t ? 'var(--brand)' : 'var(--text-muted)',
                  textTransform: 'capitalize',
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </Field>

        {isCommercial && (
          <Field label="Business name" error={fieldErrors.business_name}>
            <input value={form.business_name} onChange={(e) => set('business_name', e.target.value)} style={inputStyle} />
          </Field>
        )}

        <Field label={isCommercial ? 'Contact person' : 'Customer name'} error={fieldErrors.name}>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} style={inputStyle} />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label="Phone" error={fieldErrors.phone}>
            <input value={form.phone} onChange={(e) => set('phone', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Alternate phone">
            <input value={form.alternate_phone} onChange={(e) => set('alternate_phone', e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label="WhatsApp">
            <input value={form.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Email" error={fieldErrors.email}>
            <input value={form.email} onChange={(e) => set('email', e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <Field label="Address">
          <input value={form.address_line} onChange={(e) => set('address_line', e.target.value)} style={inputStyle} />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label="Zone" error={fieldErrors.zone_id}>
            <select value={form.zone_id} onChange={(e) => set('zone_id', e.target.value)} style={inputStyle}>
              <option value="">Select a zone…</option>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </Field>
          <Field label="Sub-zone / area">
            <input value={form.sub_zone} onChange={(e) => set('sub_zone', e.target.value)} style={inputStyle} />
          </Field>
        </div>

        {isCommercial && (
          <Field label="Commercial shift">
            <select value={form.commercial_shift} onChange={(e) => set('commercial_shift', e.target.value)} style={inputStyle}>
              <option value="">Not set</option>
              <option value="day">Day</option>
              <option value="night">Night</option>
            </select>
          </Field>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label="Collection frequency">
            <input value={form.collection_frequency} onChange={(e) => set('collection_frequency', e.target.value)} style={inputStyle} placeholder="e.g. Weekly" />
          </Field>
          <Field label="Fee">
            <input type="number" value={form.fee} onChange={(e) => set('fee', e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <Field label="Notes" hint="Optional — operational notes only, not used for identification or authorization.">
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} maxLength={2000} />
        </Field>

        {duplicateMatches && duplicateMatches.length > 0 && (
          <div style={{ display: 'flex', gap: '10px', padding: '12px', borderRadius: 'var(--radius-md)', background: 'var(--warning-bg)', border: '1px solid var(--warning)' }}>
            <AlertTriangle size={18} color="var(--warning)" style={{ flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '13px' }}>
              <strong style={{ color: 'var(--warning)' }}>Possible duplicate customer found.</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
                {duplicateMatches.map((m) => (
                  <li key={m.id}>{m.customer_number} — {m.business_name || m.name} ({m.phone}{m.address_line ? `, ${m.address_line}` : ''})</li>
                ))}
              </ul>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', fontWeight: 700 }}>
                <input type="checkbox" checked={duplicateAcknowledged} onChange={(e) => setDuplicateAcknowledged(e.target.checked)} />
                This is a different customer — continue anyway.
              </label>
            </div>
          </div>
        )}
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
