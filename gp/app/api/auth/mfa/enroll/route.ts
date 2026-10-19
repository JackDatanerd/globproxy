import { createClient } from '@/lib/supabase/server'
import { startEnrollment, publicMfaError } from '@/lib/mfa'
import { requireActiveUser } from '@/lib/apiAuth'
import { requireStepUp } from '@/lib/reauth'
import { rateLimited } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'mfa')
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  // Turning 2FA on is an account-takeover primitive in the wrong hands (an
  // attacker holding only a stolen session could attach THEIR authenticator
  // and lock the owner out), so an account without 2FA must re-enter its
  // password first. See lib/reauth.ts.
  const gate = await requireStepUp(req, user.id)
  if (gate) return gate

  try {
    const result = await startEnrollment(user.id, user.email)
    return NextResponse.json(result)
  } catch (e: any) {
    return NextResponse.json({ error: publicMfaError(e, 'Could not start MFA setup.') }, { status: 400 })
  }
}
