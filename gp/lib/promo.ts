// The M-Pesa launch offer: a percentage off any M-Pesa order placed while the offer is live.
//
// Pure and import-free so it can be unit-tested with `node --test` (see tests/) and used by
// the server (lib/fx.ts, /api/checkout) and the browser (buy page) alike — what a customer
// sees and what is charged both come from these functions, so they cannot disagree.
//
// Stored as ONE JSON value in platform_settings under PROMO_KEY, edited from
// Admin → Settings → "M-Pesa offer". All times are UTC instants (ISO strings).

export const PROMO_KEY = 'mpesa_promo'
// A typo guard, not a business rule: an admin cannot set a discount above this.
export const MAX_PROMO_PCT = 50
// ...and cannot set an end date further out than this, so a mistyped year ends a promo "never".
export const MAX_PROMO_DAYS = 90
export const MAX_LABEL_LEN = 40

export interface MpesaPromo {
  enabled: boolean
  percent: number            // 0 < percent <= MAX_PROMO_PCT, at most 2 decimals
  startsAt: string | null    // ISO UTC; null = already started
  endsAt: string             // ISO UTC; the offer is live while now < endsAt
  label: string              // shown to customers, e.g. "Launch offer"
}

export type PromoState = 'live' | 'scheduled' | 'ended' | 'off'

const round2 = (n: number) => Math.round(n * 100) / 100

export function validPercent(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_PROMO_PCT && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6
}

export function cleanLabel(v: unknown): string {
  // Plain text only: it is rendered in the buy page and written into e-mails.
  return String(v ?? '').replace(/[<>\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LEN)
}

const isoOrNull = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** Reads the stored value. Anything missing, corrupt or out of range is "no offer" — a bad
 *  row must never turn into a surprise discount. */
export function parsePromo(raw: string | null | undefined): MpesaPromo | null {
  if (!raw) return null
  let j: any
  try { j = JSON.parse(raw) } catch { return null }
  if (!j || typeof j !== 'object') return null
  const endsAt = isoOrNull(j.endsAt)
  const startsAt = isoOrNull(j.startsAt)
  if (!endsAt || !validPercent(j.percent)) return null
  if (startsAt && Date.parse(startsAt) >= Date.parse(endsAt)) return null
  return { enabled: j.enabled === true, percent: j.percent, startsAt, endsAt, label: cleanLabel(j.label) }
}

export function serializePromo(p: MpesaPromo): string {
  return JSON.stringify({ enabled: p.enabled, percent: p.percent, startsAt: p.startsAt, endsAt: p.endsAt, label: p.label })
}

export function promoState(p: MpesaPromo | null, now: number = Date.now()): PromoState {
  if (!p || !p.enabled) return 'off'
  if (now >= Date.parse(p.endsAt)) return 'ended'
  if (p.startsAt && now < Date.parse(p.startsAt)) return 'scheduled'
  return 'live'
}

/** The offer, only while it is live; null otherwise. */
export function activePromo(p: MpesaPromo | null, now: number = Date.now()): MpesaPromo | null {
  return promoState(p, now) === 'live' ? p : null
}

/** USD total after the offer, to the cent. Never below one cent. */
export function applyPercent(totalUsd: number, percent: number): number {
  if (!(totalUsd > 0) || !(percent > 0)) return totalUsd
  return Math.max(round2(totalUsd * (1 - percent / 100)), 0.01)
}

/** What the customer is told about an offer (and what /api/checkout/options returns). */
export interface PublicPromo { percent: number; ends_at: string; label: string }
export const publicPromo = (p: MpesaPromo | null): PublicPromo | null =>
  p ? { percent: p.percent, ends_at: p.endsAt, label: p.label } : null

/** "6 Nov 2026, 23:59 UTC" — always UTC, so a customer in any timezone reads the same deadline. */
export function formatUtc(iso: string): string {
  const d = new Date(iso)
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`
}

/** Moves the end of the offer later. A live offer is extended from its current end; one that has
 *  already ended is restarted from now, so "extend by a day" always means "a day from now at least". */
export function extendedEnd(p: MpesaPromo, hours: number, now: number = Date.now()): string {
  const base = Math.max(Date.parse(p.endsAt), now)
  return new Date(base + hours * 3_600_000).toISOString()
}

/** null when `endsAt` is acceptable, else why not. */
export function endProblem(endsAt: string, startsAt: string | null, now: number = Date.now()): string | null {
  const t = Date.parse(endsAt)
  if (Number.isNaN(t)) return 'The end time is not a valid date.'
  if (t > now + MAX_PROMO_DAYS * 86_400_000) return `The offer cannot run more than ${MAX_PROMO_DAYS} days ahead — check the year.`
  if (startsAt && Date.parse(startsAt) >= t) return 'The offer must end after it starts.'
  return null
}

/** The same instant in Nairobi (UTC+3, no daylight saving): "7 Nov 2026, 02:59 EAT". For announcements to Kenyan
 *  customers, who otherwise read "23:59 UTC" as midnight local time. */
export function formatEat(iso: string): string {
  return formatUtc(new Date(Date.parse(iso) + 3 * 3_600_000).toISOString()).replace(' UTC', ' EAT')
}
