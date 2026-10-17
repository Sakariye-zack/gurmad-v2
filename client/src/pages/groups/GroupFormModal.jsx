import React, { useState } from 'react';
import { Modal, Button, useToast } from '../../components/ui/index.js';
import { useCreateGroup, useUpdateGroup } from '../../hooks/useGroups.js';
import { useZonesList } from '../../hooks/useCustomers.js';
import { useI18n } from '../../i18n/I18nContext.jsx';

const EMPTY = { zone_id: '', code: '', name: '', status: 'active' };

function toFormState(group) {
  return group ? {
    zone_id: String(group.zone_id || ''),
    code: group.code || '',
    name: group.name || '',
    status: group.status || 'active',
  } : EMPTY;
}

// Create Group + Edit Group — Group & Group-Based Collection CR, Spec §8/§22.
// zone_id is fixed (not editable) once the group exists — moving a Group to
// a different Zone is a materially different, undecided operation (Spec
// §26, non-blocking item), so the field is simply disabled on edit rather
// than silently allowed.
export default function GroupFormModal({ open, onClose, group, defaultZoneId }) {
  if (!open) return null;
  return <GroupFormModalContent onClose={onClose} group={group} defaultZoneId={defaultZoneId} />;
}

function GroupFormModalContent({ onClose, group, defaultZoneId }) {
  const { t } = useI18n();
  const isEdit = !!group;
  const [form, setForm] = useState(() => {
    const base = toFormState(group);
    if (!isEdit && defaultZoneId) base.zone_id = String(defaultZoneId);
    return base;
  });
  const [fieldErrors, setFieldErrors] = useState({});
  const toast = useToast();
  const { data: zonesData } = useZonesList();
  const zones = zonesData?.data || [];
  const createGroup = useCreateGroup();
  const updateGroup = useUpdateGroup(group?.id);
  const busy = createGroup.isPending || updateGroup.isPending;

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function validate() {
    const errs = {};
    if (!isEdit && !form.zone_id) errs.zone_id = 'Zone is required.';
    if (!form.code.trim()) errs.code = 'Code is required.';
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validate()) return;
    try {
      if (isEdit) {
        await updateGroup.mutateAsync({ code: form.code.trim(), name: form.name.trim() || null, status: form.status });
        toast.success(t('fin.m.updated', undefined, { name: form.code }));
      } else {
        await createGroup.mutateAsync({ zone_id: parseInt(form.zone_id, 10), code: form.code.trim(), name: form.name.trim() || null });
        toast.success(t('fin.m.created', undefined, { number: form.code }));
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
      title={isEdit ? t('group.edit_group') : t('group.create_group')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button type="submit" form="group-form" disabled={busy}>{busy ? t('common.saving') : t('group.save_group')}</Button>
        </>
      }
    >
      <form id="group-form" onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <Field label={t('common.zone')} error={fieldErrors.zone_id} hint={isEdit ? t('group.zone_cannot_be_changed_after') : undefined}>
          <select value={form.zone_id} onChange={(e) => set('zone_id', e.target.value)} style={inputStyle} disabled={isEdit}>
            <option value="">{t('cust.select_a_zone')}</option>
            {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
        </Field>
        <Field label={t('group.group_code')} error={fieldErrors.code} hint="e.g. Group 07 — unique within its zone.">
          <input value={form.code} onChange={(e) => set('code', e.target.value)} style={inputStyle} />
        </Field>
        <Field label={t('group.name_optional')}>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} style={inputStyle} />
        </Field>
        {isEdit && (
          <Field label={t('common.status')}>
            <select value={form.status} onChange={(e) => set('status', e.target.value)} style={inputStyle}>
              <option value="active">{t('status.active')}</option>
              <option value="inactive">{t('status.inactive')}</option>
            </select>
          </Field>
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
