// Operational Calendar — date arithmetic. Implementation Spec §16: plain JS
// date math, no library (neither package.json lists one). Monday-start week
// is a disclosed, non-business implementation default (Spec Open Risks) —
// not an independently-confirmed business decision.

function toDateOnly(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d, n) {
  const r = toDateOnly(d);
  r.setDate(r.getDate() + n);
  return r;
}

// Monday-start week containing `d`.
export function startOfWeek(d) {
  const r = toDateOnly(d);
  const dow = r.getDay(); // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  r.setDate(r.getDate() + diff);
  return r;
}

export function endOfWeek(d) {
  return addDays(startOfWeek(d), 6);
}

export function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

// Month grid: the Monday-start week range that covers the full month
// (leading/trailing days from adjacent months included for a complete grid).
export function monthGridRange(d) {
  return { from: startOfWeek(startOfMonth(d)), to: endOfWeek(endOfMonth(d)) };
}

export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function isToday(d) {
  return isSameDay(d, new Date());
}

// Every calendar day between from/to inclusive, as Date objects.
export function eachDay(from, to) {
  const days = [];
  let cur = toDateOnly(from);
  const end = toDateOnly(to);
  while (cur <= end) {
    days.push(cur);
    cur = addDays(cur, 1);
  }
  return days;
}

export function formatDayLabel(d) {
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

export function formatMonthLabel(d) {
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

export function formatWeekLabel(d) {
  const s = startOfWeek(d);
  const e = endOfWeek(d);
  const sameMonth = s.getMonth() === e.getMonth();
  const sOpts = sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' };
  return `${s.toLocaleDateString(undefined, sOpts)} – ${e.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
}
