import { withApiAuth } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  return withApiAuth(req, 'GET account/bandwidth', async ({ user, supabase }) => {
    const { data: bw, error } = await supabase
      .from('bandwidth_accounts')
      .select('total_gb, used_gb, allocated_gb, available_gb')
      .eq('user_id', user.id)
      .maybeSingle()
    // A failed query is NOT an empty balance. It used to fall through to the
    // `?? 0` defaults and answer 200 with all zeros — telling an automation
    // that the account had no bandwidth left.
    if (error) {
      console.error('[v1 GET account/bandwidth] query failed', error)
      return apiError(500, 'internal_error', 'Internal error. Please try again.')
    }
    return NextResponse.json({
      total_gb: bw?.total_gb ?? 0,
      used_gb: bw?.used_gb ?? 0,
      // GB already reserved into sub-users (and reseller transfers); what's
      // left to create new sub-users with is available_gb.
      allocated_gb: bw?.allocated_gb ?? 0,
      available_gb: bw?.available_gb ?? 0,
      expires: 'never',
    })
  })
}
