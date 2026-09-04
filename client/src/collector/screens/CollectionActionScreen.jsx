import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Camera, ChevronLeft } from 'lucide-react';
import { Button, LoadingState, useToast } from '../../components/ui/index.js';
import { getCachedAssignments } from '../lib/collectorStore.js';
import { useSyncQueueContext } from '../SyncQueueContext.jsx';

const STATUSES = [
  { value: 'serviced', label: 'Serviced' },
  { value: 'missed', label: 'Missed' },
  { value: 'skipped', label: 'Skipped' },
];

// Screen 6.4 (Decisions §17). Composes and queues a single offline action —
// online or offline, the submit path is identical (queue, then attempt
// sync), per Spec §14's own deliberate simplification. Client-side
// validation MIRRORS, never replaces, server-side validation (missed
// requires reason; serviced requires photo, §15).
export default function CollectionActionScreen() {
  const { batchId, customerId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { captureAction } = useSyncQueueContext();

  const [customer, setCustomer] = useState(undefined);
  const [status, setStatus] = useState(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState(null); // §15 — held client-side only, no upload path yet
  const [cameraDenied, setCameraDenied] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      const cached = await getCachedAssignments();
      const batch = cached?.data?.batches?.find((b) => String(b.id) === batchId);
      const c = batch?.customers?.find((cc) => String(cc.customer_id) === customerId);
      setCustomer(c || null);
    })();
  }, [batchId, customerId]);

  if (customer === undefined) return <LoadingState />;
  if (customer === null) return null;

  const capturePhoto = async () => {
    try {
      // §18 — just-in-time camera permission, requested only at first
      // attempted `serviced` marking. §15 — photo backend has no write
      // route yet (future CR); held client-side only for this workstream.
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      stream.getTracks().forEach((t) => t.stop()); // proof-of-access only; a real capture UI is an Implementation-stage detail
      setPhoto('captured');
      setCameraDenied(false);
    } catch {
      setCameraDenied(true);
    }
  };

  const captureGps = () =>
    new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({ lat: null, lng: null });
      const timeout = setTimeout(() => resolve({ lat: null, lng: null }), 5000); // §16 — bounded timeout, never blocks
      navigator.geolocation.getCurrentPosition(
        (pos) => { clearTimeout(timeout); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
        () => { clearTimeout(timeout); resolve({ lat: null, lng: null }); }, // denied/unavailable -> null, non-blocking
        { timeout: 5000 }
      );
    });

  const submit = async () => {
    if (!status) return toast.error('Select a status.');
    if (status === 'missed' && !reason.trim()) return toast.error('A reason is required to mark Missed.');
    if (status === 'serviced' && !photo) return toast.error('A photo is required to mark Serviced.');

    setSubmitting(true);
    try {
      const { lat, lng } = await captureGps(); // §16 — automatic, at submission time
      await captureAction({
        batchId: Number(batchId), customerId: Number(customerId), taskId: customer.task_id,
        status, reason: reason.trim() || null, note: note.trim() || null, lat, lng,
      });
      toast.success('Queued — will sync automatically');
      navigate('/collector');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <button onClick={() => navigate(-1)} style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', color: 'var(--text-muted)', fontWeight: 700, fontSize: '13px', marginBottom: '16px', cursor: 'pointer', minHeight: '44px' }}>
        <ChevronLeft size={18} /> Back
      </button>
      <h2 style={{ margin: '0 0 16px' }}>{customer.business_name || customer.name}</h2>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        {STATUSES.map((s) => (
          <button key={s.value} onClick={() => setStatus(s.value)}
            style={{
              flex: 1, padding: '16px 8px', borderRadius: 'var(--radius-md)', minHeight: '56px', fontWeight: 700, fontSize: '14px',
              border: status === s.value ? '2px solid var(--brand)' : '1px solid var(--border)',
              background: status === s.value ? 'var(--success-bg)' : 'var(--surface)', cursor: 'pointer',
            }}>
            {s.label}
          </button>
        ))}
      </div>

      {status === 'missed' && (
        <textarea placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)}
          style={{ width: '100%', minHeight: '72px', padding: '12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '15px', marginBottom: '12px' }} />
      )}

      {status === 'serviced' && (
        <div style={{ marginBottom: '12px' }}>
          <Button variant={photo ? 'secondary' : 'primary'} icon={Camera} onClick={capturePhoto} style={{ width: '100%', minHeight: '48px' }}>
            {photo ? 'Photo captured ✓' : 'Take Photo (required)'}
          </Button>
          {cameraDenied && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '6px' }}>
              Camera access is needed to mark a visit as Serviced — you can still mark Missed or Skipped, or enable camera access in your browser settings.
            </div>
          )}
        </div>
      )}

      <textarea placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)}
        style={{ width: '100%', minHeight: '60px', padding: '12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', fontSize: '15px', marginBottom: '16px' }} />

      <Button onClick={submit} disabled={!status || submitting} style={{ width: '100%', minHeight: '52px', fontSize: '16px' }}>
        {submitting ? 'Saving…' : 'Save Visit'}
      </Button>
    </div>
  );
}
