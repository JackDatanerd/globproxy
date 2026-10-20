import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { syncAllUsage, syncUserUsage } from '@/lib/usageSync'
import { NextResponse } from 'next/server'

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
