import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

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
const HOUSE_ICON_SVG = `
<svg width="30" height="38" viewBox="0 0 30 38" xmlns="http://www.w3.org/2000/svg">
  <path d="M15 0C6.716 0 0 6.716 0 15c0 10.5 15 23 15 23s15-12.5 15-23C30 6.716 23.284 0 15 0z" fill="var(--brand)"/>
  <circle cx="15" cy="15" r="10.5" fill="var(--brand-dark)"/>
  <path d="M15 8.5l7 6.2v8.3h-4.6v-5.2h-4.8v5.2H8V14.7z" fill="#fff"/>
</svg>`;

export default function MapCanvas({ points }) {
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

    (points || []).forEach((p) => {
      const lat = Number(p.lat);
      const lng = Number(p.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return; // defensive only — API already excludes these

      const popupHtml = `
        <div style="font-size:13px;line-height:1.5;">
          <strong>${escapeHtml(p.name)}</strong><br/>
          ${escapeHtml(p.customer_number)}<br/>
          Zone: ${escapeHtml(p.zone_name || '—')}<br/>
          Group: ${escapeHtml(p.group_name || '—')}<br/>
          Route: ${escapeHtml(p.route_name || '—')}<br/>
          Type: ${escapeHtml(p.customer_type || '—')}
        </div>
      `;
      const popup = new mapboxgl.Popup({ offset: 18 }).setHTML(popupHtml);
      // House icon, not Mapbox's default teardrop pin — a plain DOM element
      // marker (Mapbox GL JS's own documented way to use a custom marker),
      // styled from the app's own --brand token so it stays theme-
      // consistent rather than a hardcoded color living only here.
      const el = document.createElement('div');
      el.innerHTML = HOUSE_ICON_SVG;
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

    if (plotted > 0) {
      map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 });
    }
  }, [points, status]);

  if (status === 'unsupported') {
    return <ConfigNotice text="Your browser does not support this map." />;
  }
  if (status === 'no-token') {
    return <ConfigNotice text="Map is not configured. Contact an administrator." />;
  }
  if (status === 'error') {
    return <ConfigNotice text="The map could not be loaded right now." />;
  }

  return <div ref={containerRef} style={{ width: '100%', height: '100%', borderRadius: 'var(--radius-md)', overflow: 'hidden' }} />;
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
