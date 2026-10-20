import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'

// POST { reportId, action: 'resolve' | 'reopen', note?: string }
// Triage for the reports users send from "Report an issue". The state change
// is conditional on the CURRENT state, so two admins can't both resolve the
// same report and a stale tab can't reopen one somebody else just closed.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ reportId?: unknown; action?: unknown; note?: unknown }>(req)
  if (!body || !isUuid(body.reportId)) return badRequest('Report ID missing or invalid')
  if (body.action !== 'resolve' && body.action !== 'reopen') return badRequest("action must be 'resolve' or 'reopen'")
  if (body.note != null && typeof body.note !== 'string') return badRequest('note must be text')
  const note = (body.note ?? '').toString().trim().slice(0, 500)

  const resolving = body.action === 'resolve'
  const { data: updated, error } = await supabase
    .from('support_reports')
    .update(resolving
      ? { status: 'resolved', resolved_at: new Date().toISOString(), resolved_by: adminId, admin_note: note || null }
      : { status: 'open', resolved_at: null, resolved_by: null })
    .eq('id', body.reportId)
    .eq('status', resolving ? 'open' : 'resolved')
    .select('id, user_id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!updated?.length) {
    return NextResponse.json({ error: resolving ? 'This report is already resolved (or no longer exists).' : 'This report is not resolved.' }, { status: 409 })
  }

  await logAdminAction(supabase, {
    adminId, action: resolving ? 'support_report.resolve' : 'support_report.reopen',
    targetUserId: updated[0].user_id ?? null, targetRef: body.reportId,
    details: note ? { note } : {},
  })
  return NextResponse.json({ success: true })
}
