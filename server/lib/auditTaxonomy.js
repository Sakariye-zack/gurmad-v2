// Audit & Security Center — Implementation Spec §9. The exact, closed
// mapping from every existing v2_audit_log `action` value (re-enumerated
// from the Discovery's own full scan of every logAudit() call site) to a
// category and severity. NOT a heuristic — every action string handled
// here is one this codebase actually writes today. A future action
// introduced by a future CR needs its own entry added here at that time
// (documented maintenance note, Spec §9) — it is not auto-classified.
//
// Do NOT add entries for action types this codebase does not actually
// write — this table exists specifically so severity/category are never
// invented per-request.

const TAXONOMY = {
  // Authentication
  login:                      { category: 'Authentication', severity: 'INFO' },
  login_failed:                { category: 'Authentication', severity: 'WARNING' },
  logout:                      { category: 'Authentication', severity: 'INFO' },
  logout_all:                  { category: 'Authentication', severity: 'INFO' },
  password_change:             { category: 'Authentication', severity: 'INFO' },
  password_changed:            { category: 'Authentication', severity: 'INFO' },
  password_reset:              { category: 'Authentication', severity: 'INFO' },
  password_reset_completed:    { category: 'Authentication', severity: 'INFO' },
  password_reset_requested:    { category: 'Authentication', severity: 'INFO' },
  password_reset_failed:       { category: 'Authentication', severity: 'WARNING' },
  token_revoke:                 { category: 'Authentication', severity: 'WARNING' },
  sessions_revoked:            { category: 'Authentication', severity: 'WARNING' },

  // Account Administration
  account_disable:              { category: 'Account Administration', severity: 'CRITICAL' },
  account_disabled:            { category: 'Account Administration', severity: 'CRITICAL' },
  account_enable:               { category: 'Account Administration', severity: 'CRITICAL' },
  account_reenabled:           { category: 'Account Administration', severity: 'CRITICAL' },
  account_activated:           { category: 'Account Administration', severity: 'CRITICAL' },

  // RBAC Administration
  role_change:                  { category: 'RBAC Administration', severity: 'CRITICAL' },
  zone_change:                  { category: 'RBAC Administration', severity: 'CRITICAL' },
  'employee.reschedule_permission_change': { category: 'RBAC Administration', severity: 'WARNING' },

  // Customer
  'customer.create':           { category: 'Customer', severity: 'INFO' },
  'customer.update':           { category: 'Customer', severity: 'INFO' },
  'customer.status_change':    { category: 'Customer', severity: 'INFO' },
  'customer.number_change':    { category: 'Customer', severity: 'INFO' },
  'customer.group_change':     { category: 'Customer', severity: 'INFO' },
  'customer.route_change':     { category: 'Customer', severity: 'INFO' },
  'customer.zone_change':      { category: 'Customer', severity: 'INFO' },

  // Employee
  'employee.create':           { category: 'Employee', severity: 'INFO' },
  'employee.update':           { category: 'Employee', severity: 'INFO' },
  'employee.status_change':    { category: 'Employee', severity: 'INFO' },

  // Truck
  'truck.create':               { category: 'Truck', severity: 'INFO' },
  'truck.update':               { category: 'Truck', severity: 'INFO' },
  'truck.status_change':       { category: 'Truck', severity: 'INFO' },

  // Zone / Group / Route
  'zone.create':                 { category: 'Zone/Group/Route', severity: 'INFO' },
  'zone.update':                 { category: 'Zone/Group/Route', severity: 'INFO' },
  'group.create':                { category: 'Zone/Group/Route', severity: 'INFO' },
  'group.update':                { category: 'Zone/Group/Route', severity: 'INFO' },
  'group.status_change':        { category: 'Zone/Group/Route', severity: 'INFO' },
  'route.create':                { category: 'Zone/Group/Route', severity: 'INFO' },
  'route.update':                { category: 'Zone/Group/Route', severity: 'INFO' },
  'route.status_change':        { category: 'Zone/Group/Route', severity: 'INFO' },

  // Collection Operations
  'cycle.create':                { category: 'Collection Operations', severity: 'INFO' },
  'cycle.close':                  { category: 'Collection Operations', severity: 'INFO' },
  'batch.create':                { category: 'Collection Operations', severity: 'INFO' },
  'batch.start':                  { category: 'Collection Operations', severity: 'INFO' },
  'batch.close_cycle':          { category: 'Collection Operations', severity: 'INFO' },
  'batch.cancel':                { category: 'Collection Operations', severity: 'INFO' },
  'batch.capacity_block':       { category: 'Collection Operations', severity: 'WARNING' },
  'batch_customer.status_change': { category: 'Collection Operations', severity: 'INFO' },
  'batch_customer.reschedule':  { category: 'Collection Operations', severity: 'INFO' },
  'task.create':                  { category: 'Collection Operations', severity: 'INFO' },
  'task.status_change':          { category: 'Collection Operations', severity: 'INFO' },
  'task_resource.assign':       { category: 'Collection Operations', severity: 'INFO' },
  'task_resource.remove':       { category: 'Collection Operations', severity: 'INFO' },

  // Financial
  'invoice.create':               { category: 'Financial', severity: 'INFO' },
  'invoice.void':                 { category: 'Financial', severity: 'WARNING' },
  'payment.create':               { category: 'Financial', severity: 'INFO' },
  'payment.reverse':             { category: 'Financial', severity: 'WARNING' },
  'debt.create':                   { category: 'Financial', severity: 'INFO' },
  'debt.settle':                   { category: 'Financial', severity: 'INFO' },
  'debt.integrity_warning':      { category: 'Financial', severity: 'WARNING' },
  'cashout.create':               { category: 'Financial', severity: 'INFO' },
  'cashout.approve':             { category: 'Financial', severity: 'INFO' },
  'cashout.reject':               { category: 'Financial', severity: 'WARNING' },
  'cashout.void':                 { category: 'Financial', severity: 'WARNING' },
  'cashout_shortage.create':    { category: 'Financial', severity: 'WARNING' },
  'cashout_shortage.resolve':   { category: 'Financial', severity: 'INFO' },
  'exchange_rate.create':        { category: 'Financial', severity: 'INFO' },

  // Cashout Documents
  'cashout.attachment_upload':  { category: 'Cashout Documents', severity: 'INFO' },
  'cashout.attachment_void':    { category: 'Cashout Documents', severity: 'WARNING' },

  // Complaints
  complaint_attachment_uploaded: { category: 'Complaints', severity: 'INFO' },

  // Reporting
  'report.export':                { category: 'Reporting', severity: 'INFO' },
};

// success derivation (Spec §9): an explicit 4-item lookup, never a
// substring heuristic — a future action name containing "fail" is NOT
// auto-classified; only these exact 4 are.
const FAILURE_ACTIONS = new Set([
  'login_failed',
  'password_reset_failed',
  'batch.capacity_block',
  'debt.integrity_warning',
]);

const VALID_CATEGORIES = [...new Set(Object.values(TAXONOMY).map((v) => v.category))];
const VALID_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'];

// Unknown action (not yet in the table, e.g. a future CR added a new
// logAudit call site without updating this file) — classified as INFO /
// 'Uncategorized' rather than throwing, so the Audit Center never breaks
// on a legitimate new event; NOT silently treated as any more specific
// category than that.
function classify(action) {
  const entry = TAXONOMY[action];
  if (entry) return { category: entry.category, severity: entry.severity, success: !FAILURE_ACTIONS.has(action) };
  return { category: 'Uncategorized', severity: 'INFO', success: true };
}

module.exports = { classify, VALID_CATEGORIES, VALID_SEVERITIES, FAILURE_ACTIONS };
