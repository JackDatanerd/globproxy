// How long after a transfer a reseller can take back its unused part. Must
// match c_window inside reclaim_reseller_allocation() (migration 0051).
export const RECLAIM_WINDOW_DAYS = 30

// The roster RPC (reseller_client_roster) returns at most this many rows per
// call, whatever p_limit says. Every caller that pages through it — the CSV
// export, the v1 API — must page in steps no larger than this, or it will
// mistake a full page for the last one and stop early.
export const ROSTER_MAX_PAGE = 100

export const ROSTER_FILTERS = ['all', 'unused', 'exhausted', 'idle'] as const
export const ROSTER_SORTS = ['recent', 'sent', 'used', 'remaining', 'name'] as const
export type RosterFilter = (typeof ROSTER_FILTERS)[number]
export type RosterSort = (typeof ROSTER_SORTS)[number]

// Unknown values fall back to the defaults instead of erroring: a stale
// bookmark should still show a roster.
export function parseRosterFilter(v: unknown): RosterFilter {
  return (ROSTER_FILTERS as readonly string[]).includes(String(v)) ? (v as RosterFilter) : 'all'
}
export function parseRosterSort(v: unknown): RosterSort {
  return (ROSTER_SORTS as readonly string[]).includes(String(v)) ? (v as RosterSort) : 'recent'
}

// Invitation reminders — keep in step with remind_pending_reseller_transfer()
// (migration 0072): one every 24 h, at most three per invitation.
export const INVITE_REMINDER_COOLDOWN_HOURS = 24
export const INVITE_REMINDER_MAX = 3
