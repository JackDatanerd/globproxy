// Pure (import-free) so it can be unit-tested with `node --test` — see tests/.
//
// The daily summary used to cover only "yesterday". It runs once a day, so when the e-mail was
// refused, the next run reported its own yesterday and the missed day was never sent. The
// marker (platform_settings.daily_summary_sent_for) holds the LAST day that was sent; this
// returns every UTC day after it up to and including `yesterday`, oldest first, capped so a
// long outage cannot turn into a flood of e-mails.
export const SUMMARY_MAX_CATCHUP_DAYS = 3

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)

export function summaryDaysDue(lastSent: string | null | undefined, yesterday: string, maxDays = SUMMARY_MAX_CATCHUP_DAYS): string[] {
  if (!DAY_RE.test(yesterday)) return []
  // Nothing recorded (or an unreadable marker): just yesterday, as before.
  if (!lastSent || !DAY_RE.test(lastSent)) return [yesterday]
  if (lastSent >= yesterday) return []
  const days: string[] = []
  for (let d = addDays(lastSent, 1); d <= yesterday && days.length < 400; d = addDays(d, 1)) days.push(d)
  return days.slice(-maxDays)
}

export function nextDay(day: string): string {
  return addDays(day, 1)
}
