import { createClient } from '@/lib/supabase/server'
import { verifyFactor } from '@/lib/mfa'
import { rateLimited } from '@/lib/rateLimit'
import { withMfaCookie } from '../_cookie'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'mfa')
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { code, remember } = await req.json().catch(() => ({}))
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Enter your 6-digit code or a backup code.' }, { status: 400 })
  }

  try {
    const { session_token, session_ttl_s, used_backup_code, backup_codes_remaining } =
      await verifyFactor(user.id, user.email, code, { remember: remember === true, req })
    const res = NextResponse.json({ used_backup_code, backup_codes_remaining, remembered: session_ttl_s > 12 * 60 * 60 })
    return withMfaCookie(res, session_token, session_ttl_s)
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Could not verify code.' }, { status: 400 })
  }
}
