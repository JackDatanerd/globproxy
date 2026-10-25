import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { retryAccountCleanup } from '@/lib/accountDeletionCron'

// POST { userId, action: 'cancel_scheduled' | 'retry_cleanup' }
//
//   cancel_scheduled — withdraws a deletion the customer scheduled (the 7-day cool-off), e.g.
//                      for a hijacked account the owner cannot reach. Same effect as the
//                      customer's own Cancel; the owner is NOT e-mailed (they may not be the
//                      one who scheduled it) — the audit log records who did it.
//   retry_cleanup    — runs the leftovers of an already-finished deletion again right now,
//                      instead of waiting for the hourly 'deletions' task.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ userId?: unknown; action?: unknown }>(req)
  if (!body || !isUuid(body.userId)) return badRequest('userId missing or invalid')
  if (body.action !== 'cancel_scheduled' && body.action !== 'retry_cleanup') return badRequest("action must be 'cancel_scheduled' or 'retry_cleanup'")

  if (body.action === 'cancel_scheduled') {
    const { data, error } = await supabase.from('profiles').update({
      deletion_requested_at: null, deletion_scheduled_at: null, deletion_reminder_sent_at: null,
      deletion_attempts: 0, deletion_last_error: null, deletion_last_attempt_at: null,
    }).eq('id', body.userId).eq('is_deleted', false).not('deletion_scheduled_at', 'is', null).select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data?.length) return NextResponse.json({ error: 'No deletion is scheduled for this account (it may already have run).' }, { status: 409 })
    await logAdminAction(supabase, { adminId, action: 'account_deletion.cancel_scheduled', targetUserId: body.userId, targetRef: body.userId, details: {} })
    return NextResponse.json({ success: true })
  }

  const { data: p, error: pErr } = await supabase.from('profiles')
    .select('is_deleted, deletion_cleanup_pending, deletion_attempts').eq('id', body.userId).maybeSingle()
  if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })
  if (!p?.is_deleted) return NextResponse.json({ error: 'This account is not deleted.' }, { status: 409 })
  if (!p.deletion_cleanup_pending) return NextResponse.json({ error: 'Nothing is waiting to be cleaned up for this account.' }, { status: 409 })
  try {
    const r = await retryAccountCleanup(supabase, body.userId, Number(p.deletion_attempts ?? 0))
    await logAdminAction(supabase, {
      adminId, action: 'account_deletion.retry_cleanup', targetUserId: body.userId, targetRef: body.userId, details: { cleared: r.cleared, problems: r.warnings.length },
    })
    return NextResponse.json({ success: true, cleared: r.cleared, warnings: r.warnings })
  } catch (e: any) {
    console.error('[admin/account-deletion] retry failed', e)
    return NextResponse.json({ error: 'The cleanup could not run. Try again shortly.' }, { status: 500 })
  }
}
