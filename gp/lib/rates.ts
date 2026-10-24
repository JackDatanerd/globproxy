// Pure (no server imports) so client components can use it too.

// Standard affiliate terms for a newly approved affiliate.
export const DEFAULT_AFFILIATE_INTRO_RATE = 0.3
export const DEFAULT_AFFILIATE_LIFETIME_RATE = 0.15

// Verified Operators: fixed affiliate terms, set only by the grant route.
export const VERIFIED_OPERATOR_INTRO_RATE = 0.4
export const VERIFIED_OPERATOR_LIFETIME_RATE = 0.2

// Ceiling for a hand-set affiliate rate: the Verified Operator rates are the most
// this product's margins were designed around, so no manual approval or edit may
// exceed them (a typo such as 1 instead of 0.1 used to pay out 100%).
export const MAX_AFFILIATE_INTRO_RATE = VERIFIED_OPERATOR_INTRO_RATE
export const MAX_AFFILIATE_LIFETIME_RATE = VERIFIED_OPERATOR_LIFETIME_RATE

// null when valid, otherwise a message fit to show the admin.
export function validateAffiliateRates(intro: unknown, lifetime: unknown): string | null {
  const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1
  if (!num(intro) || !num(lifetime)) return 'Commission rates must be numbers between 0 and 1'
  if (intro > MAX_AFFILIATE_INTRO_RATE + 1e-9) return `The first-90-days rate cannot exceed ${MAX_AFFILIATE_INTRO_RATE * 100}%`
  if (lifetime > MAX_AFFILIATE_LIFETIME_RATE + 1e-9) return `The lifetime rate cannot exceed ${MAX_AFFILIATE_LIFETIME_RATE * 100}%`
  return null
}

// 30% → "30%", 12.5% → "12.5%" (Math.round(rate*100) used to print 13%).
export function formatRatePct(rate: number | null | undefined): string {
  const pct = Number(rate ?? 0) * 100
  return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(1))}%`
}

// The number a percent prompt should be pre-filled with: exact, never rounded.
export function ratePctValue(rate: number | null | undefined): string {
  const pct = Number(rate ?? 0) * 100
  return String(Number.isInteger(pct) ? pct : Number(pct.toFixed(2)))
}

// How long a Verified Operator keeps the higher rates before an admin is asked
// to look again (referral quality, flagged ratio, volume). The status used to be
// permanent once granted; "Mark reviewed" on the affiliate page restarts the clock.
export const VERIFIED_OPERATOR_REVIEW_DAYS = 180

// When a Verified Operator is next due a review: the later of the grant date and
// the last recorded review, plus VERIFIED_OPERATOR_REVIEW_DAYS. null = not an operator.
export function verifiedOperatorReviewDue(since: string | null | undefined, lastReviewedAt: string | null | undefined): Date | null {
  const base = [since, lastReviewedAt].filter(Boolean).map(d => new Date(d as string).getTime()).filter(t => Number.isFinite(t))
  if (base.length === 0) return null
  return new Date(Math.max(...base) + VERIFIED_OPERATOR_REVIEW_DAYS * 86_400_000)
}
