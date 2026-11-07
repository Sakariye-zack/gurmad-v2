import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Navigation, MapPin, ChevronRight } from 'lucide-react';
import { useSyncQueueContext } from '../SyncQueueContext.jsx';
import { useI18n } from '../../i18n/I18nContext.jsx';
import { useLivePosition, distanceMeters, hasLocation, navigateUrl } from '../hooks/useLivePosition.js';

// Route order: the first still-pending customer (customers arrive from
// /my-assignments already in visit order), skipping ones with a visit already
// queued on this phone (not yet synced, or accepted). Shown highlighted with
// the live distance and a Google Maps "Navigate" link.
export function findNextHouse(batches, entries) {
  const handled = new Set((entries || [])
    .filter((e) => !String(e.last_outcome || '').startsWith('rejected'))
    .map((e) => `${e.batch_id}:${e.customer_id}`));
  for (const b of batches || []) {
    for (const c of b.customers || []) {
      if (c.status === 'pending' && !handled.has(`${b.id}:${c.customer_id}`)) return { batch: b, customer: c };
    }
  }
  return null;
}

export default function NextHouseCard({ batches }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { entries } = useSyncQueueContext();
  const next = findNextHouse(batches, entries);
  const located = !!next && hasLocation(next.customer);
  const { pos } = useLivePosition(located);
  if (!next) return null;
  const { batch, customer: c } = next;
  const d = located && pos ? distanceMeters(pos, c) : null;
  return (
    <div style={{
      borderRadius: 'var(--radius-lg)', border: '2px solid var(--brand)', background: 'var(--success-bg)',
      padding: '14px', marginBottom: '16px',
    }}>
      <div style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--brand)' }}>
        {t('collector.nextHouse')}{c.visit_order ? ` · #${c.visit_order}` : ''}
      </div>
      <div style={{ fontSize: '17px', fontWeight: 800, color: 'var(--text)', marginTop: '4px', overflowWrap: 'anywhere' }}>{c.business_name || c.name}</div>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px' }}>
        <MapPin size={12} /> {c.address_line || t('collector.noAddress')}
      </div>
      <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text)', marginTop: '6px' }}>
        {!located ? t('collector.noHouseLocation') : d === null ? t('collector.locating') : t('collector.distanceAway', undefined, { m: formatMeters(d) })}
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
        {located && (
          <a href={navigateUrl(c)} target="_blank" rel="noopener noreferrer"
            style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', minHeight: '44px', borderRadius: 'var(--radius-md)', background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: '14px', textDecoration: 'none' }}>
            <Navigation size={16} /> {t('collector.navigate')}
          </a>
        )}
        <button type="button" onClick={() => navigate(`/collector/customer/${batch.id}/${c.customer_id}`)}
          style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px', minHeight: '44px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontWeight: 700, fontSize: '14px', cursor: 'pointer' }}>
          {t('collector.openVisit')} <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

export function formatMeters(m) {
  if (m === null || m === undefined) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
}
