import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { fmtMoney } from '../../lib/money.js';
import { PAYMENT_COLORS, TODAY_COLORS, customerPath } from './mapStatus.js';

// Route & GIS / Map — Implementation Spec §16/§26. Owns the Mapbox GL JS
// instance lifecycle in isolation from the rest of the page. Mapbox GL
// JS is the approved rendering platform for V1 — this component does
// nothing beyond initializing the map, plotting the already-authorized,
// already-filtered points it's given, and tearing the instance down on
// unmount. No routing, no directions, no drawing tools, no geocoding.
// Default view when there are no located customers yet (or before the
// map has anything to fit bounds to) — the company's actual operating
// area (Togdheer region, Somaliland; Burco as the regional anchor point),
// not the previous [0,0] zoom-1 world view, which read as broken/
// unconfigured rather than "this region, zoomed out."
const TOGDHEER_CENTER = [45.535, 9.52];
const TOGDHEER_DEFAULT_ZOOM = 8;

// A pin-shaped marker with a house glyph inside — reads as "customer
// location" at a glance rather than a generic dot. fill="var(--brand)"
// works because this is injected as real DOM (Marker({element}) attaches
// it directly, not a rasterized image), so it inherits the app's theme
// tokens like any other element and needs no light/dark branching here.
function houseIconSvg(color) {
  return `
<svg width="30" height="38" viewBox="0 0 30 38" xmlns="http://www.w3.org/2000/svg">
  <path d="M15 0C6.716 0 0 6.716 0 15c0 10.5 15 23 15 23s15-12.5 15-23C30 6.716 23.284 0 15 0z" fill="${color}"/>
  <circle cx="15" cy="15" r="10.5" fill="rgba(0,0,0,0.22)"/>
  <path d="M15 8.5l7 6.2v8.3h-4.6v-5.2h-4.8v5.2H8V14.7z" fill="#fff"/>
</svg>`;
}

// Small round badge on a pin in "Today" mode (check / clock / x / dash).
const BADGE_GLYPH = { serviced: '✓', pending: '⏱', missed: '✕', skipped: '–' };

// Truck marker — user-reported, second pass ('sidaaso kale gaadhigu
// wadada ha u maro... oo gaadhi khashiish ha noqdo waliba': it should sit
// flat on the road like a real vehicle, not stand up like a location
// pin, and should specifically read as a WASTE/garbage truck). Dropped
// the teardrop-pin mount entirely (that shape means "a place", not "a
// moving vehicle") in favor of a flat side-profile truck badge with a
// soft ground shadow, anchored at its own wheels so it looks planted on
// the street rather than hovering above it. Waste-truck cues specifically
// (not a generic delivery box): an orange rear compactor body with a
// hopper lip and a rear loading edge, a white cab, dark wheels with hubs.
const TRUCK_ICON_SVG = `
<svg width="44" height="26" viewBox="0 0 44 26" xmlns="http://www.w3.org/2000/svg">
  <!-- Ground shadow — reads as "sitting on the road", not floating -->
  <ellipse cx="22" cy="23.5" rx="17" ry="2" fill="rgba(0,0,0,0.3)"/>

  <!-- Rear compactor body -->
  <rect x="2" y="6" width="23" height="13" rx="1.3" fill="#e2531d"/>
  <!-- Hopper lip along the top edge -->
  <rect x="2" y="6" width="23" height="2.6" rx="1" fill="#b8410f"/>
  <!-- Rear loading edge -->
  <rect x="1" y="7.5" width="2.2" height="11.5" rx="0.6" fill="#8f3208"/>
  <!-- Panel line / body seam -->
  <line x1="14" y1="9" x2="14" y2="19" stroke="#b8410f" stroke-width="1"/>

  <!-- Cab -->
  <path d="M25 9.5h6.4c.55 0 1.05.28 1.35.75l2.55 4v4.75H25V9.5z" fill="#f4f6f5"/>
  <!-- Windshield -->
  <path d="M26.3 10.9h4.6l2.05 3.15h-6.65v-3.15z" fill="#2f6fa8"/>
  <!-- Bumper -->
  <rect x="35" y="16.8" width="2.4" height="2.4" rx="0.5" fill="#2b2f2e"/>

  <!-- Chassis -->
  <rect x="2" y="19" width="34.5" height="1.4" fill="#2b2f2e"/>

  <!-- Wheels -->
  <circle cx="9" cy="21.3" r="3" fill="#1c1f1e"/>
  <circle cx="9" cy="21.3" r="1.25" fill="#9aa0a0"/>
  <circle cx="30.5" cy="21.3" r="3" fill="#1c1f1e"/>
  <circle cx="30.5" cy="21.3" r="1.25" fill="#9aa0a0"/>
</svg>`;

export default function MapCanvas({ points, trucks, showToday, focus, onOpenCustomer }) {
  const { t } = useI18n();
  const customerMarkers = useRef(new Map()); // customer id -> marker
  const fitKeyRef = useRef({});
  const onOpenRef = useRef(onOpenCustomer);
  useEffect(() => { onOpenRef.current = onOpenCustomer; }, [onOpenCustomer]);
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const [status, setStatus] = useState('checking'); // checking | unsupported | no-token | ready | error

  const token = import.meta.env.VITE_MAPBOX_TOKEN;

  // Init once per mount. Spec §26: fail gracefully — no bypass, no
  // fallback provider, no hardcoded token, no crash.
  useEffect(() => {
    if (!mapboxgl.supported()) {
      setStatus('unsupported');
      return;
    }
    if (!token) {
      setStatus('no-token');
      return;
    }

    mapboxgl.accessToken = token;
    let map;
    try {
      map = new mapboxgl.Map({
        container: containerRef.current,
        style: 'mapbox://styles/mapbox/streets-v12',
        center: TOGDHEER_CENTER,
        zoom: TOGDHEER_DEFAULT_ZOOM,
      });
    } catch {
      setStatus('error');
      return;
    }

    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    map.on('load', () => setStatus('ready'));
    map.on('error', () => setStatus('error'));
    mapRef.current = map;

    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize on container size changes (Mapbox GL JS's own documented
  // pattern for a resizing container — Spec §18).
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const ro = new ResizeObserver(() => {
      mapRef.current?.resize();
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Plot markers whenever the (already server-filtered) point set changes.
  // No clustering (Spec §19/§22 — not authorized for V1).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const bounds = new mapboxgl.LngLatBounds();
    let plotted = 0;

    customerMarkers.current = new Map();
    (points || []).forEach((p) => {
      const lat = Number(p.lat);
      const lng = Number(p.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return; // defensive only — API already excludes these

      const popup = new mapboxgl.Popup({ offset: 18, maxWidth: '300px' }).setDOMContent(buildPopup(p, t, onOpenRef, showToday));
      // House pin coloured by payment status; in Today mode a badge shows the
      // visit result and customers with nothing scheduled are dimmed.
      const el = document.createElement('div');
      el.style.cursor = 'pointer';
      el.style.position = 'relative';
      el.style.filter = 'drop-shadow(0 2px 3px rgba(0,0,0,0.35))';
      el.innerHTML = houseIconSvg(PAYMENT_COLORS[p.payment_status] || PAYMENT_COLORS.none);
      if (showToday) {
        const ts = p.today_status || 'not_scheduled';
        if (ts === 'not_scheduled') {
          el.style.opacity = '0.45';
        } else {
          const badge = document.createElement('span');
          badge.textContent = BADGE_GLYPH[ts] || '';
          badge.style.cssText = 'position:absolute;top:-6px;right:-8px;width:17px;height:17px;border-radius:50%;'
            + 'color:#fff;font-size:11px;font-weight:700;line-height:17px;text-align:center;border:2px solid #fff;box-sizing:content-box;'
            + 'background:' + (TODAY_COLORS[ts] || TODAY_COLORS.not_scheduled);
          el.appendChild(badge);
        }
      }
      const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([lng, lat])
        .setPopup(popup)
        .addTo(map);

      markersRef.current.push(marker);
      customerMarkers.current.set(p.id, marker);
      bounds.extend([lng, lat]);
      plotted += 1;
    });

    // Trucks — user-requested ('ilaa gawaadhidii ay ka soo muuqato').
    // Rendered in the same effect/marker lifecycle as customer pins
    // (cleared and re-added together each time either list changes), so
    // there is only ever one place that owns markersRef's contents.
    (trucks || []).forEach((tr) => {
      const lat = Number(tr.lat);
      const lng = Number(tr.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const popupHtml = `
        <div style="font-size:13px;line-height:1.6;color:#1c231d;">
          <strong>${escapeHtml(tr.plate_number || 'Truck')}</strong><br/>
          Collector: ${escapeHtml(tr.collector_name || '—')}<br/>
          Zone: ${escapeHtml(tr.zone_name || '—')}<br/>
          Updated: ${new Date(tr.recorded_at).toLocaleTimeString()}
        </div>
      `;
      const popup = new mapboxgl.Popup({ offset: 18 }).setHTML(popupHtml);
      const el = document.createElement('div');
      el.innerHTML = TRUCK_ICON_SVG;
      el.style.cursor = 'pointer';
      el.style.filter = 'drop-shadow(0 2px 3px rgba(0,0,0,0.35))';
      const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([lng, lat])
        .setPopup(popup)
        .addTo(map);

      markersRef.current.push(marker);
      bounds.extend([lng, lat]);
      plotted += 1;
    });

    const dataChanged = fitKeyRef.current.points !== points || fitKeyRef.current.trucks !== trucks;
    fitKeyRef.current = { points, trucks };
    if (plotted > 0 && dataChanged) {
      map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 });
    }
  }, [points, trucks, status, showToday, t]);

  // Search result: fly to the house and open its popup.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready' || !focus) return;
    const marker = customerMarkers.current.get(focus.id);
    if (!marker) return;
    map.flyTo({ center: marker.getLngLat(), zoom: Math.max(map.getZoom(), 17), duration: 800 });
    if (!marker.getPopup().isOpen()) marker.togglePopup();
  }, [focus, status]);

  if (status === 'unsupported') {
    return <ConfigNotice text="Your browser does not support this map." />;
  }
  if (status === 'no-token') {
    return <ConfigNotice text="Map is not configured. Contact an administrator." />;
  }
  if (status === 'error') {
    return <ConfigNotice text="The map could not be loaded right now." />;
  }

  return <div ref={containerRef} style={{ width: '100%', maxWidth: '100%', height: '100%', minWidth: 0, borderRadius: 'var(--radius-md)', overflow: 'hidden' }} />;
}

// Popup content. Fixed dark text on purpose: Mapbox popups are always white,
// regardless of the app's light/dark theme. Every value is HTML-escaped.
function buildPopup(p, t, onOpenRef, showToday) {
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
      <a href="/customers/${encodeURIComponent(p.id)}" data-open="1" style="display:inline-block;margin-top:6px;color:#0b6b3a;font-weight:700;text-decoration:underline;">${escapeHtml(t('map.open_customer'))}</a>
    </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const link = wrap.querySelector('[data-open]');
  if (link) {
    link.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || !onOpenRef.current) return; // let the browser open a new tab
      e.preventDefault();
      onOpenRef.current(p.id);
    });
  }
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
