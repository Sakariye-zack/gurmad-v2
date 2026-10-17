import React, { lazy, Suspense, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Phone, MapPin, ChevronLeft } from 'lucide-react';
import { Button, StatusBadge, LoadingState, ErrorState } from '../../components/ui/index.js';
import { getCachedAssignments } from '../lib/collectorStore.js';
// Reused, not reimplemented — user-requested (Phase 10): the same
// Mapbox GL canvas + house-icon marker the Staff Map already uses,
// dropped in here so a collector can actually see where they're going,
// not just read an address string. collection-sync's own /my-assignments
// response now includes the customer's lat/lng for exactly this (see
// routes/collectionSync.js's own comment on why that's not the "no raw
// GPS fed back" boundary this file's sibling screens rely on elsewhere).
// The map library is ~1.8MB — load it only when this screen actually shows a map.
const MapCanvas = lazy(() => import('../../pages/map/MapCanvas.jsx'));
import { useI18n } from '../../i18n/I18nContext.jsx';

// Screen 6.3 (Decisions §17). Purely a focused render of ALREADY-FETCHED,
// already-cached data — no separate network call, per Spec §6.3's own
// reasoning (this data already exists in the Assignments response).
export default function CustomerDetailScreen() {
  const { batchId, customerId } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();
  const [customer, setCustomer] = useState(undefined); // undefined = loading, null = not found
  const [batchCode, setBatchCode] = useState(null);

  useEffect(() => {
    (async () => {
      const cached = await getCachedAssignments();
      const batch = cached?.data?.batches?.find((b) => String(b.id) === batchId);
      const c = batch?.customers?.find((cc) => String(cc.customer_id) === customerId);
      setBatchCode(batch?.batch_code || null);
      setCustomer(c || null);
    })();
  }, [batchId, customerId]);

  if (customer === undefined) return <LoadingState />;
  if (customer === null) return <ErrorState message={t('collector.customerNotFound')} onRetry={() => navigate('/collector/assignments')} />;

  return (
    <div>
      <button onClick={() => navigate(-1)} style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', color: 'var(--text-muted)', fontWeight: 700, fontSize: '13px', marginBottom: '16px', cursor: 'pointer', minHeight: '44px' }}>
        <ChevronLeft size={18} /> {t('collector.backToAssignments')}
      </button>
      <h2 style={{ margin: '0 0 4px' }}>{customer.business_name || customer.name}</h2>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>{batchCode} · {t('cust.' + customer.customer_type, customer.customer_type)}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '16px' }}>
        <InfoRow icon={MapPin} label={customer.address_line || t('collector.noAddress')} />
        {customer.phone && <InfoRow icon={Phone} label={customer.phone} href={`tel:${customer.phone}`} />}
        <div><StatusBadge status={customer.status} /></div>
      </div>

      {Number.isFinite(Number(customer.lat)) && Number.isFinite(Number(customer.lng)) ? (
        <div style={{ height: '220px', marginBottom: '24px' }}>
          <Suspense fallback={null}><MapCanvas points={[customer]} /></Suspense>
        </div>
      ) : (
        <div style={{ padding: '12px 14px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)', fontSize: '13px', marginBottom: '24px' }}>
          {t('collector.noMapLocation')}
        </div>
      )}
      <Button
        style={{ width: '100%', minHeight: '52px', fontSize: '16px' }}
        disabled={customer.status !== 'pending'}
        onClick={() => navigate(`/collector/action/${batchId}/${customerId}`)}
      >
        {customer.status === 'pending' ? t('collector.startCollection') : t('collector.alreadyStatus', undefined, { status: t('status.' + customer.status, customer.status) })}
      </Button>
    </div>
  );
}

function InfoRow({ icon: Icon, label, href }) {
  const content = (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
      <Icon size={16} color="var(--text-muted)" /> {label}
    </div>
  );
  return href ? <a href={href} style={{ color: 'var(--text)', textDecoration: 'none' }}>{content}</a> : content;
}
