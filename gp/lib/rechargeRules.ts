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

// ── charge outcomes ─────────────────────────────────────────
// charge_authorization statuses that mean "the customer has to do something" (an OTP,
// a PIN, a 3-D Secure page...). Nobody is present to do it on an automatic top-up, so
// the attempt is a failure — left pending it would be retried every cooldown and send
// the customer a stream of codes for a charge that can never complete.
const NEEDS_CUSTOMER = new Set(['send_otp', 'send_pin', 'send_phone', 'send_birthday', 'send_address', 'open_url', 'pay_offline'])
export function needsCustomerAction(status: string): boolean {
  return NEEDS_CUSTOMER.has(status)
}
export const NEEDS_CUSTOMER_REASON = 'Your card needs extra verification (an OTP or 3-D Secure), which cannot be done on an automatic top-up.'

// ── an earlier attempt that is not settled yet ──────────
// A charge can sit unconfirmed for a while (slow bank, a webhook not yet landed, a
// request whose answer we never saw). While the last attempt is still open the rule must
// not charge again — the balance is still low only because the first top-up has not been
// credited. A cancelled-but-unpaid order counts too: the buy page cancels other unpaid
// orders, but a charge that is already in flight still settles and credits.
export const ATTEMPT_OPEN_MS = 3 * 60 * 60 * 1000
export function attemptStillOpen(
  prev: { payment_status?: string | null; bandwidth_credited?: boolean | null; created_at?: string | null } | null | undefined,
  now = Date.now(),
): boolean {
  if (!prev || prev.bandwidth_credited) return false
  if (prev.payment_status !== 'pending' && prev.payment_status !== 'cancelled') return false
  const t = Date.parse(prev.created_at ?? '')
  return Number.isFinite(t) && now - t < ATTEMPT_OPEN_MS
}

// ── what the rule has spent (the cap's yardstick) ───────────
// One definition for the cron that enforces the cap AND the dashboard that reports it:
// pending orders count in full (they may yet be paid); paid ones count net of refunds.
export function orderSpend(rows: Array<{ payment_status?: string | null; amount_usd?: number | string | null; refunded_usd?: number | string | null }>): number {
  let total = 0
  for (const o of rows) {
    const amount = Number(o.amount_usd ?? 0)
    if (!Number.isFinite(amount)) continue
    if (o.payment_status === 'pending') total += amount
    else if (o.payment_status === 'paid') total += Math.max(amount - Number(o.refunded_usd ?? 0), 0)
  }
  return Math.round(total * 100) / 100
}

// ── saved-card expiry ───────────────────────────────────────
export const CARD_WARN_DAYS = 30

// The instant a card stops being valid: the start of the month AFTER its expiry month
// (a card marked 12/2030 works through 31 December). Paystack gives "12" / "2030"; a
// two-digit year is read as 20xx. null when the values do not parse.
export function cardValidUntil(expMonth: unknown, expYear: unknown): number | null {
  const m = Number(String(expMonth ?? '').trim())
  let y = Number(String(expYear ?? '').trim())
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y) || y <= 0) return null
  if (y < 100) y += 2000
  return Date.UTC(y, m, 1)
}
export function cardExpired(expMonth: unknown, expYear: unknown, now = Date.now()): boolean {
  const until = cardValidUntil(expMonth, expYear)
  return until !== null && until <= now
}
export function cardExpiresSoon(expMonth: unknown, expYear: unknown, now = Date.now(), days = CARD_WARN_DAYS): boolean {
  const until = cardValidUntil(expMonth, expYear)
  return until !== null && until > now && until <= now + days * 86_400_000
}
// "12/2030" — the last month the card works.
export function cardExpiryLabel(expMonth: unknown, expYear: unknown): string | null {
  const m = Number(String(expMonth ?? '').trim())
  let y = Number(String(expYear ?? '').trim())
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y) || y <= 0) return null
  if (y < 100) y += 2000
  return `${String(m).padStart(2, '0')}/${y}`
}
