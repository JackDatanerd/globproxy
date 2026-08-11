import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { NextResponse } from 'next/server'

// Sets the account-level default that the "new session" form pre-fills
// its auto-allocate section from (still editable per session before
// submit). See migration 0019 — this never touches existing sessions.
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended

  const body = await req.json().catch(() => ({}))
  const enabled = Boolean(body?.enabled)
  const thresholdGb = enabled ? Number(body?.threshold_gb) : null
  const amountGb = enabled ? Number(body?.amount_gb) : null

  if (enabled) {
    if (!Number.isFinite(thresholdGb) || (thresholdGb as number) < 0) {
      return NextResponse.json({ error: 'threshold_gb must be a number ≥ 0' }, { status: 400 })
    }
    if (!Number.isFinite(amountGb) || (amountGb as number) <= 0) {
      return NextResponse.json({ error: 'amount_gb must be a number greater than 0' }, { status: 400 })
    }
  }

  const admin = await createAdminClient()
  const { error } = await admin.rpc('set_default_auto_topup', {
    p_user_id: user.id,
    p_enabled: enabled,
    p_threshold_gb: thresholdGb,
    p_amount_gb: amountGb,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 400 })

  return NextResponse.json({
    success: true,
    default_auto_topup_enabled: enabled,
    default_auto_topup_threshold_gb: thresholdGb,
    default_auto_topup_amount_gb: amountGb,
  })
}
