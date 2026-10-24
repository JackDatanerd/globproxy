import { NextResponse } from 'next/server'
import { authorizeAdmin, readJson, isUuid, badRequest } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'

const SUPPORT_ADDRESS = 'support@globproxy.com'

// POST { reportId, action: 'resolve' | 'reopen' | 'reply', note?: string, reply?: string }
//
//   resolve — closes the report. `note` is an INTERNAL note (never sent);
//             `reply` is an optional message to the customer, sent in the
//             resolution email and kept on the report.
//   reply   — sends the customer a message and keeps the report OPEN (a
//             question, a "we're looking into it"). `reply` is required.
//   reopen  — puts a resolved report back in the queue.
//
// State changes are conditional on the CURRENT state, so two admins can't both
// resolve the same report and a stale tab can't reopen one somebody else just
// closed. Customer emails carry replyTo = support@ — they are sent from a
// no-reply address, and the old "just reply to this email" went nowhere.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = await readJson<{ reportId?: unknown; action?: unknown; note?: unknown; reply?: unknown }>(req)
  if (!body || !isUuid(body.reportId)) return badRequest('Report ID missing or invalid')
  const action = body.action
  if (action !== 'resolve' && action !== 'reopen' && action !== 'reply') return badRequest("action must be 'resolve', 'reopen' or 'reply'")
  if (body.note != null && typeof body.note !== 'string') return badRequest('note must be text')
  if (body.reply != null && typeof body.reply !== 'string') return badRequest('reply must be text')
  const note = (body.note ?? '').toString().trim().slice(0, 500)
  const reply = (body.reply ?? '').toString().trim().slice(0, 2000)
  if (action === 'reply' && reply.length < 2) return badRequest('Write the message to send to the customer.')

  type Row = { id: string; user_id: string | null; email: string | null; message: string | null }
  let row: Row | null = null

  if (action === 'reply') {
    const { data, error } = await supabase.from('support_reports')
      .select('id, user_id, email, message').eq('id', body.reportId).eq('status', 'open').maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'This report is not open (resolved, or no longer exists).' }, { status: 409 })
    row = data as Row
  } else {
    const resolving = action === 'resolve'
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
    row = updated[0] as Row
  }

  // Keep what the customer was told with the report.
  let replyStored = true
  if (reply && (action === 'reply' || action === 'resolve')) {
    const { error: replyErr } = await supabase.from('support_report_replies')
      .insert({ report_id: row.id, admin_id: adminId, message: reply })
    if (replyErr) { replyStored = false; console.error('[support-report] could not store reply (apply migration 0073)', replyErr.message) }
  }

  await logAdminAction(supabase, {
    adminId, action: `support_report.${action}`,
    targetUserId: row.user_id ?? null, targetRef: body.reportId,
    // Lengths, not the text: the reply is customer-facing prose kept on the report
    // (and erased with the account); the append-only audit log must not hold it.
    details: { ...(note ? { note } : {}), ...(reply ? { reply_chars: reply.length } : {}) },
  })

  // Tell the customer. Neutral text only — admin_note is internal and never sent.
  let notified = false
  const to = row.email
  if (action !== 'reopen' && to && !to.startsWith('[')) {
    const excerpt = String(row.message ?? '').slice(0, 200)
    const quoted = `<blockquote style="color:#555;border-left:3px solid #ddd;margin:12px 0;padding-left:12px;">${escapeHtml(excerpt)}${String(row.message ?? '').length > 200 ? '…' : ''}</blockquote>`
    const replyBlock = reply
      ? `<div style="background:#f6f8fa;border-radius:8px;padding:12px 14px;margin:14px 0;color:#222;white-space:pre-wrap;">${escapeHtml(reply)}</div>`
      : ''
    const resolved = action === 'resolve'
    notified = await sendEmailSafe({
      to,
      replyTo: SUPPORT_ADDRESS,
      subject: resolved ? 'Your GlobProxy report has been marked resolved' : 'An update on your GlobProxy report',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#111;">${resolved ? 'Your report was resolved' : 'An update on your report'}</h2>
        <p style="color:#444;">${resolved ? "We've marked the issue you reported as resolved:" : 'About the issue you reported:'}</p>
        ${quoted}
        ${replyBlock}
        <p style="color:#444;">${resolved
          ? `If it isn't fixed, reply to this email (it reaches ${SUPPORT_ADDRESS}) or send another report from your dashboard and we'll look again.`
          : `You can reply to this email — it reaches ${SUPPORT_ADDRESS}.`}</p>
        <p><a href="${appUrl()}/dashboard/support">View your reports →</a></p>
      </div>`,
    })
  }
  return NextResponse.json({
    success: true,
    ...(action !== 'reopen' ? { customer_notified: notified } : {}),
    ...(replyStored ? {} : { warning: 'The customer was emailed but the reply could not be stored on the report.' }),
  })
}
