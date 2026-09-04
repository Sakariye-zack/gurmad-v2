// Audit & Security Center — Implementation Spec §8. Server-side, READ-TIME
// redaction only — the stored v2_audit_log.before_data/after_data JSONB is
// NEVER modified by this module; it only shapes what a response sends.
// Removes exactly the field classes D5 enumerated (password/JWT/token/
// secret/credential-shaped keys) — case-insensitive key match, key deleted
// entirely (not masked). Explicitly does NOT touch GPS fields
// (status_lat/status_lng) or any other field — Discovery §9 confirmed no
// current logAudit() call site actually includes a secret value; this is a
// defensive guarantee against a future one, not a fix for an observed leak.
const SENSITIVE_KEY_RE = /password|jwt|token|secret|api_?key|credential/i;

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(k)) continue; // removed entirely, not masked
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}

// row: a raw v2_audit_log row (before_data/after_data already JSON, since
// pg returns JSONB columns as parsed objects, not strings). Returns a new
// object — never mutates the input.
function redactAuditRow(row) {
  return {
    ...row,
    before_data: row.before_data ? redactValue(row.before_data) : row.before_data,
    after_data: row.after_data ? redactValue(row.after_data) : row.after_data,
  };
}

module.exports = { redactAuditRow, redactValue, SENSITIVE_KEY_RE };
