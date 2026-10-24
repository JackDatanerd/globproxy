// Pure (import-free) rules for customer auto-recharge, so they can be unit-tested with
// `node --test` — see tests/. The cron task (lib/autoRecharge.ts) and the settings route are
// the only callers.

// A recharge is only attempted when the account is below its threshold...
export const RECHARGE_MIN_THRESHOLD_GB = 1
export const RECHARGE_MAX_THRESHOLD_GB = 500
// ...no more than once per cooldown (a charge can take minutes to settle; the next tick
// must not buy twice)...
export const RECHARGE_COOLDOWN_MS = 30 * 60 * 1000
// ...never beyond the customer's own rolling-30-day cap...
export const RECHARGE_MIN_CAP_USD = 1
export const RECHARGE_MAX_CAP_USD = 5000
export const RECHARGE_DEFAULT_CAP_USD = 100
// ...and switched off after this many failed charges in a row.
export const RECHARGE_MAX_FAILURES = 3

export function isBelowThreshold(availableGb: number, thresholdGb: number): boolean {
  return Number.isFinite(availableGb) && Number.isFinite(thresholdGb) && availableGb < thresholdGb
}

export function withinCap(spentLast30dUsd: number, nextUsd: number, capUsd: number): boolean {
  return spentLast30dUsd + nextUsd <= capUsd + 0.001
}

export function cooldownElapsed(lastAttemptAt: string | null | undefined, now = Date.now()): boolean {
  if (!lastAttemptAt) return true
  const t = Date.parse(lastAttemptAt)
  return !Number.isFinite(t) || now - t >= RECHARGE_COOLDOWN_MS
}

export function validThreshold(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= RECHARGE_MIN_THRESHOLD_GB && n <= RECHARGE_MAX_THRESHOLD_GB
}

export function validCap(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= RECHARGE_MIN_CAP_USD && n <= RECHARGE_MAX_CAP_USD
}
