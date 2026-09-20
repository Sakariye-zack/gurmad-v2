import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient.js';

// Personal profile photo — Phase 10, user-requested ('sawir soo saaran
// karo'). GET /v2/users/me/avatar requires auth, so a plain <img src>
// can't carry the Bearer token — this fetches it as an authorized blob
// URL (the same pattern already used for documents/receipts), revoking
// the previous object URL whenever it's replaced or the component
// unmounts, never leaking one. `version` lets a caller force a re-fetch
// right after a successful upload without a full page reload.
export function useMyAvatarUrl(version = 0) {
  const [url, setUrl] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = null;
    setLoading(true);
    apiClient.fetchAuthorizedFileUrl('/v2/users/me/avatar')
      .then((u) => {
        if (cancelled) { URL.revokeObjectURL(u); return; }
        objectUrl = u;
        setUrl(u);
      })
      .catch(() => { if (!cancelled) setUrl(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  return { url, loading };
}

export function useUploadAvatar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file) => {
      const formData = new FormData();
      formData.append('avatar', file);
      return apiClient.uploadFile('/v2/users/me/avatar', formData);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['v2', 'me'] }),
  });
}
