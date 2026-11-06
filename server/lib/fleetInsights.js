const { pool } = require('../db');
const { getCurrentExchangeRate } = require('./financialCalculations');
const { getTimezone, localParts } = require('./autoBilling');

// Fleet upgrade — derived figures read at request time (never stored):
// fuel efficiency (km since previous fill, km/L, cost per km), anomaly
// flags, USD-equivalent costs, next-maintenance "due" logic and the GPS
// distance trips. Pure helpers are exported for unit use.

const LOW_EFFICIENCY_RATIO = 0.6; // km/L below 60% of the truck's 90-day median
const MEDIAN_WINDOW_DAYS = 90;
const MEDIAN_MIN_SAMPLES = 3;
const DUE_DAYS = 7;
const DUE_KM = 500;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round(v, dp = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

// SLSH -> USD at the current rate (rate = SLSH per 1 USD). Null when an SLSH
// amount cannot be converted (no rate configured).
function toUsd(amount, currency, rate) {
  const a = num(amount);
  if (a === null) return null;
  if (currency === 'SLSH') return rate ? a / rate : null;
  return a;
}

async function currentRate(client = pool) {
  const r = await getCurrentExchangeRate(client);
  return r ? parseFloat(r.rate) : null;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function dayDiff(a, b) {
  // a, b: 'YYYY-MM-DD' -> whole days b - a
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function dateStr(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const tsOf = (r) => new Date(r.created_at).getTime();
const byCreated = (a, b) => (tsOf(a) - tsOf(b)) || (a.id - b.id);
const byRecordDate = (a, b) => (a.record_date < b.record_date ? -1 : a.record_date > b.record_date ? 1 : byCreated(a, b));

// Per-truck efficiency series from that truck's odometer-bearing fuel
// records. Returns Map id -> { km_since_last, km_per_liter, prev_odometer,
// needs_review, low_efficiency, median_km_per_liter }.
function computeEfficiency(records) {
  const out = new Map();
  const byTruck = new Map();
  for (const r of records) {
    if (r.odometer_reading === null || r.odometer_reading === undefined) continue;
    if (!byTruck.has(r.truck_id)) byTruck.set(r.truck_id, []);
    byTruck.get(r.truck_id).push(r);
  }
  for (const list of byTruck.values()) {
    // Existing advisory check (unchanged rule): odometer lower than the
    // truck's previous ENTERED reading.
    const created = [...list].sort(byCreated);
    for (let i = 0; i < created.length; i++) {
      const prev = i > 0 ? created[i - 1] : null;
      out.set(created[i].id, { needs_review: !!prev && Number(created[i].odometer_reading) < Number(prev.odometer_reading) });
    }
    // Efficiency: in fill-date order, km since the previous fill / liters now.
    const dated = [...list].sort(byRecordDate);
    const series = [];
    for (let i = 0; i < dated.length; i++) {
      const cur = dated[i];
      const prev = i > 0 ? dated[i - 1] : null;
      const e = out.get(cur.id);
      e.prev_odometer = prev ? Number(prev.odometer_reading) : null;
      const km = prev ? Number(cur.odometer_reading) - Number(prev.odometer_reading) : null;
      e.km_since_last = km !== null && km > 0 ? km : null;
      e.km_per_liter = e.km_since_last && num(cur.liters) > 0 ? e.km_since_last / Number(cur.liters) : null;
      if (e.km_per_liter !== null) series.push({ date: dateStr(cur.record_date), kpl: e.km_per_liter, id: cur.id });
    }
    for (const s of series) {
      const window = series.filter((x) => { const d = dayDiff(x.date, s.date); return d >= 0 && d <= MEDIAN_WINDOW_DAYS; }).map((x) => x.kpl);
      const e = out.get(s.id);
      e.median_km_per_liter = window.length >= MEDIAN_MIN_SAMPLES ? median(window) : null;
      e.low_efficiency = e.median_km_per_liter !== null && s.kpl < LOW_EFFICIENCY_RATIO * e.median_km_per_liter;
    }
  }
  return out;
}

// Adds currency/efficiency/flags to fuel rows in ONE extra query (the old
// per-row needs_review lookup was an N+1).
async function annotateFuelRows(rows, client = pool, { rate } = {}) {
  if (!rows.length) return [];
  const truckIds = [...new Set(rows.map((r) => r.truck_id))];
  const all = await client.query(
    `SELECT id, truck_id, liters, odometer_reading, record_date, created_at
     FROM truck_fuel_records WHERE truck_id = ANY($1::int[]) AND odometer_reading IS NOT NULL`,
    [truckIds]
  );
  const eff = computeEfficiency(all.rows);
  const r8 = rate === undefined ? await currentRate(client) : rate;
  return rows.map((row) => {
    const e = eff.get(row.id) || {};
    const currency = row.currency || 'USD';
    const costUsd = toUsd(row.cost, currency, r8);
    const liters = num(row.liters);
    const ppl = num(row.price_per_liter) ?? (liters ? num(row.cost) / liters : null);
    const flags = [];
    if (e.needs_review) flags.push('odometer_backwards');
    if (e.low_efficiency) flags.push('low_efficiency');
    const { receipt_storage_path: receiptPath, ...rest } = row;
    return {
      ...rest,
      currency,
      price_per_liter: round(ppl, 4),
      has_receipt: !!receiptPath,
      cost_usd: round(costUsd),
      km_since_last: e.km_since_last ?? null,
      km_per_liter: round(e.km_per_liter ?? null),
      cost_per_km_usd: e.km_since_last && costUsd !== null ? round(costUsd / e.km_since_last, 4) : null,
      median_km_per_liter: round(e.median_km_per_liter ?? null),
      needs_review: !!e.needs_review,
      flags,
    };
  });
}

// Totals for a filtered fuel list.
function fuelTotals(rows) {
  const t = { count: rows.length, liters: 0, cost_by_currency: { USD: 0, SLSH: 0 }, cost_usd: 0, unconverted: 0, km: 0 };
  let effKm = 0; let effL = 0;
  for (const r of rows) {
    t.liters += num(r.liters) || 0;
    t.cost_by_currency[r.currency === 'SLSH' ? 'SLSH' : 'USD'] += num(r.cost) || 0;
    if (r.cost_usd === null) t.unconverted += 1; else t.cost_usd += r.cost_usd;
    if (r.km_since_last) { effKm += r.km_since_last; effL += num(r.liters) || 0; }
  }
  t.km = effKm;
  t.km_per_liter = effL > 0 ? round(effKm / effL) : null;
  t.cost_per_km_usd = effKm > 0 ? round(rows.filter((r) => r.km_since_last && r.cost_usd !== null).reduce((s, r) => s + r.cost_usd, 0) / effKm, 4) : null;
  t.liters = round(t.liters); t.cost_usd = round(t.cost_usd);
  t.cost_by_currency.USD = round(t.cost_by_currency.USD); t.cost_by_currency.SLSH = round(t.cost_by_currency.SLSH);
  return t;
}

// Next maintenance per truck: the latest COMPLETED record carrying a
// next_service_date and/or next_service_km. "Due" = date within 7 days, or
// the current odometer (latest fuel / maintenance reading) within 500 km of
// next_service_km. Retired trucks are skipped. truckIds null = all trucks.
async function getNextMaintenance({ truckIds = null, today = null } = {}, client = pool) {
  const day = today || localParts(new Date(), await getTimezone()).date;
  const params = [day];
  let filter = '';
  if (truckIds) { params.push(truckIds); filter = `AND t.id = ANY($${params.length}::int[])`; }
  const r = await client.query(
    `SELECT t.id AS truck_id, t.plate_number, t.zone_id, m.id AS record_id, m.description,
            m.next_service_date, m.next_service_km,
            GREATEST(fo.odo, mo.odo) AS current_odometer,
            (m.next_service_date - $1::date) AS days_remaining
     FROM trucks t
     JOIN LATERAL (
       SELECT id, description, next_service_date, next_service_km FROM truck_maintenance_records
       WHERE truck_id = t.id AND status = 'completed' AND (next_service_date IS NOT NULL OR next_service_km IS NOT NULL)
       ORDER BY COALESCE(completed_at, created_at) DESC, id DESC LIMIT 1
     ) m ON TRUE
     LEFT JOIN LATERAL (
       SELECT odometer_reading AS odo FROM truck_fuel_records
       WHERE truck_id = t.id AND odometer_reading IS NOT NULL ORDER BY record_date DESC, created_at DESC, id DESC LIMIT 1
     ) fo ON TRUE
     LEFT JOIN LATERAL (
       SELECT odometer_at_service AS odo FROM truck_maintenance_records
       WHERE truck_id = t.id AND odometer_at_service IS NOT NULL ORDER BY COALESCE(completed_at, created_at) DESC, id DESC LIMIT 1
     ) mo ON TRUE
     WHERE t.status <> 'retired' ${filter}`,
    params
  );
  const out = new Map();
  for (const row of r.rows) {
    const reasons = [];
    const days = row.days_remaining === null ? null : Number(row.days_remaining);
    if (days !== null && days <= DUE_DAYS) reasons.push('date');
    const odo = row.current_odometer === null ? null : Number(row.current_odometer);
    const kmRemaining = row.next_service_km !== null && odo !== null ? Number(row.next_service_km) - odo : null;
    if (kmRemaining !== null && kmRemaining <= DUE_KM) reasons.push('km');
    out.set(row.truck_id, {
      truck_id: row.truck_id, plate_number: row.plate_number, zone_id: row.zone_id,
      record_id: row.record_id, description: row.description,
      next_service_date: row.next_service_date, next_service_km: row.next_service_km,
      current_odometer: odo, days_remaining: days, km_remaining: kmRemaining,
      due: reasons.length > 0, due_reasons: reasons,
    });
  }
  return out;
}

// ---------- GPS trips ----------

function haversineMeters(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const NOISE_JUMP_M = 2000;
const NOISE_WINDOW_S = 30;
const GAP_S = 600;

// Sum of segment lengths over time-ordered points {lat, lng, t (epoch s)}.
// A jump > 2 km within 30 s is GPS noise: that point is dropped and the
// previous good point stays the anchor. A gap > 10 min is not counted (the
// phone was off / not tracking) but the anchor moves on.
function distanceKm(points) {
  let meters = 0;
  let used = 0;
  let anchor = null;
  for (const p of points) {
    if (!anchor) { anchor = p; used = 1; continue; }
    const dt = p.t - anchor.t;
    const d = haversineMeters(anchor, p);
    if (dt <= NOISE_WINDOW_S && d > NOISE_JUMP_M) continue; // noise
    if (dt <= GAP_S) meters += d;
    anchor = p;
    used += 1;
  }
  return { km: meters / 1000, points: used };
}

// Company-local day -> km per truck. The employee -> truck mapping mirrors
// routes/map.js: the truck on the collector's task for that day wins,
// otherwise their standing assignment (trucks.collector_id, then
// driver_id). When several phones map to one truck (collector + driver),
// the longest track is taken — the truck only drove once.
async function computeDayDistances(day, tz, client = pool) {
  const pts = await client.query(
    `SELECT employee_id, lat::float AS lat, lng::float AS lng, EXTRACT(EPOCH FROM recorded_at)::float AS t
     FROM collector_location_history
     WHERE recorded_at >= ($1::date::timestamp AT TIME ZONE $2::text)
       AND recorded_at < (($1::date + 1)::timestamp AT TIME ZONE $2::text)
     ORDER BY employee_id, recorded_at, id`,
    [day, tz]
  );
  const byEmp = new Map();
  for (const p of pts.rows) {
    if (!byEmp.has(p.employee_id)) byEmp.set(p.employee_id, []);
    byEmp.get(p.employee_id).push(p);
  }
  if (!byEmp.size) return new Map();
  const map = await client.query(
    `SELECT e.id AS employee_id, COALESCE(ttk.id, atk.id) AS truck_id
     FROM employees e
     LEFT JOIN LATERAL (
       SELECT trt.resource_id AS id
       FROM task_resources trc
       JOIN tasks tk ON tk.id = trc.task_id
       JOIN batches b ON b.id = tk.batch_id
       JOIN task_resources trt ON trt.task_id = trc.task_id AND trt.resource_type = 'truck'
       WHERE trc.resource_type = 'collector' AND trc.resource_id = e.id
         AND b.status NOT IN ('draft', 'cancelled') AND b.start_date <= $1::date
         AND (b.end_date >= $1::date OR (b.end_date IS NULL AND (b.start_date = $1::date OR b.status IN ('assigned', 'in_progress', 'partially_completed'))))
       ORDER BY (tk.status = 'in_progress') DESC, tk.id DESC
       LIMIT 1
     ) ttk ON TRUE
     LEFT JOIN LATERAL (
       SELECT t.id FROM trucks t WHERE t.collector_id = e.id OR t.driver_id = e.id
       ORDER BY (t.collector_id = e.id) DESC, t.id ASC LIMIT 1
     ) atk ON TRUE
     WHERE e.id = ANY($2::int[])`,
    [day, [...byEmp.keys()]]
  );
  const out = new Map();
  for (const m of map.rows) {
    if (!m.truck_id) continue;
    const d = distanceKm(byEmp.get(m.employee_id) || []);
    const cur = out.get(m.truck_id);
    if (!cur || d.km > cur.km) out.set(m.truck_id, d);
  }
  return out;
}

async function materialiseDay(day, tz, client = pool) {
  const dist = await computeDayDistances(day, tz, client);
  for (const [truckId, d] of dist) {
    await client.query(
      `INSERT INTO truck_daily_distance (truck_id, day, km, points, updated_at) VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (truck_id, day) DO UPDATE SET km = EXCLUDED.km, points = EXCLUDED.points, updated_at = NOW()`,
      [truckId, day, round(d.km), d.points]
    );
  }
  return dist.size;
}

// GPS km/L: km driven (daily GPS distance) between consecutive fills,
// divided by the liters put in at the later fill. fills: [{record_date,
// liters}] of one truck; daily: Map 'YYYY-MM-DD' -> km.
function gpsKmPerLiter(fills, daily) {
  const sorted = [...fills].sort((a, b) => (a.record_date < b.record_date ? -1 : a.record_date > b.record_date ? 1 : 0));
  let km = 0; let liters = 0;
  for (let i = 1; i < sorted.length; i++) {
    const from = dateStr(sorted[i - 1].record_date); const to = dateStr(sorted[i].record_date);
    let seg = 0;
    for (const [d, k] of daily) if (d > from && d <= to) seg += k;
    if (seg > 0) { km += seg; liters += Number(sorted[i].liters) || 0; }
  }
  return liters > 0 ? { km: round(km), liters: round(liters), km_per_liter: round(km / liters) } : null;
}

module.exports = {
  toUsd, currentRate, median, computeEfficiency, annotateFuelRows, fuelTotals, getNextMaintenance,
  haversineMeters, distanceKm, computeDayDistances, materialiseDay, gpsKmPerLiter, round, dateStr,
  DUE_DAYS, DUE_KM, LOW_EFFICIENCY_RATIO,
};
