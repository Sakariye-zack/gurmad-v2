import React, { useState } from 'react';
import { Info, UserRound, MapPin, SlidersHorizontal, StickyNote, AlertTriangle } from 'lucide-react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import { useCreateGroup, useUpdateGroup } from '../../hooks/useGroups.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { districtLabel } from '../../lib/hierarchy.js';
import { Field, FormSection, WorkDaysPicker, LatLngInput, StaffSelect } from './GroupBits.jsx';
import { LEADER_ROLES, TEXT_MAX, latLngOf, parseLatLng, daysOf, revealFirstError } from './groupUtils.js';
import '../customers/customers.css';
import './groups.css';

function toFormState(group) {
  return {
    zone_id: group?.zone_id ? String(group.zone_id) : '',
    code: group?.code || '',
    name: group?.name || '',
    status: group?.status || 'active',
    leader_user_id: group?.leader_user_id ? String(group.leader_user_id) : '',
    description: group?.description || '',
    center: latLngOf(group?.center_lat, group?.center_lng),
    default_work_days: daysOf(group?.default_work_days),
    default_billing_type: group?.default_billing_type || '',
    default_fee_currency: group?.default_fee_currency || '',
    default_fee: group?.default_fee != null ? String(Number(group.default_fee)) : '',
    notes: group?.notes || '',
  };
}

// Create Group + Edit Group (Groups V2): Basics, Leader, Area on map,
// Defaults for new Sub Zones and customers, Notes. The district is fixed
// once the group exists (moving a Group is a different, undecided
// operation), so the field is disabled on edit with its hint.
export default function GroupFormModal({ open, onClose, group, defaultZoneId }) {
  if (!open) return null;
  return <GroupFormModalContent onClose={onClose} group={group} defaultZoneId={defaultZoneId} />;
}

function GroupFormModalContent({ onClose, group, defaultZoneId }) {
  const { t } = useI18n();
  const isEdit = !!group;
  const isAdmin = (useAuth().user?.role || '').toLowerCase() === 'admin';
  const [form, setForm] = useState(() => {
    const base = toFormState(group);
    if (!isEdit && defaultZoneId) base.zone_id = String(defaultZoneId);
    return base;
  });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [confirmInactive, setConfirmInactive] = useState(false);
  const toast = useToast();
  const { data: zonesData } = useZonesList();
  const zones = zonesData?.data || [];
  const createGroup = useCreateGroup();
  const updateGroup = useUpdateGroup(group?.id);
  const busy = createGroup.isPending || updateGroup.isPending;
  const districtName = zones.find((z) => String(z.id) === form.zone_id)?.name || group?.zone_name || '';

  const counts = group?.counts;
  const goingInactive = isEdit && group.status === 'active' && form.status === 'inactive';
  const stopSubZones = counts?.active_sub_zones ?? 0;
  const stopCustomers = counts?.customers_in_active_subzones ?? 0;
  const needsConfirm = goingInactive && (stopSubZones > 0 || (counts?.customers ?? 0) > 0);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
    setFormError('');
  }

  function validate() {
    const errs = {};
    if (!isEdit && !form.zone_id) errs.zone_id = t('gv.err.district');
    if (!form.code.trim()) errs.code = t('gv.err.code');
    else if (form.code.trim().length > 30) errs.code = t('gv.err.codeLen');
    if (!parseLatLng(form.center)) errs.center = t('subzone.startInvalid');
    if (form.default_fee !== '' && (!Number.isFinite(Number(form.default_fee)) || Number(form.default_fee) < 0)) errs.default_fee = t('gv.err.fee');
    if (form.description.length > TEXT_MAX) errs.description = t('gv.err.tooLong', undefined, { n: TEXT_MAX });
    if (form.notes.length > TEXT_MAX) errs.notes = t('gv.err.tooLong', undefined, { n: TEXT_MAX });
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validate()) { setFormError(t('gv.err.fixFields')); revealFirstError('group-form'); return; }
    if (needsConfirm && !confirmInactive) { setFormError(t('gv.inactive.confirmFirst')); return; }
    const center = parseLatLng(form.center);
    const payload = {
      code: form.code.trim(),
      name: form.name.trim() || null,
      description: form.description.trim() || null,
      center_lat: center.lat,
      center_lng: center.lng,
      default_work_days: form.default_work_days,
      default_billing_type: form.default_billing_type || null,
      default_fee_currency: form.default_fee_currency || null,
      default_fee: form.default_fee === '' ? null : Number(form.default_fee),
      notes: form.notes.trim() || null,
      ...(isAdmin ? { leader_user_id: form.leader_user_id ? parseInt(form.leader_user_id, 10) : null } : {}),
    };
    try {
      if (isEdit) {
        await updateGroup.mutateAsync({ ...payload, status: form.status });
        toast.success(t('fin.m.updated', undefined, { name: form.code }));
      } else {
        await createGroup.mutateAsync({ ...payload, zone_id: parseInt(form.zone_id, 10) });
        toast.success(t('fin.m.created', undefined, { number: form.code }));
      }
      onClose();
    } catch (err) {
      setFormError(err.message || t('common.somethingWrong'));
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={isEdit ? t('group.edit_group') : t('group.create_group')}
      maxWidth="680px"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button type="submit" form="group-form" disabled={busy || (needsConfirm && !confirmInactive)}>{busy ? t('common.saving') : t('group.save_group')}</Button>
        </>
      }
    >
      <form id="group-form" className="gv-form" onSubmit={handleSubmit} noValidate>
        {isEdit && counts && (
          <div>
            <p className="gv-kpi-label">{t('gv.impact.title')}</p>
            <div className="gv-impact">
              <Impact k={t('nav.customers')} v={counts.customers} />
              <Impact k={t('gv.zones')} v={counts.zones} />
              <Impact k={t('gv.subZones')} v={counts.sub_zones} />
              <Impact k={t('gv.collectors')} v={counts.collectors} />
              <Impact k={t('gv.cashiers')} v={counts.cashiers} />
            </div>
          </div>
        )}

        <FormSection icon={Info} title={t('gv.sec.basics')}>
          <div className="gv-grid2">
            <Field label={t('gv.district')} required={!isEdit} error={errors.zone_id} hint={isEdit ? t('group.zone_cannot_be_changed_after') : t('gv.districtHint')}>
              <select className="cl-input" value={form.zone_id} onChange={(e) => set('zone_id', e.target.value)} disabled={isEdit}>
                <option value="">{t('cust.select_a_zone')}</option>
                {zones.map((z) => <option key={z.id} value={z.id}>{districtLabel(z.name)}</option>)}
              </select>
            </Field>
            {isEdit && (
              <Field label={t('common.status')}>
                <select className="cl-input" value={form.status} onChange={(e) => { set('status', e.target.value); setConfirmInactive(false); }}>
                  <option value="active">{t('status.active')}</option>
                  <option value="inactive">{t('status.inactive')}</option>
                </select>
              </Field>
            )}
          </div>
          {needsConfirm && (
            <div className="gv-warn" role="alert">
              <AlertTriangle size={18} />
              <div>
                <strong>{t('gv.inactive.title')}</strong>
                {t('gv.inactive.body', undefined, { s: stopSubZones, c: stopCustomers })}
                <label>
                  <input type="checkbox" checked={confirmInactive} onChange={(e) => { setConfirmInactive(e.target.checked); setFormError(''); }} />
                  {t('gv.inactive.confirm')}
                </label>
              </div>
            </div>
          )}
          <div className="gv-grid2">
            <Field label={t('group.group_code')} required error={errors.code} hint={t('gv.codeHint')}>
              <input className="cl-input" value={form.code} onChange={(e) => set('code', e.target.value)} maxLength={30} placeholder="Group 07" />
            </Field>
            <Field label={t('group.name_optional')} hint={t('gv.nameHint')}>
              <input className="cl-input" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={100} placeholder="Baarsiigo" />
            </Field>
          </div>
          <Field label={t('gv.description')} hint={t('gv.descriptionHint')} error={errors.description} count={form.description.length} max={TEXT_MAX}>
            <textarea className="cl-input" rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} maxLength={TEXT_MAX} />
          </Field>
        </FormSection>

        <FormSection icon={UserRound} title={t('gv.sec.leader')} intro={t('gv.leaderIntro')}>
          <Field label={t('gv.leader')} group={!isAdmin} hint={isAdmin ? t('gv.leaderHint') : t('gv.leaderAdminOnly')}>
            <StaffSelect
              value={form.leader_user_id}
              onChange={(v) => set('leader_user_id', v)}
              roles={LEADER_ROLES}
              districtName={districtName}
              allowCompanyWide
              showRole
              currentName={group?.leader_name}
              placeholder={t('gv.noLeader')}
              ariaLabel={t('gv.leader')}
            />
          </Field>
        </FormSection>

        <FormSection icon={MapPin} title={t('gv.sec.area')} intro={t('gv.areaIntro')}>
          <Field label={t('gv.center')} group error={errors.center} hint={t('gv.centerHint')}>
            <LatLngInput value={form.center} onChange={(v) => set('center', v)} invalid={!!errors.center} />
          </Field>
        </FormSection>

        <FormSection icon={SlidersHorizontal} title={t('gv.sec.defaults')} intro={t('gv.defaultsIntro')}>
          <Field label={t('gv.defaultWorkDays')} group hint={t('gv.defaultWorkDaysHint')}>
            <WorkDaysPicker value={form.default_work_days} onChange={(v) => set('default_work_days', v)} />
          </Field>
          <div className="gv-grid3">
            <Field label={t('cust.billing_type')}>
              <select className="cl-input" value={form.default_billing_type} onChange={(e) => set('default_billing_type', e.target.value)}>
                <option value="">{t('gv.notSet')}</option>
                <option value="monthly">{t('cust.billing_monthly')}</option>
                <option value="daily">{t('cust.billing_daily')}</option>
              </select>
            </Field>
            <Field label={t('cust.fee_currency')}>
              <select className="cl-input" value={form.default_fee_currency} onChange={(e) => set('default_fee_currency', e.target.value)}>
                <option value="">{t('gv.notSet')}</option>
                <option value="USD">USD ($)</option>
                <option value="SLSH">SLSH</option>
              </select>
            </Field>
            <Field label={t('gv.defaultFee')} error={errors.default_fee}>
              <input className="cl-input" type="number" min="0" step={form.default_fee_currency === 'SLSH' ? '1' : '0.01'} inputMode="decimal" value={form.default_fee} onChange={(e) => set('default_fee', e.target.value)} placeholder={form.default_fee_currency === 'SLSH' ? '30000' : '5'} />
            </Field>
          </div>
          <span className="gv-hint">{t('gv.defaultsCustomerHint')}</span>
        </FormSection>

        <FormSection icon={StickyNote} title={t('gv.sec.notes')}>
          <Field label={t('gv.notes')} hint={t('gv.notesHint')} error={errors.notes} count={form.notes.length} max={TEXT_MAX}>
            <textarea className="cl-input" rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} maxLength={TEXT_MAX} />
          </Field>
        </FormSection>

        {formError && <div className="gv-formerr" role="alert">{formError}</div>}
      </form>
    </Modal>
  );
}

function Impact({ k, v }) {
  return <div><div className="k">{k}</div><div className="v">{v ?? 0}</div></div>;
}
