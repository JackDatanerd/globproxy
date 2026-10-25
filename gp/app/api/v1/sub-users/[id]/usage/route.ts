import { withApiAuth } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { getOwnedCredential, toApiCredential } from '@/lib/credentials'
import { refreshLiveUsage } from '@/lib/usageLive'
import { NextResponse } from 'next/server'

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'GET sub-user usage', async ({ user, supabase }) => {
    const { id } = await context.params
    const cred = await getOwnedCredential(supabase, user.id, id, '*')
    if (!cred) return apiError(404, 'not_found', 'Sub-user not found')

    const { usedGb, syncedAt } = await refreshLiveUsage(supabase, user.id, cred)

    const full = toApiCredential({ ...cred, gb_used: usedGb })
    return NextResponse.json({
      id: full.id, label: full.label, status: full.status, protocol: full.protocol, session_type: full.session_type,
      gb_allocated: full.gb_allocated, gb_used: full.gb_used, gb_remaining: full.gb_remaining,
      country: full.country, state: full.state, city: full.city,
      host: full.host, port: full.port, username: full.username, connection_username: full.connection_username,
      usage_synced_at: syncedAt,
    })
  })
}
