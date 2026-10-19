import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { throttleHit, throttleClear } from '@/lib/authThrottle'

export type PasswordCheck = 'ok' | 'wrong' | 'throttled'

/**
 * Verifies an account's CURRENT password (used by change-password,
 * change-email and the re-auth prompt).
 *
 * The check signs in on a throwaway client. That creates a real GoTrue
 * session, which must be discarded with scope 'local': signOut()'s default
 * scope is 'global', which terminates EVERY session of the user — including
 * the caller's own — so the old code signed people out of all their devices
 * just for confirming their password.
 *
 * Attempts are also counted per account (8 per 15 minutes), so these
 * endpoints can't be used by a stolen session to brute-force the password.
 */
export async function verifyCurrentPassword(userId: string, email: string, password: string): Promise<PasswordCheck> {
  const gate = await throttleHit('pwcheck', userId, 8, 15 * 60)
  if (gate !== 'ok') return 'throttled'

  const probe = createSupabaseJsClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
  const { error } = await probe.auth.signInWithPassword({ email, password })
  if (error) return 'wrong'
  await probe.auth.signOut({ scope: 'local' }).catch(() => {})
  await throttleClear('pwcheck', userId)
  return 'ok'
}

export const PASSWORD_THROTTLED_MSG = 'Too many incorrect attempts. Please wait a few minutes and try again.'
