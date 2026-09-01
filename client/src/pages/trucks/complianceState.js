// Shared compliance-state logic for Trucks — one place, not re-derived per
// component. "Expiring soon" = within 30 days, matches common fleet-ops
// practice; no business rule was given for this threshold so it's a
// reasonable UI default, not a validated requirement.
const SOON_DAYS = 30;

export function complianceState(truck) {
  const dates = [truck.insurance_expiry, truck.registration_expiry, truck.road_tax_expiry].filter(Boolean);
  if (dates.length === 0) return 'unknown';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const soonCutoff = new Date(today);
  soonCutoff.setDate(soonCutoff.getDate() + SOON_DAYS);

  let worst = 'ok';
  for (const d of dates) {
    const expiry = new Date(d);
    if (expiry < today) return 'expired'; // any expired field is the worst case, short-circuit
    if (expiry <= soonCutoff) worst = 'expiring_soon';
  }
  return worst;
}

export const COMPLIANCE_LABELS = {
  expired: 'Expired', expiring_soon: 'Expiring soon', ok: 'Compliant', unknown: 'No dates set',
};
export const COMPLIANCE_BADGE_MAP = {
  expired: 'danger', expiring_soon: 'warning', ok: 'success', unknown: 'info',
};
