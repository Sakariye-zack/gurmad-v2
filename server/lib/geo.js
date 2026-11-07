// Small geo helpers shared by proof of service (geofence on Serviced marks)
// and route order (nearest-neighbour "next house").

const EARTH_RADIUS_M = 6371008.8;

// A finite coordinate pair, or null. Accepts numbers and numeric strings
// (pg returns NUMERIC columns as strings); null/undefined/'' are "missing".
function toPoint(lat, lng) {
  if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') return null;
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < -90 || a > 90 || b < -180 || b > 180) return null;
  return { lat: a, lng: b };
}

// Great-circle distance in metres.
function haversineMeters(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Nearest-neighbour visiting order. `items` are { id, lat, lng }; `start` is
// a point or null. Items with a location are visited greedily from `start`
// (or, without one, from the located item with the lowest id); items without
// a location go last, by id. Returns the ids in visiting order.
function nearestNeighbourOrder(items, start) {
  const byId = (x, y) => x.id - y.id;
  const located = [];
  const unlocated = [];
  for (const it of items) {
    const p = toPoint(it.lat, it.lng);
    if (p) located.push({ id: it.id, p });
    else unlocated.push(it);
  }
  located.sort(byId);
  unlocated.sort(byId);
  const order = [];
  let cur = start ? toPoint(start.lat, start.lng) : null;
  if (!cur && located.length) {
    const first = located.shift();
    order.push(first.id);
    cur = first.p;
  }
  while (located.length) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < located.length; i++) {
      const d = haversineMeters(cur, located[i].p);
      if (d < bestD) { bestD = d; best = i; } // ties keep the lower id (list is id-sorted)
    }
    const [next] = located.splice(best, 1);
    order.push(next.id);
    cur = next.p;
  }
  for (const it of unlocated) order.push(it.id);
  return order;
}

module.exports = { toPoint, haversineMeters, nearestNeighbourOrder };
