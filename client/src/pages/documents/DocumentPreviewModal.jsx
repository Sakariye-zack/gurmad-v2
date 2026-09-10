import React, { useEffect, useState } from 'react';
import { Modal, Button, LoadingState, ErrorState } from '../../components/ui/index.js';
import { fetchDocumentPreviewUrl } from '../../hooks/useDocuments.js';

// Authenticated fetch → blob → local object URL, per Implementation
// Specification §25/§26 — never a direct <iframe src="/v2/documents/:id/file">,
// since that sends no Authorization header. The blob URL is revoked on
// close/unmount so it never lingers in memory.
export default function DocumentPreviewModal({ open, onClose, doc }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let objectUrl = null;
    setLoading(true);
    setError('');
    fetchDocumentPreviewUrl(doc.id)
      .then((u) => { if (!cancelled) { objectUrl = u; setUrl(u); } })
      .catch((err) => { if (!cancelled) setError(err.message || 'Failed to load preview.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [open, doc.id]);

  if (!open) return null;

  const isImage = doc.mime_type.startsWith('image/');
  const isPdf = doc.mime_type === 'application/pdf';

  return (
    <Modal open onClose={onClose} title={doc.title} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div style={{ minHeight: '300px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {loading && <LoadingState label="Loading preview…" />}
        {error && <ErrorState message={error} />}
        {!loading && !error && url && isImage && <img src={url} alt={doc.display_filename} style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: 'var(--radius-sm)' }} />}
        {!loading && !error && url && isPdf && <embed src={url} type="application/pdf" style={{ width: '100%', height: '70vh', border: 'none' }} />}
      </div>
    </Modal>
  );
}
