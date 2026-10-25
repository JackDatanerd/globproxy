import type { createAdminClient } from '@/lib/supabase/server'

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>

// Credits GB consumed since the last sync to today's (UTC) account-level bucket
// (usage_daily, migration 0062) — what lets usage history cover deleted sessions
// and accounts with many sessions without a supplier call per session. Only
// growth counts (a lower reading is a counter reset, not negative usage). Never throws.
//
// Lives in its own module (re-exported by lib/usageSync.ts) so lib/credentials.ts can
// credit the usage a deleted session consumed since its last sync without importing
// usageSync, which imports credentials.
export async function recordUsageDeltas(supabase: AdminClient, rows: { user_id: string; gb: number }[]) {
  const byUser = new Map<string, number>()
  for (const r of rows) if (r.user_id && r.gb > 0) byUser.set(r.user_id, (byUser.get(r.user_id) ?? 0) + r.gb)
  if (byUser.size === 0) return
  try {
    const { error } = await supabase.rpc('record_usage_deltas', {
      p_rows: [...byUser].map(([user_id, gb]) => ({ user_id, gb: Math.round(gb * 10000) / 10000 })),
    })
    if (error) console.error('[usage-sync] record_usage_deltas failed:', error)
  } catch (e) { console.error('[usage-sync] record_usage_deltas threw:', e) }
}
