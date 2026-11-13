import React, { useState } from 'react';
import { LocateFixed, ChevronRight } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useUsers } from '../../hooks/useUsers.js';
import { WEEK_DAYS, toggleDay, userLabel, daysOf } from './groupUtils.js';

// Groups V2 — small building blocks shared by the Group / Zone / Sub Zone
// forms and the Groups pages (styles in groups.css + customers.css).

export function Field({ label, required, hint, error, count, max, group, children }) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag className={`gv-field${error ? ' invalid' : ''}`}>
      <span className="lbl">{label}{required && <span className="req"> *</span>}</span>
      {children}
      {max && <span className="gv-count">{count ?? 0}/{max}</span>}
      {hint && !error && <span className="gv-hint">{hint}</span>}
      {error && <span className="gv-err" role="alert">{error}</span>}
    </Tag>
  );
}

export function FormSection({ icon: Icon, title, intro, children }) {
  return (
    <fieldset className="gv-fsec">
      <legend>{Icon && <Icon size={14} />} {title}</legend>
      {intro && <p className="intro">{intro}</p>}
      {children}
    </fieldset>
  );
}

// Read-only 7-day strip: worked days highlighted.
export function DayPills({ days }) {
  const { t } = useI18n();
  const list = daysOf(days);
  if (list.length === 0) return <span className="gv-days-none">{t('subzone.noWorkDays')}</span>;
  return (
    <span className="gv-days" aria-label={list.map((d) => t('cust.day_' + d)).join(', ')}>
      {WEEK_DAYS.map((d) => <span key={d} className={`gv-day${list.includes(d) ? ' on' : ''}`} aria-hidden="true">{t('cust.day_' + d)}</span>)}
    </span>
  );
}

export function WorkDaysPicker({ value, onChange, invalid }) {
  const { t } = useI18n();
  return (
    <div className={`gv-daypick${invalid ? ' invalid' : ''}`}>
      {WEEK_DAYS.map((d) => (
        <button key={d} type="button" className="gv-daybtn" aria-pressed={value.includes(d)} onClick={() => onChange(toggleDay(value, d))}>
          {t('cust.day_' + d)}
        </button>
      ))}
    </div>
  );
}

// Lat/lng pair + "Use my location" (this device's GPS).
export function LatLngInput({ value, onChange, invalid }) {
  const { t } = useI18n();
  const [locating, setLocating] = useState(false);
  const [geoErr, setGeoErr] = useState('');
  function useMine() {
    setGeoErr('');
    if (!navigator.geolocation) { setGeoErr(t('gv.geoUnavailable')); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => { setLocating(false); onChange({ lat: pos.coords.latitude.toFixed(6), lng: pos.coords.longitude.toFixed(6) }); },
      () => { setLocating(false); setGeoErr(t('gv.geoFailed')); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }
  return (
    <>
      <div className="gv-latlng">
        <input className="cl-input" inputMode="decimal" placeholder={t('subzone.lat')} aria-label={t('subzone.lat')} aria-invalid={invalid || undefined} value={value.lat} onChange={(e) => onChange({ ...value, lat: e.target.value })} />
        <input className="cl-input" inputMode="decimal" placeholder={t('subzone.lng')} aria-label={t('subzone.lng')} aria-invalid={invalid || undefined} value={value.lng} onChange={(e) => onChange({ ...value, lng: e.target.value })} />
        <button type="button" className="gv-icon-btn" onClick={useMine} disabled={locating} style={{ minHeight: '40px' }}>
          <LocateFixed size={14} /> {locating ? t('common.loading') : t('subzone.useMyLocation')}
        </button>
      </div>
      {geoErr && <span className="gv-err">{geoErr}</span>}
    </>
  );
}

export function PersonChip({ icon: Icon, name, active = true, missingLabel, title }) {
  if (!name) return <span className="gv-pchip missing" title={title}>{Icon && <Icon size={12} />}{missingLabel}</span>;
  return <span className={`gv-pchip${active === false ? ' off' : ''}`} title={title}>{Icon && <Icon size={12} />}{name}</span>;
}

// "Group 2 (Baarsiigo) › Farah Omar › Zone A › New Sub Zone"
export function HierarchyPath({ parts }) {
  const items = parts.filter((p) => p && p.value);
  return (
    <div className="gv-path" aria-label={items.map((p) => p.value).join(' › ')}>
      {items.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <ChevronRight size={13} className="sep" aria-hidden="true" />}
          <span className={p.isNew ? 'new' : undefined}>{p.label && <span className="cl-muted">{p.label}: </span>}<b>{p.value}</b></span>
        </React.Fragment>
      ))}
    </div>
  );
}

// Staff user selector (leader / collector / cashier). GET /v2/users is
// admin-only, so other roles see the current value read-only.
// districtName: users with a district must match it (company-wide users with
// no district are listed only when allowCompanyWide). Inactive users are
// hidden unless they are the current value.
export function StaffSelect({ value, onChange, roles, districtName, allowCompanyWide, currentName, placeholder, ariaLabel, showRole }) {
  const { t } = useI18n();
  const isAdmin = (useAuth().user?.role || '').toLowerCase() === 'admin';
  const { data } = useUsers(isAdmin);
  if (!isAdmin) {
    return <span className={`gv-ro${currentName ? '' : ' muted'}`}>{currentName || placeholder}</span>;
  }
  const users = (data?.data || []).filter((u) => {
    if (String(u.id) === String(value)) return true;
    if (!u.is_active || !roles.includes((u.role || '').toLowerCase())) return false;
    if (!districtName) return true;
    return u.zone ? u.zone === districtName : !!allowCompanyWide;
  });
  const hasCurrent = !value || users.some((u) => String(u.id) === String(value));
  return (
    <select className="cl-input" value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel}>
      <option value="">{placeholder}</option>
      {!hasCurrent && <option value={value}>{currentName || `#${value}`}</option>}
      {users.map((u) => (
        <option key={u.id} value={String(u.id)}>
          {userLabel(u)}{showRole && u.role ? ` — ${t('gv.role.' + u.role.toLowerCase(), u.role)}` : ''}{u.is_active ? '' : ` (${t('status.inactive')})`}
        </option>
      ))}
    </select>
  );
}
