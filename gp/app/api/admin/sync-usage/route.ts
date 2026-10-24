import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { syncAllUsage, syncUserUsage } from '@/lib/usageSync'
import { NextResponse } from 'next/server'

const FULL_SYNC_COOLDOWN_MS = 60_000

// POST { user_id?: string }
// user_id omitted → full sync (same as the cron 'usage' task).
// user_id present → just that user's active credentials, for resolving a
// balance dispute or confirming a fix without waiting for the next cron tick.
// Both make live upstream calls and can move balances, so both are audited.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ user_id?: unknown }>(req)
  if (!body) return badRequest('Invalid request body')
  const { user_id } = body
  if (user_id != null && !isUuid(user_id)) return badRequest('Invalid user_id')

  // A full sync makes one upstream call per credential and can move balances and
  // send notifications; two overlapping runs (a double click, two admins) only
  // duplicate that work. The guard is an atomic lock taken BEFORE the sync starts
  // (the old check looked for the audit row, which is only written once a sync
  // FINISHES — so a second click while the first was still running sailed
  // through, and a sync that failed left no row at all). The lock is held for the
  // run (5 min at most) and for FULL_SYNC_COOLDOWN after it.
  let lockTaken = false
  if (!user_id) {
    const { data: got, error: lockErr } = await supabase.rpc('claim_admin_lock', { p_key: 'usage_sync_all', p_ttl_seconds: 300 })
    if (lockErr) {
      // Migration 0073 not applied yet: fall back to the old (weaker) audit-row check
      // rather than blocking the button.
      console.error('[sync-usage] claim_admin_lock unavailable — apply migration 0073', lockErr.message)
      const since = new Date(Date.now() - FULL_SYNC_COOLDOWN_MS).toISOString()
      const { count } = await supabase.from('admin_audit_log')
        .select('id', { count: 'exact', head: true })
        .eq('action', 'usage.sync_all').gte('created_at', since)
      if ((count ?? 0) > 0) {
        return NextResponse.json({ error: 'A full usage sync ran less than a minute ago. Give it a moment, then try again.' }, { status: 429 })
      }
    } else if (!got) {
      return NextResponse.json({ error: 'A full usage sync is running or finished less than a minute ago. Give it a moment, then try again.' }, { status: 429 })
    } else {
      lockTaken = true
    }
  }

  try {
    const result = user_id ? await syncUserUsage(user_id) : await syncAllUsage()
    await logAdminAction(supabase, {
      adminId,
      action: user_id ? 'usage.sync_user' : 'usage.sync_all',
      targetUserId: user_id ?? null,
      details: result && typeof result === 'object' ? (result as Record<string, unknown>) : {},
    })
    return NextResponse.json({ success: true, ...result })
  } catch (err: any) {
    console.error('Admin usage sync failed:', err)
    return NextResponse.json({ error: err.message ?? 'Sync failed' }, { status: 500 })
  } finally {
    // Start the cooldown from the END of the run (a failed run is throttled too).
    if (lockTaken) {
      await supabase.rpc('release_admin_lock', { p_key: 'usage_sync_all', p_cooldown_seconds: FULL_SYNC_COOLDOWN_MS / 1000 })
        .then(({ error }) => { if (error) console.error('[sync-usage] release_admin_lock failed', error.message) })
    }
  }
}
