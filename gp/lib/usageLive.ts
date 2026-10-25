import { getSubUserUsage } from '@/lib/geonode'
import { recordUsageDeltas } from '@/lib/usageLedger'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

// Live usage is re-read from the proxy network at most every 30s per session; inside that
// window the stored value is returned. Without it a tight polling loop is an
// upstream-amplification path (one customer request = one provider request).
export const LIVE_REFRESH_MIN_INTERVAL_MS = 30_000

// Shared by GET /api/v1/sub-users/:id/usage and GET /api/dashboard/proxies/:id/usage so the
// two can't drift. `cred` must carry id, status, upstream_sub_user_id, gb_used, usage_synced_at.
export async function refreshLiveUsage(
  admin: Admin, userId: string, cred: any
): Promise<{ usedGb: number; syncedAt: string | null; refreshed: boolean }> {
  let usedGb = Number(cred.gb_used ?? 0)
  let syncedAt: string | null = cred.usage_synced_at ?? null
  const fresh = !!syncedAt && Date.now() - new Date(syncedAt).getTime() < LIVE_REFRESH_MIN_INTERVAL_MS
  if (cred.status !== 'active' || !cred.upstream_sub_user_id || fresh) return { usedGb, syncedAt, refreshed: false }
  try {
    const prevGb = usedGb
    const live = await getSubUserUsage(cred.upstream_sub_user_id)
    // Never move the stored counter backwards here: a lower reading is a supplier counter reset,
    // which the usage sync handles (with its own accounting), not a customer-triggered refresh.
    if (live >= prevGb) {
      usedGb = live
      syncedAt = new Date().toISOString()
      const { error } = await admin.from('proxy_credentials').update({ gb_used: usedGb, usage_synced_at: syncedAt }).eq('id', cred.id)
      if (error) throw error
      // This write moves gb_used ahead of the usage sync, which only credits growth it sees —
      // credit the daily ledger here or this slice would never appear.
      if (usedGb > prevGb) await recordUsageDeltas(admin, [{ user_id: userId, gb: usedGb - prevGb }])
      return { usedGb, syncedAt, refreshed: true }
    }
  } catch (e) {
    console.error('[usage-live] live usage fetch failed, returning stored value', cred.id, e)
  }
  return { usedGb, syncedAt, refreshed: false }
}
