import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Camera, ChevronLeft, RotateCcw } from 'lucide-react';
import { Button, LoadingState, ErrorState, useToast } from '../../components/ui/index.js';
import { getCachedAssignments } from '../lib/collectorStore.js';
import { useSyncQueueContext } from '../SyncQueueContext.jsx';

const STATUSES = [
  { value: 'serviced', label: 'Serviced' },
  { value: 'missed', label: 'Missed' },
  { value: 'skipped', label: 'Skipped' },
];

// Photo capture — Phase 10 Gap Audit follow-up. §15's original "Serviced
// requires a photo" rule was later relaxed to optional (user-requested,
// Phase 10) — a collector can still attach one, it's just no longer a
// blocker. capturePhoto() previously did nothing but PROVE camera access
// (open a stream, immediately stop it) — no image was ever actually
// taken. This is the real capture: a live <video> preview, a
// hidden <canvas> the frame is drawn onto at shutter time, downscaled and
// JPEG-compressed there (not full sensor resolution — this is evidence,
// not a photograph, and it has to fit through the AES-GCM-encrypted
// IndexedDB queue as base64), then converted to base64 for
// useSyncQueueContext().captureAction() to carry through the same queue
// entry as the status change itself.
const MAX_DIMENSION = 900; // long-edge cap — plenty for visit evidence, keeps the encoded payload small
const JPEG_QUALITY = 0.72;

export default function CollectionActionScreen() {
  const { batchId, customerId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { captureAction } = useSyncQueueContext();

  const [customer, setCustomer] = useState(undefined);
  const [status, setStatus] = useState(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState(null); // { base64, mime, previewUrl } | null
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraDenied, setCameraDenied] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const videoRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => {
    (async () => {
      const cached = await getCachedAssignments();
      const batch = cached?.data?.batches?.find((b) => String(b.id) === batchId);
      const c = batch?.customers?.find((cc) => String(cc.customer_id) === customerId);
      setCustomer(c || null);
    })();
  }, [batchId, customerId]);

  // Stream cleanup — a dangling getUserMedia stream keeps the camera's
  // hardware LED lit and drains battery even after this screen unmounts.
  useEffect(() => () => stopStream(), []);

  function stopStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }

  const openCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 960 } } });
      streamRef.current = stream;
      setCameraOpen(true);
      setCameraDenied(false);
      // videoRef isn't mounted until cameraOpen renders it — attach next tick.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      });
    } catch {
      setCameraDenied(true);
    }
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    const scale = Math.min(1, MAX_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const base64 = dataUrl.split(',')[1];
    setPhoto({ base64, mime: 'image/jpeg', previewUrl: dataUrl });
    stopStream();
    setCameraOpen(false);
  };

  const retake = () => {
    setPhoto(null);
    openCamera();
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

  if (customer === undefined) return <LoadingState />;
  // Hardening finding (P3): a stale/tampered/directly-typed URL for a
  // batch/customer not in this collector's own cached assignments
  // previously rendered a blank, dead-end page (no error, no way back).
  // No data is at risk either way (the lookup is scoped to this
  // collector's own cache — see CustomerDetailScreen's identical guard),
  // this is a UX/recovery fix only.
  if (customer === null) return <ErrorState message="Customer not found in your current assignments." onRetry={() => navigate('/collector')} />;

  const submit = async () => {
    if (!status) return toast.error('Select a status.');
    if (status === 'missed' && !reason.trim()) return toast.error('A reason is required to mark Missed.');
    // User-requested (Phase 10): photo is optional for Serviced, not
    // required — the "required" copy/validation below is removed; the
    // capture UI and upload path are unchanged, a collector can still
    // attach one, it's just no longer a blocker.

    setSubmitting(true);
    try {
      const { lat, lng } = await captureGps(); // §16 — automatic, at submission time
      await captureAction({
        batchId: Number(batchId), customerId: Number(customerId), taskId: customer.task_id,
        status, reason: reason.trim() || null, note: note.trim() || null, lat, lng,
        photoBase64: status === 'serviced' ? photo?.base64 : null,
        photoMime: status === 'serviced' ? photo?.mime : null,
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
              // Same fix as AssignmentsScreen.jsx — a bare <button> does not
              // inherit body's text color, so this rendered near-black in
              // dark mode without an explicit color.
              color: 'var(--text)',
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
          {cameraOpen ? (
            <div style={{ position: 'relative', borderRadius: 'var(--radius-md)', overflow: 'hidden', background: '#000' }}>
              <video ref={videoRef} playsInline muted style={{ width: '100%', display: 'block', maxHeight: '360px', objectFit: 'cover' }} />
              <button
                onClick={capturePhoto}
                aria-label="Capture photo"
                style={{
                  position: 'absolute', bottom: '14px', left: '50%', transform: 'translateX(-50%)',
                  width: '64px', height: '64px', borderRadius: '50%', background: '#fff', border: '4px solid var(--brand)',
                  cursor: 'pointer',
                }}
              />
            </div>
          ) : photo ? (
            <div>
              <img src={photo.previewUrl} alt="Captured visit evidence" style={{ width: '100%', borderRadius: 'var(--radius-md)', display: 'block', maxHeight: '320px', objectFit: 'cover' }} />
              <Button variant="secondary" icon={RotateCcw} onClick={retake} style={{ width: '100%', minHeight: '44px', marginTop: '8px' }}>
                Retake Photo
              </Button>
            </div>
          ) : (
            <Button icon={Camera} onClick={openCamera} style={{ width: '100%', minHeight: '48px' }}>
              Take Photo (optional)
            </Button>
          )}
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
