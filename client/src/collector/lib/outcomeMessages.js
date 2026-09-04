// Field Collector Mobile — Implementation Spec §12. The ONE place backend
// outcome vocabulary is translated to Collector-facing language. No screen
// may render a raw outcome string, action_uuid, or server error text —
// every render path for a sync outcome must go through this function.
const MESSAGES = {
  accepted: { text: 'Visit recorded', tone: 'success' },
  already_applied: { text: 'Visit recorded', tone: 'success' },
  rejected_stale: { text: "This customer's status has changed — refreshing your list", tone: 'warning' },
  rejected_invalid_state: { text: 'This task is no longer assigned to you — refreshing your list', tone: 'warning' },
  requires_reauthentication: { text: 'Please sign in again to sync your visits', tone: 'info' },
  technical_error: { text: "Couldn't sync — will retry automatically", tone: 'info' },
  captured: { text: 'Queued — not yet synced', tone: 'info' },
};

export function outcomeMessage(outcomeOrState) {
  return MESSAGES[outcomeOrState] || { text: 'Queued — not yet synced', tone: 'info' };
}
