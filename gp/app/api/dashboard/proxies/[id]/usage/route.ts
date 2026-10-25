import { requireMfaVerified } from '@/lib/mfa'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimitedUser } from '@/lib/rateLimit'
import { isUuidString } from '@/lib/cursor'
import { getOwnedCredential } from '@/lib/credentials'
import { refreshLiveUsage } from '@/lib/usageLive'
import { NextResponse } from 'next/server'

// "Refresh usage" for one session: the dashboard only ever showed the figure from the last
// 5-minute sync, while the API had a live read. Same 30 s per-session floor as the API.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const suspended = await requireActiveUser(user.id)
  if (suspended) return suspended
  const throttled = await rateLimitedUser('USER_ACTION_RATE_LIMITER', user.id, 'proxy-usage')
  if (throttled) return throttled

  const { id } = await context.params
  if (!isUuidString(id)) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  const admin = await createAdminClient()
  const cred = await getOwnedCredential(admin, user.id, id, 'id, status, upstream_sub_user_id, gb_allocated, gb_used, usage_synced_at')
  if (!cred) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  const { usedGb, syncedAt, refreshed } = await refreshLiveUsage(admin, user.id, cred)
  const allocated = Number(cred.gb_allocated ?? 0)
  return NextResponse.json({
    gb_allocated: allocated,
    gb_used: usedGb,
    gb_remaining: Math.max(0, Math.round((allocated - usedGb) * 10000) / 10000),
    usage_synced_at: syncedAt,
    refreshed,
  })
}
