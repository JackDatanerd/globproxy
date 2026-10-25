import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { parseAutoTopup } from '@/lib/apiValidation'
import { dispatchWebhook } from '@/lib/webhooks'
import { isUuidString } from '@/lib/cursor'
import { rateLimitedUser } from '@/lib/rateLimit'
import { NextResponse } from 'next/server'

// Configures (or disables) auto-allocate on a credential the user owns.
// The actual "check usage, decide to trigger a top-up" loop lives in
// lib/autoTopup.ts, run from the usage-sync cron cycle — this route only
// ever writes the configuration, via set_auto_topup() (migration 0017),
// which is service_role-only and re-validates ownership/status itself
// (same defense-in-depth pattern as topup_credential() below it).
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
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'auto-topup')
  if (throttled) return throttled

  const { id } = await context.params
  if (!isUuidString(id)) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  // Same rules as PATCH /api/v1/sub-users/:id/auto-topup (strictly-boolean
  // `enabled`; amount > threshold; sane bounds) — one parser, so the two entry
  // points can't drift. threshold/amount are only persisted when turning this
  // on; set_auto_topup() clears both when disabled.
  const parsed = parseAutoTopup(body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const cfg = parsed.value
  const enabled = cfg.enabled
  const thresholdGb = cfg.enabled ? cfg.threshold_gb : null
  const amountGb = cfg.enabled ? cfg.amount_gb : null

  const admin = await createAdminClient()
  const { error } = await admin.rpc('set_auto_topup', {
    p_credential_id: id,
    p_user_id: user.id,
    p_enabled: enabled,
    p_threshold_gb: thresholdGb,
    p_amount_gb: amountGb,
  })

  if (error) {
    const msg = error.message ?? 'Failed to update auto-allocate settings'
    const status =
      error.code === 'P0002' || msg.includes('not found') ? 404 :
      msg.includes('reseller') ? 403 :
      400
    // Only our own RAISE EXCEPTION texts (P0001) are customer-facing.
    if (error.code !== 'P0001' && error.code !== 'P0002') {
      console.error('[auto-topup] set_auto_topup failed', id, error)
      return NextResponse.json({ error: 'Could not update auto-allocate settings. Please try again.' }, { status: 500 })
    }
    return NextResponse.json({ error: msg }, { status })
  }

  // Integrations hear about a settings change made from the dashboard too.
  await dispatchWebhook(user.id, 'auto_topup_updated', {
    credential_id: id, enabled, threshold_gb: thresholdGb, amount_gb: amountGb, source: 'dashboard',
  })

  // set_auto_topup() is deterministic given these inputs — on success the
  // row now holds exactly what was requested, so echo it back directly
  // rather than a second round-trip select just to read it back.
  return NextResponse.json({
    success: true,
    auto_topup_enabled: enabled,
    auto_topup_threshold_gb: thresholdGb,
    auto_topup_amount_gb: amountGb,
  })
}
