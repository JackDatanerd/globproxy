import { withApiAuth, readJsonBody } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseAutoTopup } from '@/lib/apiValidation'
import { rpcUserMessage } from '@/lib/dbErrors'
import { NextResponse } from 'next/server'

// PATCH /api/v1/sub-users/:id/auto-topup
//   { "enabled": true, "threshold_gb": 1, "amount_gb": 5 }  |  { "enabled": false }
// Mirrors app/api/dashboard/proxies/[id]/auto-topup/route.ts (same validation:
// lib/apiValidation.ts parseAutoTopup).
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'PATCH auto-topup', async ({ user, supabase }) => {
    const { id } = await context.params
    const json = await readJsonBody(req)
    if (!json.ok) return json.response

    const parsed = parseAutoTopup(json.body)
    if (!parsed.ok) return apiError(400, 'invalid_request', parsed.error)
    const cfg = parsed.value
    const thresholdGb = cfg.enabled ? cfg.threshold_gb : null
    const amountGb = cfg.enabled ? cfg.amount_gb : null

    const { error } = await supabase.rpc('set_auto_topup', {
      p_credential_id: id, p_user_id: user.id, p_enabled: cfg.enabled, p_threshold_gb: thresholdGb, p_amount_gb: amountGb,
    })
    if (error) {
      const msg = error.message ?? ''
      if (error.code === 'P0002' || msg.includes('not found')) return apiError(404, 'not_found', 'Sub-user not found')
      if (msg.includes('reseller')) return apiError(403, 'forbidden', msg)
      // Only our own RAISE messages reach the caller; raw Postgres text never does.
      return apiError(400, 'invalid_request', rpcUserMessage(error, 'Could not update auto top-up settings.'))
    }

    return NextResponse.json({
      success: true,
      auto_topup_enabled: cfg.enabled,
      auto_topup_threshold_gb: thresholdGb,
      auto_topup_amount_gb: amountGb,
    })
  })
}
