import { withApiAuth, readJsonBody } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { cleanNumber } from '@/lib/validation'
import { NextResponse } from 'next/server'

// GET   /api/v1/reseller/settings — your stock position and the low-stock alert level.
// PATCH /api/v1/reseller/settings { "low_stock_gb": 50 } — set the alert level (null or 0
//   turns the alert off). The same setting as the dashboard's Stock alert.
// `reserved_in_invitations_gb` is stock held for invitations nobody has claimed yet; it
// is already out of `available_gb`.
async function stock(supabase: any, userId: string) {
  const [{ data: bw }, { data: profile }, { data: open }] = await Promise.all([
    supabase.from('bandwidth_accounts').select('total_gb, allocated_gb, available_gb').eq('user_id', userId).maybeSingle(),
    supabase.from('profiles').select('role, reseller_low_stock_gb').eq('id', userId).maybeSingle(),
    supabase.from('reseller_pending_transfers').select('gb_amount').eq('reseller_id', userId).eq('status', 'pending').limit(1000),
  ])
  const r3 = (n: unknown) => Math.round(Number(n ?? 0) * 1000) / 1000
  return {
    role: profile?.role as string | undefined,
    body: {
      total_gb: r3(bw?.total_gb), allocated_gb: r3(bw?.allocated_gb), available_gb: r3(bw?.available_gb),
      reserved_in_invitations_gb: r3((open ?? []).reduce((a: number, r: any) => a + Number(r.gb_amount), 0)),
      low_stock_gb: profile?.reseller_low_stock_gb == null ? null : Number(profile.reseller_low_stock_gb),
    },
  }
}

export async function GET(req: Request) {
  return withApiAuth(req, 'GET reseller settings', async ({ user, supabase }) => {
    const s = await stock(supabase, user.id)
    if (!['reseller', 'admin'].includes(s.role ?? '')) return apiError(403, 'reseller_required', 'Reseller access required.')
    return NextResponse.json(s.body)
  })
}

export async function PATCH(req: Request) {
  return withApiAuth(req, 'PATCH reseller settings', async ({ user, supabase }) => {
    const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle()
    if (!['reseller', 'admin'].includes(profile?.role ?? '')) return apiError(403, 'reseller_required', 'Reseller access required.')
    const json = await readJsonBody(req)
    if (!json.ok) return json.response
    const body = json.body
    if (!body || typeof body !== 'object' || !('low_stock_gb' in body)) return apiError(400, 'invalid_request', 'low_stock_gb is required (a number, or null to turn the alert off).')

    let value: number | null = null
    if (body.low_stock_gb !== null && body.low_stock_gb !== '') {
      const n = cleanNumber(body.low_stock_gb)
      if (n === null || n < 0 || n > 1_000_000 || Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-6) {
        return apiError(400, 'invalid_request', 'low_stock_gb must be between 0 and 1,000,000 GB (up to 3 decimals), or null to turn the alert off.')
      }
      value = n === 0 ? null : Math.round(n * 1000) / 1000
    }
    const { error } = await supabase.from('profiles')
      .update({ reseller_low_stock_gb: value, reseller_low_stock_alerted_at: null }).eq('id', user.id)
    if (error) {
      console.error('[v1 PATCH reseller settings] update failed', error)
      return apiError(500, 'internal_error', 'Internal error. Please try again.')
    }
    return NextResponse.json({ success: true, low_stock_gb: value })
  })
}
