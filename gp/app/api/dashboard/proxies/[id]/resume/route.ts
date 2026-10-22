import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { resumeCredential } from '@/lib/credentialPause'
import { rateLimitedUser } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// Dashboard twin of POST /api/v1/sub-users/:id/resume. The API had it (and the
// 'customer' suspended state it creates) but a customer who only uses the
// dashboard could neither pause a session nor undo a pause. All the behaviour
// (usage sync first, upstream cap, idempotency, who may resume what) lives in
// lib/credentialPause and is shared with the API route.
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-resume')
  if (throttled) return throttled

  const { id } = await context.params
  const admin = await createAdminClient()
  const result = await resumeCredential(admin, user.id, id)
  if (!result.ok) {
    return NextResponse.json(
      { error: result.status === 404 ? 'Session not found' : result.message, code: result.code },
      { status: result.status }
    )
  }
  return NextResponse.json({ success: true, ...result.data })
}
