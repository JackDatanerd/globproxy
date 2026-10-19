import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
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

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const { id } = await context.params
  const body = await req.json().catch(() => ({}))
  // Strictly `=== true`: Boolean("false") is true, so a stringly-typed "false" would otherwise ENABLE auto top-up.
  const enabled = body?.enabled === true

  // threshold/amount are only required (and only persisted) when turning
  // this on — set_auto_topup() clears both to null when disabled, so
  // there's no stale config left half-applied.
  const thresholdGb = enabled ? Number(body?.threshold_gb) : null
  const amountGb = enabled ? Number(body?.amount_gb) : null

  if (enabled) {
    if (!Number.isFinite(thresholdGb) || (thresholdGb as number) < 0) {
      return NextResponse.json({ error: 'threshold_gb must be a number ≥ 0' }, { status: 400 })
    }
    if (!Number.isFinite(amountGb) || (amountGb as number) <= 0) {
      return NextResponse.json({ error: 'amount_gb must be a number greater than 0' }, { status: 400 })
    }
    // amount must exceed threshold: otherwise a top-up can leave the session
    // still at/below its own threshold, and the cron re-fires every tick,
    // draining the account balance into a session that never clears the line.
    if ((amountGb as number) <= (thresholdGb as number)) {
      return NextResponse.json({ error: 'amount_gb must be greater than threshold_gb' }, { status: 400 })
    }
  }

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
    return NextResponse.json({ error: msg }, { status })
  }

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
