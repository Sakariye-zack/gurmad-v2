// V2 API client — Frontend_Architecture.md §2: typed-shape request/response
// handling in one place, replacing the current system's per-call `fetch`
// with an ad-hoc `.then(res => res.json())` pattern (the direct root cause
// of a real found bug: getAuditLogs() never checked res.ok and silently
// mis-parsed a 403 error body as if it were data).
const BASE = '/api';

function getToken() {
  return localStorage.getItem('gurmad_v2_token');
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
    // Two backends, two error shapes: the reference T2.8-F backend returns
    // { error: "string" }; the V2 domain backends (Zones, Customers, ...)
    // return { error: { message, code } }. Found as a real bug during
    // Phase 3 Module 2 QA — an unhandled object was passed straight to
    // Error(), rendering as the literal text "[object Object]" in every
    // toast/inline error sourced from a V2 backend.
    const errBody = body && body.error;
    const message = (errBody && typeof errBody === 'object' ? errBody.message : errBody) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.code = errBody && typeof errBody === 'object' ? errBody.code : undefined;
    throw err;
  }
  return body;
}

export const apiClient = {
  get: (path) => request(path),
  post: (path, data) => request(path, { method: 'POST', body: JSON.stringify(data) }),
  put: (path, data) => request(path, { method: 'PUT', body: JSON.stringify(data) }),
  del: (path, data) => request(path, { method: 'DELETE', ...(data ? { body: JSON.stringify(data) } : {}) }),
  setToken: (token) => localStorage.setItem('gurmad_v2_token', token),
  clearToken: () => localStorage.removeItem('gurmad_v2_token'),
  getToken,
};
