import React, { useState } from 'react';
import { AlertTriangle, MapPin, LocateFixed } from 'lucide-react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import { useCreateCustomer, useUpdateCustomer, useCheckDuplicate, useZonesList } from '../../hooks/useCustomers.js';
import { useGroups, useRoutesForGroup } from '../../hooks/useGroups.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

const EMPTY = {
  customer_type: 'residential', name: '', business_name: '', phone: '', alternate_phone: '',
  whatsapp: '', email: '', address_line: '', zone_id: '', sub_zone: '', commercial_shift: '',
  collection_frequency: '', collection_mode: '', fee: '', notes: '',
  // Group & Group-Based Collection — Change Request, Spec §6. Both
  // OPTIONAL — a customer can be created/left Zone-only (Locked Decision
  // §26-1: no forced/fake default, no required-field validation added).
  group_id: '', route_id: '',
  // Map location — the backend (routes/customers.js) has always validated
  // and stored lat/lng and the Map page (pages/map/MapPage.jsx) has always
  // read them; this form was the one gap in that chain — a customer could
  // never actually get coordinates through the normal registration flow,
  // only ever via a direct API call. Optional, same as every other field
  // here — a customer with no coordinates simply doesn't plot on the map,
  // not a validation error.
  lat: '', lng: '',
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
    group_id: customer.group_id ? String(customer.group_id) : '', route_id: customer.route_id ? String(customer.route_id) : '',
    lat: customer.lat ?? '', lng: customer.lng ?? '',
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
  const { t } = useI18n();
  const isEdit = !!customer;
  const [form, setForm] = useState(() => toFormState(customer));
  const [fieldErrors, setFieldErrors] = useState({});
  const [duplicateMatches, setDuplicateMatches] = useState(null);
  const [duplicateAcknowledged, setDuplicateAcknowledged] = useState(false);
  const [locating, setLocating] = useState(false);
  const toast = useToast();
  const createCustomer = useCreateCustomer();
  const updateCustomer = useUpdateCustomer(customer?.id);
  const checkDuplicate = useCheckDuplicate();
  const { data: zonesData } = useZonesList();
  const zones = zonesData?.data || [];
  // Group & Group-Based Collection — Change Request, Spec §6: Group scoped
  // to the selected Zone, Route scoped to the selected Group — cascading
  // selectors, same pattern as Zone->Sub-zone already used above.
  const { data: groupsData } = useGroups({ zone_id: form.zone_id || undefined, status: 'active' });
  const groups = form.zone_id ? (groupsData?.data || []) : [];
  const { data: routesData } = useRoutesForGroup(form.group_id || undefined);
  const routes = form.group_id ? (routesData?.data || []).filter((r) => r.status === 'active') : [];
  const busy = createCustomer.isPending || updateCustomer.isPending;
  const isCommercial = form.customer_type === 'commercial';

  function set(field, value) {
    setForm((f) => {
      const next = { ...f, [field]: value };
      // Changing Zone invalidates any previously-selected Group/Route;
      // changing Group invalidates any previously-selected Route — a
      // stale, no-longer-valid selection must never be silently submitted.
      if (field === 'zone_id') { next.group_id = ''; next.route_id = ''; }
      if (field === 'group_id') { next.route_id = ''; }
      return next;
    });
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

  // Captures the DEVICE'S current position — correct only when whoever is
  // filling this form is physically standing at (or very near) the
  // customer's location, e.g. a field registration visit. For office-desk
  // registration the lat/lng inputs below stay directly editable (typed
  // in from a separately-known coordinate, or left blank) rather than
  // forcing this button as the only path in.
  function captureLocation() {
    if (!navigator.geolocation) { toast.error(t('cust.location_is_not_available_on')); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setForm((f) => ({ ...f, lat: String(pos.coords.latitude.toFixed(6)), lng: String(pos.coords.longitude.toFixed(6)) }));
        setLocating(false);
      },
      () => { toast.error(t('cust.could_not_get_your_location')); setLocating(false); },
      { timeout: 10000, enableHighAccuracy: true }
    );
  }

  function validate() {
    const errs = {};
    if (!form.name.trim()) errs.name = 'Name is required.';
    if (!form.phone.trim()) errs.phone = 'Phone is required.';
    if (!form.zone_id) errs.zone_id = 'Zone is required.';
    if (isCommercial && !form.business_name.trim()) errs.business_name = 'Business name is required for commercial customers.';
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errs.email = 'Enter a valid email address.';
    // Same range the backend itself enforces (routes/customers.js) —
    // caught here so a typo doesn't round-trip to the server first.
    if (form.lat !== '' && (Number.isNaN(Number(form.lat)) || Number(form.lat) < -90 || Number(form.lat) > 90)) errs.lat = 'Latitude must be between -90 and 90.';
    if (form.lng !== '' && (Number.isNaN(Number(form.lng)) || Number(form.lng) < -180 || Number(form.lng) > 180)) errs.lng = 'Longitude must be between -180 and 180.';
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
      toast.error(t('cust.please_review_the_possible_duplicate'));
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
      group_id: form.group_id ? parseInt(form.group_id, 10) : null,
      route_id: form.route_id ? parseInt(form.route_id, 10) : null,
      lat: form.lat === '' ? null : parseFloat(form.lat),
      lng: form.lng === '' ? null : parseFloat(form.lng),
    };
    try {
      if (isEdit) {
        await updateCustomer.mutateAsync(payload);
        toast.success(t('fin.m.updated', undefined, { name: payload.name }));
      } else {
        const result = await createCustomer.mutateAsync(payload);
        toast.success(t('cust.m.createdFull', undefined, { number: result.data.customer_number, name: payload.name }));
      }
      onClose();
    } catch (err) {
      toast.error(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={isEdit ? t('cust.edit_customer') : t('cust.create_customer')}
      maxWidth="620px"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button type="submit" form="customer-form" disabled={busy || checkDuplicate.isPending}>
            {busy ? t('common.saving') : (!isEdit && duplicateMatches === null ? t('cust.check_and_continue') : t('cust.save_customer'))}
          </Button>
        </>
      }
    >
      <form id="customer-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <Field label={t('cust.customer_type')}>
          <div style={{ display: 'flex', gap: '8px' }}>
            {['residential', 'commercial'].map((ty) => (
              <button
                type="button" key={ty}
                onClick={() => set('customer_type', ty)}
                style={{
                  flex: 1, padding: '9px', borderRadius: 'var(--radius-sm)', fontWeight: 700, fontSize: '13px', cursor: 'pointer',
                  border: `1px solid ${form.customer_type === ty ? 'var(--brand)' : 'var(--border)'}`,
                  background: form.customer_type === ty ? 'var(--success-bg)' : 'var(--surface)',
                  color: form.customer_type === ty ? 'var(--brand)' : 'var(--text-muted)',
                  textTransform: 'capitalize',
                }}
              >
                {ty === 'all' ? t('cust.all_types') : t('cust.' + ty, ty)}
              </button>
            ))}
          </div>
        </Field>

        {isCommercial && (
          <Field label={t('cust.business_name')} error={fieldErrors.business_name}>
            <input value={form.business_name} onChange={(e) => set('business_name', e.target.value)} style={inputStyle} />
          </Field>
        )}

        <Field label={isCommercial ? t('cust.contact_person') : t('cust.customer_name')} error={fieldErrors.name}>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} style={inputStyle} />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label={t('common.phone')} error={fieldErrors.phone}>
            <input value={form.phone} onChange={(e) => set('phone', e.target.value)} style={inputStyle} />
          </Field>
          <Field label={t('cust.alternate_phone')}>
            <input value={form.alternate_phone} onChange={(e) => set('alternate_phone', e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label={t('cust.whatsapp')}>
            <input value={form.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} style={inputStyle} />
          </Field>
          <Field label={t('cust.email')} error={fieldErrors.email}>
            <input value={form.email} onChange={(e) => set('email', e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <Field label={t('common.address')}>
          <input value={form.address_line} onChange={(e) => set('address_line', e.target.value)} style={inputStyle} />
        </Field>

        {/* Map location — see EMPTY's own comment above for why this
            exists. "Use my current location" only makes sense when
            whoever is filling this form is physically at the customer's
            site; the two inputs stay directly editable either way, so
            office-desk registration from a known coordinate still works. */}
        <Field label={t('cust.map_location_optional')} hint={t('cust.needed_for_this_customer_to')}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <input value={form.lat} onChange={(e) => set('lat', e.target.value)} placeholder={t('cust.latitude')} style={{ ...inputStyle, flex: 1 }} />
            <input value={form.lng} onChange={(e) => set('lng', e.target.value)} placeholder={t('cust.longitude')} style={{ ...inputStyle, flex: 1 }} />
            <Button type="button" variant="secondary" icon={locating ? undefined : LocateFixed} onClick={captureLocation} disabled={locating} style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
              {locating ? t('cust.locating') : t('cust.use_my_location')}
            </Button>
          </div>
          {(fieldErrors.lat || fieldErrors.lng) && (
            <span style={{ fontSize: '11px', color: 'var(--danger)' }}>{fieldErrors.lat || fieldErrors.lng}</span>
          )}
          {form.lat !== '' && form.lng !== '' && (
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
              <MapPin size={11} /> {t('cust.m.willPlot')} {Number(form.lat).toFixed(5)}, {Number(form.lng).toFixed(5)}
            </span>
          )}
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label={t('common.zone')} error={fieldErrors.zone_id}>
            <select value={form.zone_id} onChange={(e) => set('zone_id', e.target.value)} style={inputStyle}>
              <option value="">{t('cust.select_a_zone')}</option>
              {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </Field>
          <Field label={t('cust.sub_zone_area')}>
            <input value={form.sub_zone} onChange={(e) => set('sub_zone', e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label={t('cust.group_optional')} hint={t('cust.not_required_a_customer_can')}>
            <select value={form.group_id} onChange={(e) => set('group_id', e.target.value)} style={inputStyle} disabled={!form.zone_id}>
              <option value="">{form.zone_id ? t('cust.no_group') : t('cust.select_a_zone_first')}</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.code}</option>)}
            </select>
          </Field>
          <Field label={t('cust.route_optional')}>
            <select value={form.route_id} onChange={(e) => set('route_id', e.target.value)} style={inputStyle} disabled={!form.group_id}>
              <option value="">{form.group_id ? t('cust.no_route') : t('cust.select_a_group_first')}</option>
              {routes.map((r) => <option key={r.id} value={r.id}>{r.code}</option>)}
            </select>
          </Field>
        </div>

        {isCommercial && (
          <Field label={t('cust.commercial_shift')}>
            <select value={form.commercial_shift} onChange={(e) => set('commercial_shift', e.target.value)} style={inputStyle}>
              <option value="">{t('cust.not_set')}</option>
              <option value="day">{t('cust.day')}</option>
              <option value="night">{t('cust.night')}</option>
            </select>
          </Field>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <Field label={t('cust.collection_frequency')}>
            <input value={form.collection_frequency} onChange={(e) => set('collection_frequency', e.target.value)} style={inputStyle} placeholder={t('cust.e_g_weekly')} />
          </Field>
          <Field label={t('cust.fee')}>
            <input type="number" value={form.fee} onChange={(e) => set('fee', e.target.value)} style={inputStyle} />
          </Field>
        </div>

        <Field label={t('cust.notes')} hint={t('cust.optional_operational_notes_only_not')}>
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical' }} maxLength={2000} />
        </Field>

        {duplicateMatches && duplicateMatches.length > 0 && (
          <div style={{ display: 'flex', gap: '10px', padding: '12px', borderRadius: 'var(--radius-md)', background: 'var(--warning-bg)', border: '1px solid var(--warning)' }}>
            <AlertTriangle size={18} color="var(--warning)" style={{ flexShrink: 0, marginTop: '2px' }} />
            <div style={{ fontSize: '13px' }}>
              <strong style={{ color: 'var(--warning)' }}>{t('cust.possible_duplicate_customer_found')}</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
                {duplicateMatches.map((m) => (
                  <li key={m.id}>{m.customer_number} — {m.business_name || m.name} ({m.phone}{m.address_line ? `, ${m.address_line}` : ''})</li>
                ))}
              </ul>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', fontWeight: 700 }}>
                <input type="checkbox" checked={duplicateAcknowledged} onChange={(e) => setDuplicateAcknowledged(e.target.checked)} />
                {t('cust.m.differentCustomer')}
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
