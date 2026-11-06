// Shared map constants/helpers (colours, status order, path label).
export const PAYMENT_STATUSES = ['clear', 'partial', 'unpaid', 'none'];
export const PAYMENT_COLORS = {
  clear: '#2e9e5b',
  partial: '#f08a1c',
  unpaid: '#d63a3a',
  none: '#8a949a',
};

export const TODAY_STATUSES = ['serviced', 'pending', 'missed', 'skipped', 'not_scheduled'];
export const TODAY_COLORS = {
  serviced: '#2e9e5b',
  pending: '#e0a800',
  missed: '#d63a3a',
  skipped: '#6b7a8d',
  not_scheduled: '#b5bcc2',
};

// Group › District › Zone › Sub Zone (skips levels the customer does not have).
export function customerPath(p) {
  return [p.group_name, p.zone_name, p.group_zone_name, p.route_name].filter(Boolean).join(' › ');
}

// Customer number (C-572), door number, or name.
export function matchCustomer(list, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const num = q.replace(/^c-?/, '');
  return (
    list.find((p) => String(p.customer_number || '').toLowerCase() === q) ||
    list.find((p) => String(p.door_number || '').toLowerCase() === q || (num && String(p.door_number || '').toLowerCase() === num)) ||
    list.find((p) => String(p.name || '').toLowerCase().includes(q)) ||
    null
  );
}
