import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimitedUser } from '@/lib/rateLimit'
import { deleteCredential, updateCredentialSettings } from '@/lib/credentials'
import { NextResponse } from 'next/server'

export async function DELETE(
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
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-delete')
  if (throttled) return throttled

  const { id } = await context.params

  // Ownership, the reseller-allocation block, upstream-delete-must-succeed,
  // and the release/archive bookkeeping all live in lib/credentials.ts —
  // shared with DELETE /api/v1/sub-users/:id.
  const admin = await createAdminClient()
  const result = await deleteCredential(admin, user.id, id, 'dashboard')
  if (!result.ok) {
    return NextResponse.json(
      { error: result.status === 404 ? 'Credential not found' : result.message },
      { status: result.status }
    )
  }
  // The lib already knows how much went back to the balance and how much was
  // used; the dashboard shows it instead of a bare "deleted".
  return NextResponse.json({ success: true, gb_released: result.data?.gb_released ?? 0, gb_used: result.data?.gb_used ?? 0 })
}

// Edit in place — label, targeting, protocol, session type, sticky lifetime,
// endpoint count. DB-only (see updateCredentialSettings in lib/credentials.ts,
// shared with PATCH /api/v1/sub-users/:id): changing where a session exits
// never needs the delete/recreate round trip.
export async function PATCH(
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
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-edit')
  if (throttled) return throttled

  const { id } = await context.params
  const body = await req.json().catch(() => null)

  const admin = await createAdminClient()
  const result = await updateCredentialSettings(admin, user.id, id, body)
  if (!result.ok) {
    return NextResponse.json(
      { error: result.status === 404 ? 'Credential not found' : result.message },
      { status: result.status }
    )
  }
  return NextResponse.json({ success: true })
}
