import { createAdminClient } from '@/lib/supabase/server'
import { listAllSubUsersUsage, getSubUserUsage } from '@/lib/geonode'
import { runAutoTopups } from '@/lib/autoTopup'

// Extracted from app/api/cron/[task]/route.ts's runUsageSync() so the admin
// "sync now" button (app/api/admin/sync-usage) and the cron-job.org-driven
// cron hit the exact same code path — two separate implementations of "how
// do we reconcile gb_used" is how they'd quietly drift apart over time.

type CredRow = { id: string; geonode_sub_user_id: string | null; gb_used: number | null }

function buildChanges(creds: CredRow[], usageMap: Map<string, number>) {
  return creds
    .map(cred => ({
      id: cred.id,
      gb_used: cred.geonode_sub_user_id ? usageMap.get(cred.geonode_sub_user_id) : undefined,
      prevGbUsed: cred.gb_used ?? 0,
    }))
    // Only write rows that actually changed (skip both "Geonode didn't
    // return this sub-user" and "unchanged within float noise") — same
    // 0.001 GB threshold the cron job already used.
    .filter((c): c is { id: string; gb_used: number; prevGbUsed: number } =>
      c.gb_used !== undefined && Math.abs(c.gb_used - c.prevGbUsed) > 0.001
    )
    .map(({ id, gb_used }) => ({ id, gb_used }))
}

async function applyChanges(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  changes: { id: string; gb_used: number }[]
) {
  if (changes.length > 0) {
    const { error } = await supabase.rpc('bulk_update_credential_usage', { updates: changes })
    if (error) console.error('bulk_update_credential_usage failed:', error)
  }
  // Always recalc, even with zero changes — a previous partial failure
  // (e.g. bulk_update succeeded but recalc didn't run that cycle) should
  // still get corrected on the next call rather than only when something
  // in this pass happens to have moved.
  const { error: recalcErr } = await supabase.rpc('recalculate_bandwidth_accounts')
  if (recalcErr) console.error('recalculate_bandwidth_accounts failed:', recalcErr)
  // recalculate_bandwidth_accounts is the step that actually writes the
  // numbers stock-exposure math and customer-facing balances depend on —
  // its success (not bulk_update's) is what "usage sync is healthy" means.
  return { recalcOk: !recalcErr }
}

// Full sync — every active credential across every user. This is what the
// cron job runs on its ~5-minute interval, and what the admin "sync all"
// button triggers on demand. Uses the paginated bulk Geonode list endpoint
// (ceil(N/100) calls) rather than one call per credential — see
// listAllSubUsersUsage's own comment for why that matters on Cloudflare
// Workers' free-plan subrequest cap.
export async function syncAllUsage() {
  const supabase = await createAdminClient()
  const { data: creds } = await supabase
    .from('proxy_credentials')
    .select('id, geonode_sub_user_id, gb_used')
    .eq('status', 'active')
    .not('geonode_sub_user_id', 'is', null)

  const usageMap = await listAllSubUsersUsage()
  const changes = buildChanges(creds ?? [], usageMap)
  const { recalcOk } = await applyChanges(supabase, changes)

  // Auto-allocate: run after gb_used is fresh (just above) so "remaining
  // GB" reflects real current usage, not whatever it was ~5 minutes ago
  // at the last tick. See lib/autoTopup.ts for the full flow — failures
  // here (e.g. insufficient balance) are logged/alerted internally and
  // never throw, so a problem with one credential's auto-topup can't
  // block the rest of this cron run.
  const autoTopup = await runAutoTopups()

  // Stamp a freshness marker on every successful run — this is what lets
  // runStockCheck() (a *separate* cron task, deliberately) notice if this
  // one silently stops running. It already happened once in production:
  // migration 0010's own history is cron-job.org auto-disabling the usage
  // job after 26 consecutive failures, with nothing in-app to notice or
  // alert on it — gb_used just went stale platform-wide until someone
  // happened to look. Only stamp on a genuine success (recalcOk), not on
  // "the function ran without throwing" — a run where the actual write
  // failed shouldn't count as fresh.
  if (recalcOk) {
    await supabase.from('platform_settings')
      .upsert({ key: 'usage_last_synced_at', value: new Date().toISOString() }, { onConflict: 'key' })
  }

  return { updated_credentials: changes.length, recalc_ok: recalcOk, auto_topup: autoTopup }
}

// Scoped sync — one user's active credentials only. For the admin
// per-user "sync this user now" button, e.g. when resolving a balance
// dispute and you don't want to wait for the next cron tick. A single
// user's active-credential count is always small (nowhere near the
// subrequest cap that forced the bulk approach above), so a plain
// per-credential loop against getSubUserUsage is fine here.
export async function syncUserUsage(userId: string) {
  const supabase = await createAdminClient()
  const { data: creds } = await supabase
    .from('proxy_credentials')
    .select('id, geonode_sub_user_id, gb_used')
    .eq('status', 'active')
    .eq('user_id', userId)
    .not('geonode_sub_user_id', 'is', null)

  const usageMap = new Map<string, number>()
  for (const c of creds ?? []) {
    if (!c.geonode_sub_user_id) continue
    try {
      usageMap.set(c.geonode_sub_user_id, await getSubUserUsage(c.geonode_sub_user_id))
    } catch (e) {
      // Non-fatal per credential — a transient failure on one sub-user
      // shouldn't block reconciling the rest of this user's credentials.
      console.error('Live usage fetch failed for', c.geonode_sub_user_id, e)
    }
  }

  const changes = buildChanges(creds ?? [], usageMap)
  await applyChanges(supabase, changes)
  // Scoped to this user only — same reasoning as the full sync above,
  // just narrowed so an admin's "sync this user now" button also settles
  // that user's auto-topups immediately rather than waiting for the next
  // full cron tick.
  const autoTopup = await runAutoTopups(userId)
  return { updated_credentials: changes.length, auto_topup: autoTopup }
}
