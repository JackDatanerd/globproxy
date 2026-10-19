// Fixed calendar-date biweekly cycles: 1st–15th of a month is payable
// from the 20th of that same month; 16th–end of month is payable from
// the 5th of the following month. Deterministic on purpose — see the
// header comment in migration 0034 for why this beats a "nearest
// Friday" scheme. All dates are UTC-based (YYYY-MM-DD strings) since
// these are calendar-day boundaries, not moments in time — timezone
// shouldn't change which half of the month a commission's created_at
// falls into for this purpose.

export type PayoutCycle = {
  cycleStart: string // YYYY-MM-DD
  cycleEnd: string   // YYYY-MM-DD
  payableFrom: string // YYYY-MM-DD — first date this cycle is eligible to be run/paid
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

// The cycle a given date falls INSIDE (i.e. still accruing) — used for
// "this cycle so far" display on the affiliate's own dashboard.
export function currentAccruingCycle(date: Date = new Date()): PayoutCycle {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()

  if (day <= 15) {
    return { cycleStart: ymd(year, month, 1), cycleEnd: ymd(year, month, 15), payableFrom: ymd(year, month, 20) }
  }
  const lastDay = daysInMonth(year, month)
  const nextMonthYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return { cycleStart: ymd(year, month, 16), cycleEnd: ymd(year, month, lastDay), payableFrom: ymd(nextMonthYear, nextMonth, 5) }
}

// The most recently COMPLETED cycle as of `date` — this is what "Run
// payout cycle" should default to, since you can't pay out a cycle
// that's still accruing.
export function lastCompletedCycle(date: Date = new Date()): PayoutCycle {
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  const day = date.getUTCDate()

  if (day <= 15) {
    // We're in the 1st–15th cycle (still accruing) — the last completed
    // one is 16th–end of the PREVIOUS month.
    const prevMonthYear = month === 1 ? year - 1 : year
    const prevMonth = month === 1 ? 12 : month - 1
    const lastDay = daysInMonth(prevMonthYear, prevMonth)
    return { cycleStart: ymd(prevMonthYear, prevMonth, 16), cycleEnd: ymd(prevMonthYear, prevMonth, lastDay), payableFrom: ymd(year, month, 5) }
  }
  // We're in the 16th–end cycle (still accruing) — the last completed
  // one is 1st–15th of THIS month.
  return { cycleStart: ymd(year, month, 1), cycleEnd: ymd(year, month, 15), payableFrom: ymd(year, month, 20) }
}

// Reconstructs a full cycle purely from its start date — cycleEnd and
// payableFrom are always DERIVED, never trusted as separate input. Used
// by the admin cycle-sales report to turn a `?start=` query param into
// a real cycle without letting the URL hand it an arbitrary/mismatched
// end date. Only valid for a start date that's actually the 1st or the
// 16th of a month — callers should validate that before calling this.
export function cycleFromStart(cycleStart: string): PayoutCycle {
  const [year, month, day] = cycleStart.split('-').map(Number)
  if (day === 1) {
    return { cycleStart: ymd(year, month, 1), cycleEnd: ymd(year, month, 15), payableFrom: ymd(year, month, 20) }
  }
  const lastDay = daysInMonth(year, month)
  const nextMonthYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return { cycleStart: ymd(year, month, 16), cycleEnd: ymd(year, month, lastDay), payableFrom: ymd(nextMonthYear, nextMonth, 5) }
}

// The cycle immediately before / after a given cycle — same
// 1st–15th / 16th–end split as everywhere else in this file, just
// walked from an arbitrary cycle instead of from "today". Used for
// Prev/Next navigation on the admin cycle-sales report.
export function cycleBefore(cycle: PayoutCycle): PayoutCycle {
  const [year, month, day] = cycle.cycleStart.split('-').map(Number)
  if (day === 1) {
    // This cycle was 1st–15th — the previous one is 16th–end of the prior month.
    const prevMonthYear = month === 1 ? year - 1 : year
    const prevMonth = month === 1 ? 12 : month - 1
    const lastDay = daysInMonth(prevMonthYear, prevMonth)
    return { cycleStart: ymd(prevMonthYear, prevMonth, 16), cycleEnd: ymd(prevMonthYear, prevMonth, lastDay), payableFrom: ymd(year, month, 5) }
  }
  // This cycle was 16th–end — the previous one is 1st–15th of the same month.
  return { cycleStart: ymd(year, month, 1), cycleEnd: ymd(year, month, 15), payableFrom: ymd(year, month, 20) }
}

export function cycleAfter(cycle: PayoutCycle): PayoutCycle {
  const [year, month, day] = cycle.cycleStart.split('-').map(Number)
  if (day === 1) {
    // This cycle was 1st–15th — the next one is 16th–end of the same month.
    const lastDay = daysInMonth(year, month)
    const nextMonthYear = month === 12 ? year + 1 : year
    const nextMonth = month === 12 ? 1 : month + 1
    return { cycleStart: ymd(year, month, 16), cycleEnd: ymd(year, month, lastDay), payableFrom: ymd(nextMonthYear, nextMonth, 5) }
  }
  // This cycle was 16th–end — the next one is 1st–15th of the following month.
  const nextMonthYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return { cycleStart: ymd(nextMonthYear, nextMonth, 1), cycleEnd: ymd(nextMonthYear, nextMonth, 15), payableFrom: ymd(nextMonthYear, nextMonth, 20) }
}

export function formatCycleLabel(cycle: { cycle_start: string; cycle_end: string } | PayoutCycle): string {
  const start = 'cycleStart' in cycle ? cycle.cycleStart : cycle.cycle_start
  const end = 'cycleEnd' in cycle ? cycle.cycleEnd : cycle.cycle_end
  const fmt = (s: string) => new Date(s + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  return `${fmt(start)} – ${fmt(end)}`
}

// True once the published "payable from" date has arrived.
export function cycleIsPayable(cycle: { payableFrom: string }, now: Date = new Date()): boolean {
  return cycle.payableFrom <= now.toISOString().slice(0, 10)
}
