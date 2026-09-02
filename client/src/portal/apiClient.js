// Phase 4 — Customer Portal — a SEPARATE api client, deliberately not the
// staff apiClient.js. Uses its own localStorage token key
// (gurmad_v2_portal_token, never gurmad_v2_token) so a customer's token and
// a staff member's token can never collide in the same browser profile —
// OD-1's "portal identity must remain separate from internal staff roles."
const BASE = '/api/v2/customer-portal';
const TOKEN_KEY = 'gurmad_v2_portal_token';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

async function request(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const errBody = body && body.error;
    const message = (errBody && typeof errBody === 'object' ? errBody.message : errBody) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.code = errBody && typeof errBody === 'object' ? errBody.code : undefined;
    throw err;
  }
  return body;
}

async function downloadAuthorizedFile(path, filename) {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try { const body = await res.json(); message = (body?.error?.message || body?.error) || message; } catch { /* no body */ }
    throw new Error(message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const portalApiClient = {
  get: (path) => request(path),
  post: (path, data) => request(path, { method: 'POST', body: JSON.stringify(data) }),
  put: (path, data) => request(path, { method: 'PUT', body: JSON.stringify(data) }),
  downloadAuthorizedFile,
  setToken: (token) => localStorage.setItem(TOKEN_KEY, token),
  clearToken: () => localStorage.removeItem(TOKEN_KEY),
  getToken,
};
