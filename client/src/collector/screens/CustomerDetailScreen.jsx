import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Phone, MapPin, ChevronLeft } from 'lucide-react';
import { Button, StatusBadge, LoadingState, ErrorState } from '../../components/ui/index.js';
import { getCachedAssignments } from '../lib/collectorStore.js';

// Screen 6.3 (Decisions §17). Purely a focused render of ALREADY-FETCHED,
// already-cached data — no separate network call, per Spec §6.3's own
// reasoning (this data already exists in the Assignments response).
export default function CustomerDetailScreen() {
  const { batchId, customerId } = useParams();
  const navigate = useNavigate();
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
  if (customer === null) return <ErrorState message="Customer not found in your current assignments." onRetry={() => navigate('/collector')} />;

  return (
    <div>
      <button onClick={() => navigate(-1)} style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', color: 'var(--text-muted)', fontWeight: 700, fontSize: '13px', marginBottom: '16px', cursor: 'pointer', minHeight: '44px' }}>
        <ChevronLeft size={18} /> Back to Assignments
      </button>
      <h2 style={{ margin: '0 0 4px' }}>{customer.business_name || customer.name}</h2>
      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>{batchCode} · {customer.customer_type}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '24px' }}>
        <InfoRow icon={MapPin} label={customer.address_line || 'No address on file'} />
        {customer.phone && <InfoRow icon={Phone} label={customer.phone} href={`tel:${customer.phone}`} />}
        <div><StatusBadge status={customer.status} /></div>
      </div>
      <Button
        style={{ width: '100%', minHeight: '52px', fontSize: '16px' }}
        disabled={customer.status !== 'pending'}
        onClick={() => navigate(`/collector/action/${batchId}/${customerId}`)}
      >
        {customer.status === 'pending' ? 'Start Collection' : 'Already ' + customer.status}
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
