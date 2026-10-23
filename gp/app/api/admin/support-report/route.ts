import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'

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
    .select('id, user_id, email, message')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!updated?.length) {
    return NextResponse.json({ error: resolving ? 'This report is already resolved (or no longer exists).' : 'This report is not resolved.' }, { status: 409 })
  }

  await logAdminAction(supabase, {
    adminId, action: resolving ? 'support_report.resolve' : 'support_report.reopen',
    targetUserId: updated[0].user_id ?? null, targetRef: body.reportId,
    details: note ? { note } : {},
  })

  // Tell the customer. The dashboard says "Open — we're on it" until a report is
  // resolved, and a resolution used to reach nobody: the customer had to come back and
  // look. Neutral text only — admin_note is an internal note and is never sent.
  let notified = false
  const to = updated[0].email as string | null
  if (resolving && to && !to.startsWith('[')) {
    const excerpt = String(updated[0].message ?? '').slice(0, 200)
    notified = await sendEmailSafe({
      to,
      subject: 'Your GlobProxy report has been marked resolved',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#111;">Your report was resolved</h2>
        <p style="color:#444;">We've marked the issue you reported as resolved:</p>
        <blockquote style="color:#555;border-left:3px solid #ddd;margin:12px 0;padding-left:12px;">${escapeHtml(excerpt)}${String(updated[0].message ?? '').length > 200 ? '…' : ''}</blockquote>
        <p style="color:#444;">If it isn't fixed, just reply to this email or send another report from your dashboard and we'll look again.</p>
        <p><a href="${appUrl()}/dashboard/support">View your reports →</a></p>
      </div>`,
    })
  }
  return NextResponse.json({ success: true, ...(resolving ? { customer_notified: notified } : {}) })
}
