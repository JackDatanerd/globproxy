import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { parseAutoTopup } from '@/lib/apiValidation'
import { rateLimitedUser } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// Sets the account-level default that the "new session" form pre-fills
// its auto-allocate section from (still editable per session before
// submit). See migration 0019 — this never touches existing sessions.
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'auto-topup-default')
  if (throttled) return throttled

  const body = await req.json().catch(() => null)
  // Same strict validation as the per-session auto top-up (strict boolean, bounds,
  // decimals, amount > threshold) so the default can never hold a value a session couldn't.
  const parsed = parseAutoTopup(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const enabled = parsed.value.enabled
  const thresholdGb = parsed.value.enabled ? parsed.value.threshold_gb : null
  const amountGb = parsed.value.enabled ? parsed.value.amount_gb : null

  const admin = await createAdminClient()
  const { error } = await admin.rpc('set_default_auto_topup', {
    p_user_id: user.id,
    p_enabled: enabled,
    p_threshold_gb: thresholdGb,
    p_amount_gb: amountGb,
  })

  if (error) {
    if (error.code === 'P0002') return NextResponse.json({ error: 'Bandwidth account not found.' }, { status: 404 })
    if (error.code === 'P0001') return NextResponse.json({ error: error.message }, { status: 400 })
    console.error('[auto-topup-default] set_default_auto_topup failed', error)
    return NextResponse.json({ error: 'Could not save your default. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    default_auto_topup_enabled: enabled,
    default_auto_topup_threshold_gb: thresholdGb,
    default_auto_topup_amount_gb: amountGb,
  })
}
