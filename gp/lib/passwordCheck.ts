import { createAdminClient } from '@/lib/supabase/server'
import { throttleHit, throttleClear } from '@/lib/authThrottle'
import { isKnownLoginIp, requestMeta } from '@/lib/securityEvents'
import { clientKey } from '@/lib/rateLimit'

export type PasswordCheck = 'ok' | 'wrong' | 'throttled'

/**
 * Verifies an account's CURRENT password (change-password, change-email,
 * 2FA recovery request and the re-auth prompt).
 *
 * The comparison happens in Postgres (auth_verify_password, migration 0050):
 * bcrypt against the hash GoTrue stores. It deliberately does NOT sign in
 * through GoTrue — that path (a) fails every time when Supabase CAPTCHA is
 * enabled because the probe has no token, (b) creates and deletes a real
 * session per check, and (c) counts against GoTrue's per-IP sign-in limit,
 * which for server-side calls is shared by every customer.
 *
 * Throttling (two layers, same idea as the login form):
 *  1. account + connection: 8 attempts / 15 min. Only the connection that kept
 *     guessing is paused, so a stolen session on another network cannot use up
 *     the owner's budget.
 *  2. account-wide ceiling: 40 / 15 min across every connection. Past it only
 *     connections this account has signed in from before may keep trying.
 * Both fail CLOSED: this gate protects sensitive actions, so a throttle outage
 * must not turn it into an unlimited password oracle. A database error in the
 * comparison itself is likewise treated as 'wrong'.
 */
export async function verifyCurrentPassword(userId: string, email: string, password: string, req?: Request): Promise<PasswordCheck> {
  const conn = (req ? clientKey(req) : null) ?? 'noip'
  const gate = await throttleHit('pwcheck', `${userId}|${conn}`, 8, 15 * 60, { failClosed: true })
  if (gate !== 'ok') return 'throttled'

  const acct = await throttleHit('pwcheckacct', userId, 40, 15 * 60, { failClosed: true })
  if (acct !== 'ok') {
    const ip = req ? requestMeta(req).ip : null
    if (!(await isKnownLoginIp(email, ip))) return 'throttled'
  }

  if (typeof password !== 'string' || !password || new TextEncoder().encode(password).length > 72) return 'wrong'

  try {
    const admin = await createAdminClient()
    const { data, error } = await admin.rpc('auth_verify_password', { p_user_id: userId, p_password: password })
    if (error) throw error
    if (data !== true) return 'wrong'
  } catch (e) {
    console.error('[passwordCheck] auth_verify_password failed', e)
    return 'wrong'
  }
  await throttleClear('pwcheck', `${userId}|${conn}`)
  return 'ok'
}

export const PASSWORD_THROTTLED_MSG = 'Too many incorrect attempts. Please wait a few minutes and try again.'
