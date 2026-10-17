// Field Collector Mobile — Implementation Spec §12. The ONE place backend
// outcome vocabulary is translated to Collector-facing language. No screen
// may render a raw outcome string, action_uuid, or server error text —
// every render path for a sync outcome must go through this function.
const MESSAGES = {
  accepted: { key: 'collector.outcome.recorded', text: 'Visit recorded', tone: 'success' },
  already_applied: { key: 'collector.outcome.recorded', text: 'Visit recorded', tone: 'success' },
  rejected_stale: { key: 'collector.outcome.stale', text: "This customer's status has changed — refreshing your list", tone: 'warning' },
  rejected_invalid_state: { key: 'collector.outcome.invalidState', text: 'This task is no longer assigned to you — refreshing your list', tone: 'warning' },
  requires_reauthentication: { key: 'collector.outcome.reauth', text: 'Please sign in again to sync your visits', tone: 'info' },
  technical_error: { key: 'collector.outcome.technical', text: "Couldn't sync — will retry automatically", tone: 'info' },
  captured: { key: 'collector.outcome.queued', text: 'Queued — not yet synced', tone: 'info' },
};

export function outcomeMessage(outcomeOrState) {
  return MESSAGES[outcomeOrState] || { key: 'collector.outcome.queued', text: 'Queued — not yet synced', tone: 'info' };
}
