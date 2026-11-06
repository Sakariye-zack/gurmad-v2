import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { Maximize2, Crosshair } from 'lucide-react';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { fmtMoney } from '../../lib/money.js';
import { PAYMENT_COLORS, TODAY_COLORS, customerPath } from './mapStatus.js';

// Route & GIS / Map. Owns the Mapbox GL JS instance in isolation from the
// rest of the page: base style (Streets / Satellite), controls (zoom,
// fullscreen, my location, scale), clustered customer pins (GeoJSON source,
// coloured by payment status, Today ring), live truck markers with smooth
// movement, today's route line, and the "set location on the map" pick
// mode. Sources/layers are (re)added on every 'style.load' so a style
// switch keeps everything; truck markers are DOM markers and survive a
// style switch on their own. No routing, no directions, no geocoding.

// Default view before there is anything to fit to: Burao.
const BURAO_CENTER = [45.5336, 9.5221];
const DEFAULT_ZOOM = 13;
const FIT_OPTIONS = { padding: 48, maxZoom: 16 };

const STYLES = {
  streets: 'mapbox://styles/mapbox/streets-v12',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
};
const STYLE_KEY = 'gurmad_map_style';
function readStyle() {
  try { return localStorage.getItem(STYLE_KEY) === 'satellite' ? 'satellite' : 'streets'; } catch { return 'streets'; }
}
function saveStyle(name) {
  try { localStorage.setItem(STYLE_KEY, name); } catch { /* private mode / blocked storage */ }
}

const TRUCK_STATUS_COLORS = { live: '#2e9e5b', idle: '#e0a800' };
const TRAIL_COLOR = '#1565c0';
const SRC_CUSTOMERS = 'gm-customers';
const SRC_TRAIL = 'gm-trail';
const L_CLUSTERS = 'gm-clusters';
const L_CLUSTER_COUNT = 'gm-cluster-count';
const L_POINTS = 'gm-points';
const L_TRAIL = 'gm-trail-line';
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

// Waste-truck side profile (flat on the road, not a location pin).
const TRUCK_ICON_SVG = `
<svg width="44" height="26" viewBox="0 0 44 26" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="22" cy="23.5" rx="17" ry="2" fill="rgba(0,0,0,0.3)"/>
  <rect x="2" y="6" width="23" height="13" rx="1.3" fill="#e2531d"/>
  <rect x="2" y="6" width="23" height="2.6" rx="1" fill="#b8410f"/>
  <rect x="1" y="7.5" width="2.2" height="11.5" rx="0.6" fill="#8f3208"/>
  <line x1="14" y1="9" x2="14" y2="19" stroke="#b8410f" stroke-width="1"/>
  <path d="M25 9.5h6.4c.55 0 1.05.28 1.35.75l2.55 4v4.75H25V9.5z" fill="#f4f6f5"/>
  <path d="M26.3 10.9h4.6l2.05 3.15h-6.65v-3.15z" fill="#2f6fa8"/>
  <rect x="35" y="16.8" width="2.4" height="2.4" rx="0.5" fill="#2b2f2e"/>
  <rect x="2" y="19" width="34.5" height="1.4" fill="#2b2f2e"/>
  <circle cx="9" cy="21.3" r="3" fill="#1c1f1e"/>
  <circle cx="9" cy="21.3" r="1.25" fill="#9aa0a0"/>
  <circle cx="30.5" cy="21.3" r="3" fill="#1c1f1e"/>
  <circle cx="30.5" cy="21.3" r="1.25" fill="#9aa0a0"/>
</svg>`;

const TRUCK_CSS = `
.gm-truck{position:relative;cursor:pointer;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35));line-height:0}
.gm-truck__dot,.gm-truck__pulse{position:absolute;top:-3px;right:-3px;width:11px;height:11px;border-radius:50%;background:var(--gm-c)}
.gm-truck__dot{border:2px solid #fff;box-sizing:content-box}
.gm-truck__pulse{top:-1px;right:-1px;animation:gmPulse 1.8s ease-out infinite}
@keyframes gmPulse{0%{transform:scale(1);opacity:.75}100%{transform:scale(3.2);opacity:0}}
@media (prefers-reduced-motion: reduce){.gm-truck__pulse{animation:none;display:none}}`;
function ensureTruckCss() {
  if (document.getElementById('gm-truck-css')) return;
  const s = document.createElement('style');
  s.id = 'gm-truck-css';
  s.textContent = TRUCK_CSS;
  document.head.appendChild(s);
}

function finiteLngLat(o) {
  const lat = Number(o?.lat);
  const lng = Number(o?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? [lng, lat] : null;
}

function customersGeoJson(points) {
  const features = [];
  (points || []).forEach((p) => {
    const ll = finiteLngLat(p);
    if (!ll) return; // defensive only — the API already excludes these
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: ll },
      properties: { id: p.id, pay: p.payment_status || 'none', today: p.today_status || 'not_scheduled' },
    });
  });
  return { type: 'FeatureCollection', features };
}

function trailGeoJson(trail) {
  const coords = (trail || []).map(finiteLngLat).filter(Boolean);
  if (coords.length < 2) return EMPTY_FC;
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }] };
}

function matchColors(prop, colors, fallback) {
  const expr = ['match', ['get', prop]];
  Object.entries(colors).forEach(([k, v]) => expr.push(k, v));
  expr.push(fallback);
  return expr;
}

function applyTodayPaint(map, showToday) {
  if (!map.getLayer(L_POINTS)) return;
  if (showToday) {
    map.setPaintProperty(L_POINTS, 'circle-stroke-color', matchColors('today', TODAY_COLORS, TODAY_COLORS.not_scheduled));
    map.setPaintProperty(L_POINTS, 'circle-stroke-width', 3);
    map.setPaintProperty(L_POINTS, 'circle-opacity', ['case', ['==', ['get', 'today'], 'not_scheduled'], 0.45, 1]);
  } else {
    map.setPaintProperty(L_POINTS, 'circle-stroke-color', '#ffffff');
    map.setPaintProperty(L_POINTS, 'circle-stroke-width', 1.5);
    map.setPaintProperty(L_POINTS, 'circle-opacity', 1);
  }
}

// Adds every source/layer this component owns (idempotent). Called on each
// 'style.load' — a style switch wipes them, the latest data lives in refs.
function setupLayers(map, data) {
  if (!map.getSource(SRC_TRAIL)) map.addSource(SRC_TRAIL, { type: 'geojson', data: data.trail });
  if (!map.getLayer(L_TRAIL)) {
    map.addLayer({
      id: L_TRAIL, type: 'line', source: SRC_TRAIL,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': TRAIL_COLOR, 'line-width': 4, 'line-opacity': 0.85 },
    });
  }
  if (!map.getSource(SRC_CUSTOMERS)) {
    map.addSource(SRC_CUSTOMERS, { type: 'geojson', data: data.customers, cluster: true, clusterRadius: 45, clusterMaxZoom: 15 });
  }
  if (!map.getLayer(L_CLUSTERS)) {
    map.addLayer({
      id: L_CLUSTERS, type: 'circle', source: SRC_CUSTOMERS, filter: ['has', 'point_count'],
      paint: {
        'circle-color': ['step', ['get', 'point_count'], '#2f8f5b', 25, '#1f7a4a', 100, '#135c37'],
        'circle-radius': ['step', ['get', 'point_count'], 16, 25, 20, 100, 26],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-opacity': 0.92,
      },
    });
  }
  if (!map.getLayer(L_CLUSTER_COUNT)) {
    map.addLayer({
      id: L_CLUSTER_COUNT, type: 'symbol', source: SRC_CUSTOMERS, filter: ['has', 'point_count'],
      layout: { 'text-field': ['get', 'point_count_abbreviated'], 'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'], 'text-size': 12, 'text-allow-overlap': true },
      paint: { 'text-color': '#ffffff' },
    });
  }
  if (!map.getLayer(L_POINTS)) {
    map.addLayer({
      id: L_POINTS, type: 'circle', source: SRC_CUSTOMERS, filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': matchColors('pay', PAYMENT_COLORS, PAYMENT_COLORS.none),
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 9, 19, 12],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5,
      },
    });
  }
  applyTodayPaint(map, data.showToday);
}

function existingLayers(map, ids) {
  return ids.filter((id) => map.getLayer(id));
}

export default function MapCanvas({
  points, trucks, showToday, focus, onOpenCustomer,
  canEditLocation, pickTarget, onRequestMove, onPickConfirm, onPickCancel,
  trail, trailEmployeeId, onToggleTrail, fitKey,
}) {
  const { t } = useI18n();
  const wrapRef = useRef(null);
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const readyRef = useRef(false);
  const token = import.meta.env.VITE_MAPBOX_TOKEN;
  // checking | unsupported | no-token | ready | error
  const [status, setStatus] = useState(() => {
    if (!mapboxgl.supported()) return 'unsupported';
    return token ? 'checking' : 'no-token';
  });
  const [styleName, setStyleName] = useState(readStyle);

  // Latest values for the long-lived map event handlers.
  const latest = useRef({});
  latest.current = { t, showToday, canEditLocation, onOpenCustomer, onRequestMove, onPickConfirm, onPickCancel, onToggleTrail, pickTarget, trailEmployeeId };
  const pointsById = useRef(new Map());
  const dataRef = useRef({ customers: EMPTY_FC, trail: EMPTY_FC, showToday: false });
  const customerPopupRef = useRef(null);
  const pickPopupRef = useRef(null);
  const truckMarkers = useRef(new Map()); // employee_id -> { marker, el, popup, data, raf }
  const fitRef = useRef({ key: {}, fitted: false }); // {} never equals a fitKey string -> first load fits

  // Init once per mount. Fail gracefully — no fallback provider, no
  // hardcoded token, no crash.
  useEffect(() => {
    if (status !== 'checking') return undefined; // unsupported browser / no token
    ensureTruckCss();

    mapboxgl.accessToken = token;
    let map;
    try {
      map = new mapboxgl.Map({
        container: containerRef.current,
        style: STYLES[styleName],
        center: BURAO_CENTER,
        zoom: DEFAULT_ZOOM,
        locale: {
          'FullscreenControl.Enter': t('map.fullscreen'),
          'FullscreenControl.Exit': t('map.exit_fullscreen'),
          'GeolocateControl.FindMyLocation': t('map.my_location'),
        },
      });
    } catch {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the external map failed to construct
      setStatus('error');
      return undefined;
    }

    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    // Fullscreen the wrapper (map + overlays), not just the canvas.
    map.addControl(new mapboxgl.FullscreenControl({ container: wrapRef.current }), 'top-right');
    map.addControl(new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: false,
      showUserLocation: true,
      fitBoundsOptions: { maxZoom: 16 },
    }), 'top-right');
    map.addControl(new mapboxgl.ScaleControl({ unit: 'metric', maxWidth: 110 }), 'bottom-left');

    map.on('style.load', () => setupLayers(map, dataRef.current));
    map.on('load', () => { readyRef.current = true; setStatus('ready'); });
    // Only a failure before the first load means "the map cannot be shown";
    // later errors (a missing tile, a blocked request) must not tear it down.
    map.on('error', () => { if (!readyRef.current) setStatus('error'); });

    map.on('mousemove', (e) => {
      if (latest.current.pickTarget) { map.getCanvas().style.cursor = 'crosshair'; return; }
      const layers = existingLayers(map, [L_CLUSTERS, L_POINTS]);
      const hit = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
      map.getCanvas().style.cursor = hit.length ? 'pointer' : '';
    });

    map.on('click', (e) => {
      if (latest.current.pickTarget) { showPickConfirm(map, e.lngLat); return; }
      const layers = existingLayers(map, [L_CLUSTERS, L_POINTS]);
      if (!layers.length) return;
      const f = map.queryRenderedFeatures(e.point, { layers })[0];
      if (!f) return;
      if (f.layer.id === L_CLUSTERS) {
        const src = map.getSource(SRC_CUSTOMERS);
        const center = f.geometry.coordinates;
        src.getClusterExpansionZoom(f.properties.cluster_id, (err, zoom) => {
          if (err) return;
          map.easeTo({ center, zoom: Math.min(zoom, 17) });
        });
        return;
      }
      const p = pointsById.current.get(f.properties.id);
      if (p) openCustomerPopup(map, p);
    });

    mapRef.current = map;
    const markers = truckMarkers.current;
    return () => {
      markers.forEach((m) => { if (m.raf) cancelAnimationFrame(m.raf); m.marker.remove(); });
      markers.clear();
      readyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize on container size changes (incl. entering/leaving fullscreen).
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const ro = new ResizeObserver(() => { mapRef.current?.resize(); });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [status]);

  function openCustomerPopup(map, p) {
    const ll = finiteLngLat(p);
    if (!ll) return;
    customerPopupRef.current?.remove();
    const popup = new mapboxgl.Popup({ offset: 10, maxWidth: '300px' });
    popup.setLngLat(ll).setDOMContent(buildPopup(p, latest, () => popup.remove())).addTo(map);
    popup.gmCustomerId = p.id;
    customerPopupRef.current = popup;
  }

  function showPickConfirm(map, lngLat) {
    const target = latest.current.pickTarget;
    if (!target) return;
    pickPopupRef.current?.remove();
    const tt = latest.current.t;
    const lat = Math.round(lngLat.lat * 1e6) / 1e6;
    const lng = Math.round(lngLat.lng * 1e6) / 1e6;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'font-size:13px;line-height:1.5;color:#1c231d;';
    wrap.innerHTML = `
      <div style="font-weight:700;margin-bottom:2px;">${escapeHtml(tt('map.pick_confirm', undefined, { c: target.customer_number || target.name || '' }))}</div>
      <div style="color:#5b665e;font-variant-numeric:tabular-nums;">${escapeHtml(lat.toFixed(6))}, ${escapeHtml(lng.toFixed(6))}</div>
      <div style="display:flex;gap:6px;margin-top:8px;">
        <button type="button" data-act="ok" style="${popupBtn(true)}">${escapeHtml(tt('map.confirm'))}</button>
        <button type="button" data-act="cancel" style="${popupBtn(false)}">${escapeHtml(tt('map.cancel'))}</button>
      </div>`;
    const popup = new mapboxgl.Popup({ offset: 6, closeOnClick: false, maxWidth: '260px' }).setLngLat([lng, lat]).setDOMContent(wrap).addTo(map);
    const ok = wrap.querySelector('[data-act="ok"]');
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      ok.style.opacity = '0.6';
      try {
        await latest.current.onPickConfirm?.(target, { lat, lng });
      } finally {
        ok.disabled = false;
        ok.style.opacity = '1';
      }
    });
    wrap.querySelector('[data-act="cancel"]').addEventListener('click', () => popup.remove());
    pickPopupRef.current = popup;
  }

  // Customer pins -> clustered GeoJSON source.
  useEffect(() => {
    pointsById.current = new Map((points || []).map((p) => [p.id, p]));
    dataRef.current.customers = customersGeoJson(points);
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    map.getSource(SRC_CUSTOMERS)?.setData(dataRef.current.customers);

    // An open customer popup survives a refetch (e.g. after "Set on map" or
    // a background refresh) when that customer is still on the map: same
    // popup, fresh content and position. Otherwise it closes.
    const open = customerPopupRef.current;
    if (open && open.isOpen()) {
      const p = pointsById.current.get(open.gmCustomerId);
      const ll = finiteLngLat(p);
      if (p && ll) open.setLngLat(ll).setDOMContent(buildPopup(p, latest, () => open.remove()));
      else open.remove();
    }

    // Fit only on first load and when the filter set changes — never on a
    // refetch of the same view, so the map doesn't jump under the user.
    if (fitRef.current.key !== fitKey && (points || []).length > 0) {
      fitRef.current.key = fitKey;
      const b = boundsOf(points, trucks);
      if (b) { map.fitBounds(b, { ...FIT_OPTIONS, duration: 0 }); fitRef.current.fitted = true; }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, status, fitKey]);

  useEffect(() => {
    dataRef.current.showToday = !!showToday;
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    applyTodayPaint(map, !!showToday);
    customerPopupRef.current?.remove(); // its Today row would be stale
  }, [showToday, status]);

  // Today's route line.
  useEffect(() => {
    dataRef.current.trail = trailGeoJson(trailEmployeeId ? trail : null);
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    map.getSource(SRC_TRAIL)?.setData(dataRef.current.trail);
  }, [trail, trailEmployeeId, status]);

  // Live trucks: one DOM marker per collector, moved smoothly to each new
  // position; markers of collectors no longer reported are removed.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    const seen = new Set();
    (trucks || []).forEach((tr) => {
      const ll = finiteLngLat(tr);
      if (!ll) return;
      seen.add(tr.employee_id);
      let m = truckMarkers.current.get(tr.employee_id);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'gm-truck';
        el.innerHTML = '<span class="gm-truck__pulse"></span>' + TRUCK_ICON_SVG + '<span class="gm-truck__dot"></span>';
        const popup = new mapboxgl.Popup({ offset: 22, maxWidth: '280px' });
        const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' }).setLngLat(ll).setPopup(popup).addTo(map);
        m = { marker, el, popup, data: tr, raf: null };
        truckMarkers.current.set(tr.employee_id, m);
      } else {
        animateMarker(m, ll);
      }
      m.data = tr;
      const color = TRUCK_STATUS_COLORS[tr.status] || TRUCK_STATUS_COLORS.idle;
      m.el.style.setProperty('--gm-c', color);
      m.el.querySelector('.gm-truck__pulse').style.display = tr.status === 'live' ? '' : 'none';
      m.el.setAttribute('aria-label', `${tr.collector_name || ''} ${tr.plate_number || ''}`.trim());
      m.popup.setDOMContent(buildTruckPopup(tr, latest));
    });
    truckMarkers.current.forEach((m, id) => {
      if (seen.has(id)) return;
      if (m.raf) cancelAnimationFrame(m.raf);
      m.marker.remove();
      truckMarkers.current.delete(id);
    });
    if (!fitRef.current.fitted && (points || []).length === 0 && seen.size > 0) {
      const b = boundsOf([], trucks);
      if (b) { map.fitBounds(b, { ...FIT_OPTIONS, duration: 0 }); fitRef.current.fitted = true; }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trucks, status, t, trailEmployeeId]);

  // Search result: fly to the house and open its popup.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready' || !focus) return;
    const p = pointsById.current.get(focus.id);
    const ll = finiteLngLat(p);
    if (!ll) return;
    map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 17), duration: 800 });
    openCustomerPopup(map, p);
  }, [focus, status]);

  // "Show all": fit every current pin and truck.
  function fitAll() {
    const map = mapRef.current;
    if (!map) return;
    const b = boundsOf(points, trucks);
    if (b) map.fitBounds(b, { ...FIT_OPTIONS, duration: 600 });
    else map.flyTo({ center: BURAO_CENTER, zoom: DEFAULT_ZOOM });
  }

  // Pick mode: crosshair, Esc cancels, leaving it removes the confirm popover.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return undefined;
    if (!pickTarget) {
      pickPopupRef.current?.remove();
      pickPopupRef.current = null;
      map.getCanvas().style.cursor = '';
      return undefined;
    }
    customerPopupRef.current?.remove();
    map.getCanvas().style.cursor = 'crosshair';
    const onKey = (e) => { if (e.key === 'Escape') latest.current.onPickCancel?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickTarget, status]);

  function switchStyle(name) {
    if (name === styleName) return;
    setStyleName(name);
    saveStyle(name);
    mapRef.current?.setStyle(STYLES[name], { diff: false }); // full reload -> 'style.load' re-adds our sources/layers
  }

  if (status === 'unsupported') return <ConfigNotice text="Your browser does not support this map." />;
  if (status === 'no-token') return <ConfigNotice text="Map is not configured. Contact an administrator." />;
  if (status === 'error') return <ConfigNotice text="The map could not be loaded right now." />;

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', maxWidth: '100%', height: '100%', minWidth: 0, borderRadius: 'var(--radius-md)', overflow: 'hidden', background: 'var(--surface)' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {status === 'ready' && (
        <div style={{ position: 'absolute', top: '10px', left: '10px', zIndex: 2, display: 'flex', flexWrap: 'wrap', gap: '6px', maxWidth: 'calc(100% - 70px)' }}>
          <div role="group" aria-label={t('map.map_style')} style={{ display: 'inline-flex', borderRadius: '6px', overflow: 'hidden', boxShadow: '0 0 0 2px rgba(0,0,0,0.1)' }}>
            {['streets', 'satellite'].map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => switchStyle(name)}
                aria-pressed={styleName === name}
                style={overlayBtn(styleName === name)}
              >
                {t(name === 'streets' ? 'map.style_streets' : 'map.style_satellite')}
              </button>
            ))}
          </div>
          <FitAllButton label={t('map.show_all')} onClick={fitAll} />
        </div>
      )}
      {pickTarget && (
        <div role="status" style={{
          position: 'absolute', bottom: '34px', left: '50%', transform: 'translateX(-50%)', zIndex: 3,
          display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', maxWidth: 'calc(100% - 24px)', boxSizing: 'border-box',
          background: '#1c231d', color: '#fff', borderRadius: '8px', boxShadow: '0 4px 14px rgba(0,0,0,0.3)', fontSize: '13px', fontWeight: 600,
        }}>
          <Crosshair size={15} style={{ flex: 'none' }} />
          <span>{t('map.pick_banner', undefined, { c: pickTarget.customer_number || pickTarget.name || '' })}</span>
          <button type="button" onClick={() => onPickCancel?.()} style={{ marginLeft: '4px', background: 'transparent', border: '1px solid rgba(255,255,255,0.5)', color: '#fff', borderRadius: '5px', padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px' }}>
            {t('map.cancel')}
          </button>
        </div>
      )}
    </div>
  );
}

function FitAllButton({ label, onClick }) {
  return (
    <button type="button" onClick={onClick} title={label} style={{ ...overlayBtn(false), borderRadius: '6px', boxShadow: '0 0 0 2px rgba(0,0,0,0.1)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
      <Maximize2 size={13} /> {label}
    </button>
  );
}

function overlayBtn(active) {
  return {
    padding: '6px 10px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12.5px', fontWeight: 700,
    background: active ? '#0b6b3a' : '#ffffff', color: active ? '#ffffff' : '#1c231d',
  };
}

function popupBtn(primary) {
  return `padding:5px 10px;border-radius:5px;cursor:pointer;font:inherit;font-size:12.5px;font-weight:700;border:1px solid ${primary ? '#0b6b3a' : '#c9d0cb'};`
    + `background:${primary ? '#0b6b3a' : '#fff'};color:${primary ? '#fff' : '#1c231d'};`;
}

function boundsOf(points, trucks) {
  const b = new mapboxgl.LngLatBounds();
  let n = 0;
  [...(points || []), ...(trucks || [])].forEach((o) => {
    const ll = finiteLngLat(o);
    if (ll) { b.extend(ll); n += 1; }
  });
  return n > 0 ? b : null;
}

// Ease a truck marker to its new position (~1.2 s) instead of jumping.
function animateMarker(m, to) {
  if (m.raf) cancelAnimationFrame(m.raf);
  const from = m.marker.getLngLat();
  if (Math.abs(from.lng - to[0]) < 1e-7 && Math.abs(from.lat - to[1]) < 1e-7) return;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { m.marker.setLngLat(to); return; }
  const start = performance.now();
  const dur = 1200;
  const step = (now) => {
    const k = Math.min(1, (now - start) / dur);
    const e = k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2;
    m.marker.setLngLat([from.lng + (to[0] - from.lng) * e, from.lat + (to[1] - from.lat) * e]);
    m.raf = k < 1 ? requestAnimationFrame(step) : null;
  };
  m.raf = requestAnimationFrame(step);
}

function agoText(t, secs) {
  const s = Math.max(0, Number(secs) || 0);
  return s < 60 ? t('map.secs_ago', undefined, { n: s }) : t('map.mins_ago', undefined, { n: Math.floor(s / 60) });
}

// Truck popup. Fixed dark text on purpose (Mapbox popups are always white).
// Every value is HTML-escaped.
function buildTruckPopup(tr, latest) {
  const { t, trailEmployeeId } = latest.current;
  const row = (label, value) => `<div><span style="color:#5b665e;">${escapeHtml(label)}:</span> ${value}</div>`;
  const statusColor = TRUCK_STATUS_COLORS[tr.status] || TRUCK_STATUS_COLORS.idle;
  const pr = tr.progress || { serviced: 0, missed: 0, pending: 0, total: 0 };
  const total = Number(pr.total) || 0;
  const pct = (n) => (total > 0 ? Math.round((Number(n) / total) * 1000) / 10 : 0);
  const truckLabel = tr.plate_number ? [tr.plate_number, tr.truck_name].filter(Boolean).join(' · ') : t('map.no_truck');
  const speed = tr.speed_kmh === null || tr.speed_kmh === undefined ? '—' : t('map.kmh', undefined, { n: tr.speed_kmh });
  const batches = (tr.batch_codes || []).join(', ');
  const subZones = (tr.sub_zone_names || []).join(', ');
  const trailOn = String(trailEmployeeId) === String(tr.employee_id);
  const html = `
    <div style="font-size:13px;line-height:1.55;color:#1c231d;min-width:200px;">
      <div style="display:flex;align-items:center;gap:6px;font-weight:700;font-size:14px;">
        <span style="width:9px;height:9px;border-radius:50%;background:${statusColor};display:inline-block;flex:none;"></span>
        ${escapeHtml(tr.collector_name || '—')}
        <span style="margin-left:auto;font-size:11px;font-weight:700;color:${statusColor};text-transform:uppercase;">${escapeHtml(t(tr.status === 'live' ? 'map.live' : 'map.idle'))}</span>
      </div>
      ${row(t('map.truck'), escapeHtml(truckLabel))}
      ${row(t('map.last_update'), escapeHtml(agoText(t, tr.seconds_ago)))}
      ${row(t('map.speed'), escapeHtml(speed))}
      ${batches ? row(t('map.batch'), escapeHtml(batches)) : ''}
      ${subZones ? row(t('map.f.subzone'), escapeHtml(subZones)) : ''}
      <div style="margin-top:6px;font-weight:700;">${escapeHtml(t('map.work_today'))} <span style="font-weight:600;color:#5b665e;">${escapeHtml(String(Number(pr.serviced) + Number(pr.missed)))}/${escapeHtml(String(total))}</span></div>
      <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:#e3e7e4;margin:3px 0;">
        <span style="width:${pct(pr.serviced)}%;background:${TODAY_COLORS.serviced};"></span>
        <span style="width:${pct(pr.missed)}%;background:${TODAY_COLORS.missed};"></span>
      </div>
      <div style="font-size:12px;color:#5b665e;">${escapeHtml(t('map.progress_counts', undefined, { s: pr.serviced, m: pr.missed, p: pr.pending }))}</div>
      <button type="button" data-trail="1" style="${popupBtn(trailOn)}margin-top:8px;">${escapeHtml(t(trailOn ? 'map.hide_route' : 'map.show_route'))}</button>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  wrap.querySelector('[data-trail]')?.addEventListener('click', () => latest.current.onToggleTrail?.(tr.employee_id));
  return wrap;
}

// Customer popup content. Fixed dark text on purpose: Mapbox popups are
// always white, regardless of the app's light/dark theme. Every value is
// HTML-escaped.
function buildPopup(p, latest, close) {
  const { t, showToday, canEditLocation } = latest.current;
  const row = (label, value) => `<div><span style="color:#5b665e;">${escapeHtml(label)}:</span> ${value}</div>`;
  const pay = p.payment_status || 'none';
  const today = p.today_status || 'not_scheduled';
  const dot = (c) => `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${c};margin-right:5px;"></span>`;
  const fee = p.fee === null || p.fee === undefined || p.fee === '' ? '—' : fmtMoney(p.fee, p.fee_currency === 'SLSH' ? 'SLSH' : 'USD');
  const billing = p.billing_type
    ? `${t(p.billing_type === 'daily' ? 'map.billing_daily' : 'map.billing_monthly')} · ${fee}`
    : '—';
  const owed = [];
  if (Number(p.outstanding_slsh) > 0) owed.push(fmtMoney(p.outstanding_slsh, 'SLSH'));
  if (Number(p.outstanding_usd) > 0) owed.push(fmtMoney(p.outstanding_usd, 'USD'));
  const html = `
    <div style="font-size:13px;line-height:1.55;color:#1c231d;">
      <div style="font-weight:700;font-size:14px;">${escapeHtml(p.name)}</div>
      <div style="color:#5b665e;">${escapeHtml(p.customer_number || '—')}</div>
      ${row(t('map.door'), escapeHtml(p.door_number || '—'))}
      ${row(t('map.path'), escapeHtml(customerPath(p) || '—'))}
      ${row(t('map.collector'), escapeHtml(p.collector_name || '—'))}
      ${row(t('map.billing'), escapeHtml(billing))}
      ${row(t('map.payment'), dot(PAYMENT_COLORS[pay] || PAYMENT_COLORS.none) + escapeHtml(t('map.pay.' + pay)) + (owed.length ? ' (' + escapeHtml(owed.join(' + ')) + ')' : ''))}
      ${showToday ? row(t('map.today_status'), dot(TODAY_COLORS[today] || TODAY_COLORS.not_scheduled) + escapeHtml(t('map.today.' + today))) : ''}
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:6px;">
        <a href="/customers/${encodeURIComponent(p.id)}" data-open="1" style="color:#0b6b3a;font-weight:700;text-decoration:underline;">${escapeHtml(t('map.open_customer'))}</a>
        ${canEditLocation ? `<button type="button" data-move="1" style="${popupBtn(false)}">${escapeHtml(t('map.move_location'))}</button>` : ''}
      </div>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const link = wrap.querySelector('[data-open]');
  if (link) {
    link.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || !latest.current.onOpenCustomer) return; // let the browser open a new tab
      e.preventDefault();
      latest.current.onOpenCustomer(p.id);
    });
  }
  wrap.querySelector('[data-move]')?.addEventListener('click', () => {
    close();
    latest.current.onRequestMove?.(p);
  });
  return wrap;
}

function ConfigNotice({ text }) {
  return (
    <div style={{
      width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
      color: 'var(--text-muted)', fontSize: '14px', fontWeight: 600, textAlign: 'center', padding: '24px',
    }}>
      {text}
    </div>
  );
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
