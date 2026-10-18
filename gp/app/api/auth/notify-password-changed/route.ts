import { createClient } from '@/lib/supabase/server'
import { flushSecurityNotices } from '@/lib/securityEvents'
import { rateLimited } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// Kept for backwards compatibility with already-loaded browser bundles.
//
// This endpoint used to BE the "your password was changed" notification: the
// browser called it after supabase.auth.updateUser({ password }), which meant
// anyone changing the password by talking to Supabase directly simply never
// triggered it. The notice is now driven by a database trigger (migration
// 0039) that records a password_changed security event however the password
// changed, and /api/auth/password flushes it immediately; the 'security' cron
// task delivers any left over.
//
// All this does now is flush the caller's own pending notices — idempotent
// (each event is claimed before sending), so a stray or repeated call can
// never produce a duplicate email or email anyone else.
export async function POST(req: Request) {
  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'password')
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  await flushSecurityNotices(user.id).catch(e => console.error('[notify-password-changed] flush failed', e))
  return NextResponse.json({ success: true })
}
