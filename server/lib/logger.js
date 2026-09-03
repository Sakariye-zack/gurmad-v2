// Production Readiness (T) — Implementation Spec §5. A minimal, dependency-
// free structured-logging helper — NOT a monitoring/error-tracking vendor
// integration (that vendor choice remains an explicit Open Question, T
// Spec §13 item 2/3, not decided by this implementation). This module only
// establishes the CHOKE POINT and SHAPE every log line goes through, so a
// real vendor can be plugged in later (e.g. by swapping console.log for an
// SDK call inside emit()) without touching any call site.
//
// Hard rule, enforced by convention at every call site in this codebase,
// not by this module automatically: NEVER pass a password, token, secret,
// or raw financial/customer payload as a log field. Log the EVENT
// ("login_failed for user X"), never the PAYLOAD (the attempted
// password). This mirrors the exact discipline lib/db.js's logAudit()
// already follows for every closed module's own audit events.

function emit(level, event, fields = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  // console.error for warn/error so it's distinguishable in most log
  // collectors' own default stream-routing (stderr vs stdout) — a small,
  // free win once any real log-shipping tool is eventually attached.
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(JSON.stringify(line));
}

function info(event, fields) {
  emit('info', event, fields);
}

function warn(event, fields) {
  emit('warn', event, fields);
}

function error(event, fields) {
  emit('error', event, fields);
}

module.exports = { info, warn, error };
