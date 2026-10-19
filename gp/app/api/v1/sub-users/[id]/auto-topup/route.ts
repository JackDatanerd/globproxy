import { withApiAuth, readJsonBody } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseFiniteNumber } from '@/lib/apiValidation'
import { NextResponse } from 'next/server'

// PATCH /api/v1/sub-users/:id/auto-topup
//   { "enabled": true, "threshold_gb": 1, "amount_gb": 5 }  |  { "enabled": false }
// Mirrors app/api/dashboard/proxies/[id]/auto-topup/route.ts.
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'PATCH auto-topup', async ({ user, supabase }) => {
    const { id } = await context.params
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const body = json.body

    // Strictly boolean: Boolean("false") is true, so a string "false" used to
    // ENABLE auto top-up (which spends the account's balance automatically).
    if (typeof body?.enabled !== 'boolean') return apiError(400, 'invalid_request', 'enabled must be a boolean.')
    const enabled: boolean = body.enabled

    let thresholdGb: number | null = null
    let amountGb: number | null = null
    if (enabled) {
      thresholdGb = parseFiniteNumber(body.threshold_gb)
      amountGb = parseFiniteNumber(body.amount_gb)
      if (thresholdGb === null || thresholdGb < 0) return apiError(400, 'invalid_request', 'threshold_gb must be a number ≥ 0')
      if (amountGb === null || amountGb <= 0) return apiError(400, 'invalid_request', 'amount_gb must be a number greater than 0')
      if (amountGb <= thresholdGb) return apiError(400, 'invalid_request', 'amount_gb must be greater than threshold_gb')
    }

    const { error } = await supabase.rpc('set_auto_topup', {
      p_credential_id: id, p_user_id: user.id, p_enabled: enabled, p_threshold_gb: thresholdGb, p_amount_gb: amountGb,
    })
    if (error) {
      const msg = error.message ?? 'Failed to update auto-allocate settings'
      if (error.code === 'P0002' || msg.includes('not found')) return apiError(404, 'not_found', 'Sub-user not found')
      if (msg.includes('reseller')) return apiError(403, 'forbidden', msg)
      return apiError(400, 'invalid_request', msg)
    }

    return NextResponse.json({
      success: true,
      auto_topup_enabled: enabled,
      auto_topup_threshold_gb: thresholdGb,
      auto_topup_amount_gb: amountGb,
    })
  })
}
