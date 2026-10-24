// Pure (import-free) scheduling rules for the account-deletion cool-off, so they can be
// unit-tested with `node --test` — see tests/. The routes and the 'deletions' cron task
// are the only callers.

// How long a customer has to change their mind. Short enough to honour an erasure
// request promptly, long enough to catch a hijacked session or a misclick: the owner is
// e-mailed at once, again a day before, and can cancel from Settings the whole time.
export const DELETION_COOL_OFF_DAYS = 7
// The second e-mail goes out this long before the deletion runs.
export const DELETION_REMINDER_HOURS = 24
// An attempt that keeps failing (supplier down, a payment stuck in flight) is retried
// every hour; the admin is told once when it reaches this many.
export const DELETION_ALERT_AFTER_ATTEMPTS = 3

export function scheduledAtFor(now: Date, days = DELETION_COOL_OFF_DAYS): Date {
  return new Date(now.getTime() + days * 24 * 3600_000)
}

export function isDeletionDue(scheduledAt: string | Date | null | undefined, now: Date): boolean {
  if (!scheduledAt) return false
  const t = new Date(scheduledAt).getTime()
  return Number.isFinite(t) && t <= now.getTime()
}

// Reminder is due inside the final window, once, and never for a deletion that is
// already due (it simply runs) or that was scheduled less than the window ahead.
export function isReminderDue(
  scheduledAt: string | Date | null | undefined,
  reminderSentAt: string | Date | null | undefined,
  now: Date,
  hours = DELETION_REMINDER_HOURS,
): boolean {
  if (!scheduledAt || reminderSentAt) return false
  const t = new Date(scheduledAt).getTime()
  if (!Number.isFinite(t) || t <= now.getTime()) return false
  return t - now.getTime() <= hours * 3600_000
}

// Whole days left, rounded up, never below 0 — for "your account will be deleted in N days".
export function daysUntil(when: string | Date, now: Date): number {
  const ms = new Date(when).getTime() - now.getTime()
  return ms <= 0 ? 0 : Math.ceil(ms / (24 * 3600_000))
}
