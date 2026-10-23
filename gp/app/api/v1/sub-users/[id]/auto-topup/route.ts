import { withApiAuth, readJsonBody } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { parseAutoTopup } from '@/lib/apiValidation'
import { dispatchWebhook } from '@/lib/webhooks'
import { isUuidString } from '@/lib/cursor'
import { NextResponse } from 'next/server'

// PATCH /api/v1/sub-users/:id/auto-topup
//   { "enabled": true, "threshold_gb": 1, "amount_gb": 5 }  |  { "enabled": false }
// Mirrors app/api/dashboard/proxies/[id]/auto-topup/route.ts (same validation:
// lib/apiValidation.ts parseAutoTopup).
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'PATCH auto-topup', async ({ user, supabase }) => {
    const { id } = await context.params
    if (!isUuidString(id)) return apiError(404, 'not_found', 'Sub-user not found')
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
      // Only our own RAISE EXCEPTION texts (P0001) are customer-facing — and they are
      // the caller's problem (400/403). Anything else is ours: a 500, with the raw
      // Postgres text going to the log only (it used to come back as a 400).
      if (error.code !== 'P0001') {
        console.error('[v1 PATCH auto-topup] set_auto_topup failed', id, error)
        return apiError(500, 'internal_error', 'Could not update auto top-up settings. Please try again.')
      }
      if (msg.includes('reseller')) return apiError(403, 'forbidden', msg)
      return apiError(400, 'invalid_request', msg)
    }

    await dispatchWebhook(user.id, 'auto_topup_updated', {
      credential_id: id, enabled: cfg.enabled, threshold_gb: thresholdGb, amount_gb: amountGb, source: 'api',
    })

    return NextResponse.json({
      success: true,
      auto_topup_enabled: cfg.enabled,
      auto_topup_threshold_gb: thresholdGb,
      auto_topup_amount_gb: amountGb,
    })
  })
}
