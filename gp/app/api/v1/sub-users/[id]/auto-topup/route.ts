import { requireApiAccess } from '@/lib/apiAuth'
import { NextResponse } from 'next/server'

// Mirrors app/api/dashboard/proxies/[id]/auto-topup/route.ts.
export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAccess(req)
  if (!auth.ok) return auth.response
  const { user, supabase } = auth

  const { id } = await context.params

  try {
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

    const { error } = await supabase.rpc('set_auto_topup', {
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

    return NextResponse.json({
      success: true,
      auto_topup_enabled: enabled,
      auto_topup_threshold_gb: thresholdGb,
      auto_topup_amount_gb: amountGb,
    })
  } catch (e: any) {
    console.error('[v1 auto-topup] unexpected error:', e)
    return NextResponse.json({ error: 'Internal error. Please try again.' }, { status: 500 })
  }
}
