import React, { useState } from 'react';
import { Info, Users, CalendarDays, MapPin, StickyNote, Sparkles } from 'lucide-react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import { useCreateRoute, useUpdateRoute } from '../../hooks/useGroups.js';
import { useCreateGroupZone, useUpdateGroupZone } from '../../hooks/useGroupZones.js';
import { useDailyListOptions } from '../../hooks/useDailyLists.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { groupLabel, districtLabel } from '../../lib/hierarchy.js';
import { Field, FormSection, WorkDaysPicker, LatLngInput, StaffSelect, HierarchyPath } from './GroupBits.jsx';
import { TEXT_MAX, latLngOf, parseLatLng, daysOf, hasCenter, nameOrCode, revealFirstError } from './groupUtils.js';
import '../customers/customers.css';
import './groups.css';

// Sub Zone (routes table) create + edit. Sections: Basics, Team, Schedule,
// Start point, Notes — with the Group › District › Zone › Sub Zone path on
// top. On create, work days and the start point are pre-filled from the
// Group's defaults / map center (editable); the server also inherits the
// group's default work days when work_days is omitted.
export function SubZoneFormModal({ group, route, onClose }) {
  const { t } = useI18n();
  const isEdit = !!route;
  const isAdmin = (useAuth().user?.role || '').toLowerCase() === 'admin';
  const zones = group.zones || [];
  const groupDays = daysOf(group.default_work_days);
  const [form, setForm] = useState(() => ({
    code: route?.code || '',
    name: route?.name || '',
    status: route?.status || 'active',
    group_zone_id: route?.group_zone_id ? String(route.group_zone_id) : '',
    collector_user_id: route?.collector_user_id ? String(route.collector_user_id) : '',
    cashier_user_id: route?.cashier_user_id ? String(route.cashier_user_id) : '',
    truck_id: route?.truck_id ? String(route.truck_id) : '',
    work_days: isEdit ? daysOf(route.work_days) : groupDays,
    start: isEdit ? latLngOf(route.start_lat, route.start_lng) : (hasCenter(group) ? latLngOf(group.center_lat, group.center_lng) : { lat: '', lng: '' }),
    description: route?.description || '',
    notes: route?.notes || '',
  }));
  const [prefilled, setPrefilled] = useState(() => ({ days: !isEdit && groupDays.length > 0, start: !isEdit && hasCenter(group) }));
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const create = useCreateRoute();
  const update = useUpdateRoute(route?.id);
  const toast = useToast();
  const busy = create.isPending || update.isPending;
  const { data: optData } = useDailyListOptions(group.zone_id, !!group.zone_id);
  const trucks = optData?.data?.trucks || [];

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    if (field === 'work_days') setPrefilled((p) => ({ ...p, days: false }));
    if (field === 'start') setPrefilled((p) => ({ ...p, start: false }));
    setErrors((e) => {
      const n = { ...e, [field]: undefined };
      if (field === 'collector_user_id' || field === 'work_days') n.work_days = undefined;
      return n;
    });
    setFormError('');
  }

  function validate() {
    const errs = {};
    if (!form.code.trim()) errs.code = t('group.route_code_is_required');
    else if (form.code.trim().length > 30) errs.code = t('gv.err.codeLen');
    if (form.collector_user_id && form.work_days.length === 0) errs.work_days = t('subzone.workDaysRequired');
    if (!parseLatLng(form.start)) errs.start = t('subzone.startInvalid');
    if (form.description.length > TEXT_MAX) errs.description = t('gv.err.tooLong', undefined, { n: TEXT_MAX });
    if (form.notes.length > TEXT_MAX) errs.notes = t('gv.err.tooLong', undefined, { n: TEXT_MAX });
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validate()) { setFormError(t('gv.err.fixFields')); revealFirstError('subzone-form'); return; }
    const sp = parseLatLng(form.start);
    const id = (v) => (v ? parseInt(v, 10) : null);
    const payload = {
      code: form.code.trim(), name: form.name.trim() || null,
      group_zone_id: id(form.group_zone_id), collector_user_id: id(form.collector_user_id), cashier_user_id: id(form.cashier_user_id),
      truck_id: id(form.truck_id), work_days: form.work_days, start_lat: sp.lat, start_lng: sp.lng,
      description: form.description.trim() || null, notes: form.notes.trim() || null,
    };
    try {
      if (isEdit) {
        await update.mutateAsync({ ...payload, status: form.status });
        toast.success(t('group.route_updated'));
      } else {
        await create.mutateAsync({ ...payload, group_id: group.id });
        toast.success(t('fin.m.created', undefined, { number: payload.code }));
      }
      onClose();
    } catch (err) {
      setFormError(err.message || t('common.somethingWrong'));
    }
  }

  const zone = zones.find((z) => String(z.id) === form.group_zone_id);
  const hasCurrentTruck = !form.truck_id || trucks.some((tk) => String(tk.id) === form.truck_id);

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={isEdit ? t('gv.editSubZone') : t('gv.addSubZone')}
      maxWidth="680px"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button type="submit" form="subzone-form" disabled={busy}>{busy ? t('common.saving') : t('group.save_changes')}</Button>
      </>}
    >
      <form id="subzone-form" className="gv-form" onSubmit={handleSubmit} noValidate>
        <HierarchyPath parts={[
          { value: groupLabel(group.code, group.name) },
          { value: districtLabel(group.zone_name) },
          { value: zone ? nameOrCode(zone.name, zone.code) : t('group.no_zone', 'No zone') },
          { value: form.code.trim() || t('gv.newSubZone'), isNew: true },
        ]} />

        <FormSection icon={Info} title={t('gv.sec.basics')}>
          <div className="gv-grid2">
            <Field label={t('gv.subZoneCode')} required error={errors.code}>
              <input className="cl-input" value={form.code} onChange={(e) => set('code', e.target.value)} maxLength={30} placeholder="Sub Zone 1" />
            </Field>
            <Field label={t('group.name_optional')}>
              <input className="cl-input" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={100} />
            </Field>
          </div>
          <div className="gv-grid2">
            <Field label={t('group.zone', 'Zone')}>
              <select className="cl-input" value={form.group_zone_id} onChange={(e) => set('group_zone_id', e.target.value)}>
                <option value="">{t('group.no_zone', 'No zone')}</option>
                {zones.filter((z) => z.status === 'active' || String(z.id) === form.group_zone_id).map((z) => <option key={z.id} value={String(z.id)}>{nameOrCode(z.name, z.code)}</option>)}
              </select>
            </Field>
            {isEdit && (
              <Field label={t('common.status')} hint={form.status === 'inactive' ? t('gv.subZoneInactiveHint') : undefined}>
                <select className="cl-input" value={form.status} onChange={(e) => set('status', e.target.value)}>
                  <option value="active">{t('status.active')}</option>
                  <option value="inactive">{t('status.inactive')}</option>
                </select>
              </Field>
            )}
          </div>
          <Field label={t('gv.description')} hint={t('gv.subZoneDescriptionHint')} error={errors.description} count={form.description.length} max={TEXT_MAX}>
            <textarea className="cl-input" rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={TEXT_MAX} />
          </Field>
        </FormSection>

        <FormSection icon={Users} title={t('gv.sec.team')}>
          <div className="gv-grid2">
            <Field label={t('group.collector', 'Collector')} group={!isAdmin}>
              <StaffSelect value={form.collector_user_id} onChange={(v) => set('collector_user_id', v)} roles={['collector']} districtName={group.zone_name}
                currentName={route?.collector_name} placeholder={t('group.unassigned', 'Unassigned')} ariaLabel={t('group.collector', 'Collector')} />
            </Field>
            <Field label={t('subzone.cashier', 'Cashier')} group={!isAdmin} hint={t('subzone.cashierHint')}>
              <StaffSelect value={form.cashier_user_id} onChange={(v) => set('cashier_user_id', v)} roles={['cashier']} districtName={group.zone_name}
                currentName={route?.cashier_name} placeholder={t('group.unassigned', 'Unassigned')} ariaLabel={t('subzone.cashier', 'Cashier')} />
            </Field>
          </div>
          <Field label={t('subzone.defaultTruck')}>
            <select className="cl-input" value={form.truck_id} onChange={(e) => set('truck_id', e.target.value)}>
              <option value="">{t('subzone.noTruck')}</option>
              {!hasCurrentTruck && <option value={form.truck_id}>{route?.truck_plate || `#${form.truck_id}`}</option>}
              {trucks.map((tk) => <option key={tk.id} value={String(tk.id)}>{tk.plate_number}{tk.model ? ` — ${tk.model}` : ''}</option>)}
            </select>
          </Field>
        </FormSection>

        <FormSection icon={CalendarDays} title={t('gv.sec.schedule')}>
          <Field label={t('subzone.workDays')} required={!!form.collector_user_id} group error={errors.work_days}
            hint={prefilled.days ? undefined : t('gv.workDaysHint')}>
            <WorkDaysPicker value={form.work_days} onChange={(v) => set('work_days', v)} invalid={!!errors.work_days} />
            {prefilled.days && <span className="gv-prefill"><Sparkles size={12} /> {t('gv.fromGroupDefaults')}</span>}
          </Field>
        </FormSection>

        <FormSection icon={MapPin} title={t('subzone.startPoint')}>
          <Field label={t('gv.startLatLng')} group error={errors.start} hint={prefilled.start ? undefined : t('subzone.startPointHint')}>
            <LatLngInput value={form.start} onChange={(v) => set('start', v)} invalid={!!errors.start} />
            {prefilled.start && <span className="gv-prefill"><Sparkles size={12} /> {t('gv.fromGroupCenter')}</span>}
          </Field>
        </FormSection>

        <FormSection icon={StickyNote} title={t('gv.sec.notes')}>
          <Field label={t('gv.notes')} error={errors.notes} count={form.notes.length} max={TEXT_MAX}>
            <textarea className="cl-input" rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} maxLength={TEXT_MAX} />
          </Field>
        </FormSection>

        {formError && <div className="gv-formerr" role="alert">{formError}</div>}
      </form>
    </Modal>
  );
}

// Zone (group_zones) create + edit: code, name, status, description, notes.
export function ZoneFormModal({ group, zone, onClose }) {
  const { t } = useI18n();
  const isEdit = !!zone;
  const [form, setForm] = useState({
    code: zone?.code || '', name: zone?.name || '', status: zone?.status || 'active',
    description: zone?.description || '', notes: zone?.notes || '',
  });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const create = useCreateGroupZone();
  const update = useUpdateGroupZone(zone?.id);
  const toast = useToast();
  const busy = create.isPending || update.isPending;

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
    setFormError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const errs = {};
    if (!form.code.trim()) errs.code = t('group.zone_code_required', 'Zone code is required.');
    else if (form.code.trim().length > 30) errs.code = t('gv.err.codeLen');
    if (form.description.length > TEXT_MAX) errs.description = t('gv.err.tooLong', undefined, { n: TEXT_MAX });
    if (form.notes.length > TEXT_MAX) errs.notes = t('gv.err.tooLong', undefined, { n: TEXT_MAX });
    setErrors(errs);
    if (Object.keys(errs).length) { setFormError(t('gv.err.fixFields')); revealFirstError('zone-form'); return; }
    const payload = { code: form.code.trim(), name: form.name.trim() || null, description: form.description.trim() || null, notes: form.notes.trim() || null };
    try {
      if (isEdit) await update.mutateAsync({ ...payload, status: form.status });
      else await create.mutateAsync({ ...payload, group_id: group.id });
      toast.success(isEdit ? t('fin.m.updated', undefined, { name: payload.code }) : t('fin.m.created', undefined, { number: payload.code }));
      onClose();
    } catch (err) {
      setFormError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={isEdit ? t('group.edit_zone', 'Edit Zone') : t('group.add_zone', 'Add Zone')}
      maxWidth="600px"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button type="submit" form="zone-form" disabled={busy}>{busy ? t('common.saving') : t('group.save_changes')}</Button>
      </>}
    >
      <form id="zone-form" className="gv-form" onSubmit={handleSubmit} noValidate>
        <HierarchyPath parts={[
          { value: groupLabel(group.code, group.name) },
          { value: districtLabel(group.zone_name) },
          { value: form.code.trim() || t('gv.newZone'), isNew: true },
        ]} />
        <FormSection icon={Info} title={t('gv.sec.basics')}>
          <div className="gv-grid2">
            <Field label={t('gv.zoneCode')} required error={errors.code}>
              <input className="cl-input" value={form.code} onChange={(e) => set('code', e.target.value)} maxLength={30} placeholder="Zone A" />
            </Field>
            <Field label={t('group.name_optional')}>
              <input className="cl-input" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={100} />
            </Field>
          </div>
          {isEdit && (
            <Field label={t('common.status')}>
              <select className="cl-input" value={form.status} onChange={(e) => set('status', e.target.value)}>
                <option value="active">{t('status.active')}</option>
                <option value="inactive">{t('status.inactive')}</option>
              </select>
            </Field>
          )}
          <Field label={t('gv.description')} hint={t('gv.zoneDescriptionHint')} error={errors.description} count={form.description.length} max={TEXT_MAX}>
            <textarea className="cl-input" rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={TEXT_MAX} />
          </Field>
        </FormSection>
        <FormSection icon={StickyNote} title={t('gv.sec.notes')}>
          <Field label={t('gv.notes')} error={errors.notes} count={form.notes.length} max={TEXT_MAX}>
            <textarea className="cl-input" rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} maxLength={TEXT_MAX} />
          </Field>
        </FormSection>
        {formError && <div className="gv-formerr" role="alert">{formError}</div>}
      </form>
    </Modal>
  );
}
