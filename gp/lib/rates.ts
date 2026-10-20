// Pure (no server imports) so client components can use it too.

// Standard affiliate terms for a newly approved affiliate.
export const DEFAULT_AFFILIATE_INTRO_RATE = 0.3
export const DEFAULT_AFFILIATE_LIFETIME_RATE = 0.15

// Verified Operators: fixed affiliate terms, set only by the grant route.
export const VERIFIED_OPERATOR_INTRO_RATE = 0.4
export const VERIFIED_OPERATOR_LIFETIME_RATE = 0.2

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
