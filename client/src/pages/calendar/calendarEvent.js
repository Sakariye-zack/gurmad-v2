// Calendar event presentation helpers shared by WeekGrid, MonthGrid and the
// phone list fallback. Pure functions over one /v2/calendar/batches row.
import { appLocale } from '../../lib/dateLocale.js';
import { parseISODate } from './dateUtils.js';

function startDay(b) { return b.start_day || b.start_date; }
function endDay(b) { return b.end_day || b.end_date || null; }

// Auto (daily-list) batches open Today's list on that day; manual batches
// keep opening the batch detail.
export function eventTarget(b, dayIso) {
  if (b.auto_generated) return `/operations/today?date=${dayIso || startDay(b)}`;
  return `/collection-cycles/batches/${b.id}`;
}

export function isMultiDay(b) {
  const e = endDay(b);
  return !e || e !== startDay(b);
}

// A manual batch spanning several days (or open-ended) is drawn softer and
// carries an explicit range marker so it is not mistaken for daily work.
export function isSoftEvent(b) {
  return !b.auto_generated && isMultiDay(b);
}

export function subZoneLabel(b) {
  return b.route_name || b.route_code || b.batch_code;
}

export function primaryLabel(b) {
  const sz = subZoneLabel(b);
  return b.collector_name ? `${sz} · ${b.collector_name}` : sz;
}

export function progressLabel(b) {
  const total = Number(b.customer_count ?? b.total_customers ?? 0);
  return `${Number(b.serviced_count || 0)}/${total}`;
}

function shortDate(iso) {
  return parseISODate(iso).toLocaleDateString(appLocale(), { month: 'short', day: 'numeric' });
}

// "Oct 19 → Oct 25", or "Oct 19 →" for an open-ended batch.
export function rangeLabel(b) {
  const e = endDay(b);
  return `${shortDate(startDay(b))} → ${e ? shortDate(e) : ''}`.trim();
}

export function eventTooltip(b) {
  const parts = [b.batch_code, b.zone_name];
  if (b.route_name || b.route_code) parts.push([b.route_code, b.route_name].filter(Boolean).join(' '));
  if (b.collector_name) parts.push(b.collector_name);
  if (b.truck_plate) parts.push(b.truck_plate);
  if (isMultiDay(b)) parts.push(rangeLabel(b));
  parts.push(progressLabel(b));
  return parts.filter(Boolean).join(' — ');
}
