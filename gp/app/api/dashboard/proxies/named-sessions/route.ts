import { requireMfaVerified } from '@/lib/mfa'
import { createClient } from '@/lib/supabase/server'
import { rateLimitedUser } from '@/lib/rateLimit'
import { fetchAllRows } from '@/lib/dbPaging'
import { NextResponse } from 'next/server'

// GET /api/dashboard/proxies/named-sessions — every live named sticky session of the
// caller, across all their credentials, in ONE read. "Export" used to call
// /proxies/:id/sessions once per sticky credential, sequentially.
export async function GET(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-sessions')
  if (throttled) return throttled

  const { rows, error } = await fetchAllRows<{ credential_id: string; session_token: string; label: string }>((from, to) =>
    supabase.from('proxy_sessions')
      .select('credential_id, session_token, label')
      .eq('user_id', user.id).is('terminated_at', null)
      .order('credential_id').order('created_at', { ascending: true }).order('id')
      .range(from, to)
  )
  if (error) {
    console.error('[dashboard/proxies/named-sessions] db error:', error)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
  return NextResponse.json({ sessions: rows })
}
