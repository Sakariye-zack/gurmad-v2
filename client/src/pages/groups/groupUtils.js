// Groups V2 — plain helpers shared by the Group / Zone / Sub Zone pages.

export const WEEK_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
export const TEXT_MAX = 1000;
// Same set the server accepts as a Group leader (routes/groups.js) — never collectors.
export const LEADER_ROLES = ['admin', 'gudoomiye', 'zone_accountant', 'head_of_cashiers', 'cashier'];
export const WRITE_ROLES = ['admin', 'gudoomiye'];

export const userLabel = (u) => u.full_name || u.name || u.username || u.email || `#${u.id}`;
export const nameOrCode = (name, code) => {
  const c = (code || '').trim();
  const n = (name || '').trim();
  return n && n.toLowerCase() !== c.toLowerCase() ? `${c} — ${n}` : c || n;
};

// Lat/lng form state from a row's numeric columns.
export function latLngOf(lat, lng) {
  return { lat: lat != null ? String(Number(lat)) : '', lng: lng != null ? String(Number(lng)) : '' };
}

// {lat, lng} numbers, {lat: null, lng: null} when both blank, or null when invalid
// (only one filled, not a number, out of range) — same rule as the server.
export function parseLatLng(v) {
  const la = String(v.lat ?? '').trim();
  const ln = String(v.lng ?? '').trim();
  if (!la && !ln) return { lat: null, lng: null };
  const a = Number(la);
  const b = Number(ln);
  if (!la || !ln || !Number.isFinite(a) || !Number.isFinite(b) || a < -90 || a > 90 || b < -180 || b > 180) return null;
  return { lat: a, lng: b };
}

export const daysOf = (v) => (Array.isArray(v) ? WEEK_DAYS.filter((d) => v.includes(d)) : []);
export const hasCenter = (g) => g && g.center_lat != null && g.center_lng != null;
export const toggleDay = (list, d) => (list.includes(d) ? list.filter((x) => x !== d) : WEEK_DAYS.filter((x) => x === d || list.includes(x)));

// After a failed submit: bring the first invalid field into view and focus it.
export function revealFirstError(formId) {
  requestAnimationFrame(() => {
    const el = document.querySelector(`#${formId} .gv-field.invalid`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.querySelector('input, select, textarea, button')?.focus({ preventScroll: true });
  });
}
