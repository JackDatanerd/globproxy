import { createAdminClient } from '@/lib/supabase/server'

// Per-ACCOUNT throttles. The Cloudflare rate limiter is per IP only, so a
// botnet could guess one account's password at 10 req/min from every address.
// These counters live in Postgres (auth_throttle, migration 0045) keyed by a
// hash of the identifier, so the limit follows the account, not the IP.
async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export type ThrottleResult = 'ok' | 'blocked' | 'blocked_first'

// `failClosed`: for limits that guard a password check (a stolen session probing the
// current password). An outage there answers 'blocked' instead of waving the guess through.
export async function throttleHit(scope: string, identifier: string, max: number, windowS: number, opts: { failClosed?: boolean } = {}): Promise<ThrottleResult> {
  try {
    const admin = await createAdminClient()
    const { data, error } = await admin.rpc('auth_throttle_hit', {
      p_key: `${scope}:${await sha256Hex(identifier.trim().toLowerCase())}`,
      p_max: max,
      p_window_s: windowS,
    })
    if (error) throw error
    return data === 'blocked_first' ? 'blocked_first' : data === 'blocked' ? 'blocked' : 'ok'
  } catch (e) {
    if (opts.failClosed) {
      console.error('[authThrottle] hit failed — blocking (fail-closed scope)', scope, e)
      return 'blocked'
    }
    // Fail open: a throttle outage must not take sign-in down with it.
    console.error('[authThrottle] hit failed — allowing', scope, e)
    return 'ok'
  }
}

export async function throttleClear(scope: string, identifier: string): Promise<void> {
  try {
    const admin = await createAdminClient()
    await admin.rpc('auth_throttle_clear', { p_key: `${scope}:${await sha256Hex(identifier.trim().toLowerCase())}` })
  } catch (e) {
    console.error('[authThrottle] clear failed', scope, e)
  }
}

// Hard limit, per account AND connection: only the address that kept guessing is paused.
export const THROTTLE_MSG = 'Too many sign-in attempts from this connection. Wait 15 minutes and try again, or use "Forgot password".'
// Account-wide ceiling under a sustained distributed attack: only connections
// this account has signed in from before may keep trying.
export const THROTTLE_ACCOUNT_MSG = 'There have been a lot of sign-in attempts on this account. From a new location, use "Forgot password" — resetting your password by email lifts this pause immediately — or wait 15 minutes.'
