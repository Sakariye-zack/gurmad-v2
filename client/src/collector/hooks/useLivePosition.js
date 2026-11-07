// Live phone position for proof of service ("you are N m from this house")
// and the "Next house" card. watchPosition only while the screen using it is
// mounted; cleared on unmount so GPS is not kept on in the background.
import { useEffect, useState } from 'react';

// A fix older than this is treated as missing (the phone may have moved).
export const MAX_FIX_AGE_MS = 30 * 1000;

export function useLivePosition(enabled = true) {
  const [fix, setFix] = useState(null); // { lat, lng, accuracy, at } | null
  const [error, setError] = useState(null); // 'unsupported' | 'denied' | 'unavailable' | 'timeout' | null
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return undefined;
    if (!navigator.geolocation) { setError('unsupported'); return undefined; }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setFix({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null, at: Date.now() });
        setError(null);
      },
      // 1 = denied, 3 = timeout (still searching), 2 = unavailable.
      (e) => setError(e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable'),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 }
    );
    // Re-evaluate the fix age even when no new fix arrives.
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => { navigator.geolocation.clearWatch(id); clearInterval(tick); };
  }, [enabled]);

  const pos = fix && now - fix.at <= MAX_FIX_AGE_MS ? fix : null;
  return { pos, error };
}

// Same formula as the server (server/lib/geo.js) so the app and the server
// agree on whether a mark is inside the radius.
export function distanceMeters(a, b) {
  if (!a || !b) return null;
  const la1 = Number(a.lat); const ln1 = Number(a.lng); const la2 = Number(b.lat); const ln2 = Number(b.lng);
  if (![la1, ln1, la2, ln2].every(Number.isFinite)) return null;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(la2 - la1);
  const dLng = rad(ln2 - ln1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h))));
}

export function hasLocation(c) {
  return c && c.lat !== null && c.lat !== undefined && c.lat !== '' && c.lng !== null && c.lng !== undefined && c.lng !== ''
    && Number.isFinite(Number(c.lat)) && Number.isFinite(Number(c.lng));
}

export function navigateUrl(c) {
  return `https://www.google.com/maps/dir/?api=1&destination=${Number(c.lat)},${Number(c.lng)}`;
}

export const DEFAULT_PROOF = { radius_m: 50, require_photo: false };
