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
  // duplicate that work. Refuse a second one inside the cooldown.
  if (!user_id) {
    const since = new Date(Date.now() - FULL_SYNC_COOLDOWN_MS).toISOString()
    const { count } = await supabase.from('admin_audit_log')
      .select('id', { count: 'exact', head: true })
      .eq('action', 'usage.sync_all').gte('created_at', since)
    if ((count ?? 0) > 0) {
      return NextResponse.json({ error: 'A full usage sync ran less than a minute ago. Give it a moment, then try again.' }, { status: 429 })
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
  }
}
