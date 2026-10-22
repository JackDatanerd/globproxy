import { getSubUserUsage } from '@/lib/geonode'
import { withApiAuth } from '@/lib/apiHelpers'
import { apiError } from '@/lib/apiAuth'
import { getOwnedCredential, toApiCredential } from '@/lib/credentials'
import { recordUsageDeltas } from '@/lib/usageSync'
import { NextResponse } from 'next/server'

// Live usage is re-read from Geonode at most every 30s per sub-user; inside
// that window the stored value is returned. Every call used to hit Geonode
// AND write the row, so a tight polling loop was an upstream-amplification
// path (one customer request = one provider request).
const LIVE_REFRESH_MIN_INTERVAL_MS = 30_000

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  return withApiAuth(req, 'GET sub-user usage', async ({ user, supabase }) => {
    const { id } = await context.params
    const cred = await getOwnedCredential(supabase, user.id, id, '*')
    if (!cred) return apiError(404, 'not_found', 'Sub-user not found')

    let usedGb = Number(cred.gb_used ?? 0)
    let syncedAt: string | null = cred.usage_synced_at ?? null
    const fresh = syncedAt && Date.now() - new Date(syncedAt).getTime() < LIVE_REFRESH_MIN_INTERVAL_MS
    if (cred.status === 'active' && cred.upstream_sub_user_id && !fresh) {
      try {
        const prevGb = Number(cred.gb_used ?? 0)
        usedGb = await getSubUserUsage(cred.upstream_sub_user_id)
        syncedAt = new Date().toISOString()
        await supabase.from('proxy_credentials').update({ gb_used: usedGb, usage_synced_at: syncedAt }).eq('id', cred.id)
        // This write moves gb_used ahead of the usage sync, which only credits growth it
        // sees — so the daily ledger must be credited here or this slice would never appear.
        if (usedGb > prevGb) await recordUsageDeltas(supabase, [{ user_id: user.id, gb: usedGb - prevGb }])
      } catch (e) {
        console.error('[v1 GET sub-user usage] live usage fetch failed, returning stored value', cred.id, e)
      }
    }

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
