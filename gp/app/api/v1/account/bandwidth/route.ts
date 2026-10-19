import { withApiAuth } from '@/lib/apiHelpers'
import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  return withApiAuth(req, 'GET account/bandwidth', async ({ user, supabase }) => {
    const { data: bw } = await supabase
      .from('bandwidth_accounts')
      .select('total_gb, used_gb, allocated_gb, available_gb')
      .eq('user_id', user.id)
      .maybeSingle()
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
