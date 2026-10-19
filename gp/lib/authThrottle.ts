import { createAdminClient } from '@/lib/supabase/server'

// Per-ACCOUNT throttles. The Cloudflare rate limiter is per IP only, so a
// botnet could guess one account's password at 10 req/min from every address.
// These counters live in Postgres (auth_throttle, migration 0043) keyed by a
// hash of the identifier, so the limit follows the account, not the IP.
async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export type ThrottleResult = 'ok' | 'blocked' | 'blocked_first'

export async function throttleHit(scope: string, identifier: string, max: number, windowS: number): Promise<ThrottleResult> {
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

export const THROTTLE_MSG = 'Too many attempts for this account. Wait 15 minutes, or use "Forgot password" to get back in right away.'
