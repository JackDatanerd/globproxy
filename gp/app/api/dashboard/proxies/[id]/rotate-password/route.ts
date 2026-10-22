import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { rotateCredentialPassword } from '@/lib/credentials'
import { rateLimitedUser } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// Replaces a session's proxy password in place (a leaked password no longer
// means delete + recreate). Every rotation is verified through the proxy
// itself before it is committed (on unless PASSWORD_ROTATION_ENABLED=false) — see
// rotateCredentialPassword. The new password is returned ONCE here and is
// also what the dashboard now shows; the old one stops working.
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
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-rotate-password')
  if (throttled) return throttled

  const { id } = await context.params
  const admin = await createAdminClient()
  const result = await rotateCredentialPassword(admin, user.id, id)
  if (!result.ok) {
    return NextResponse.json(
      { error: result.status === 404 ? 'Credential not found' : result.message },
      { status: result.status }
    )
  }
  return NextResponse.json({ success: true, password: result.data.password })
}
