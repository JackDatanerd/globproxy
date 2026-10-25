import { appUrl, isCrossSiteRequest } from '@/lib/appUrl'
import { rateLimitedUser } from '@/lib/rateLimit'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { NextResponse } from 'next/server'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SUPPORT_ADDRESS = 'support@globproxy.com'

// Backs the "Report an issue" button (components/dashboard/ReportIssueButton.tsx).
// Deliberately doesn't depend on the @globproxy inbox being activated — this
// only ever sends via Resend to ADMIN_EMAIL, same as every other alert in
// the app; nothing here needs to *receive* mail.

// Per account, rolling 24 hours. The per-minute and per-hour limiters below bound the
// RATE; this bounds the VOLUME (6/hour is still ~140 staff emails and rows a day).
const MAX_REPORTS_PER_DAY = 20

// Who is calling? The dashboard button authenticates with the browser's session
// COOKIE (apiJson never attaches an access token); scripts may still send
// `Authorization: Bearer <access token>`. This route used to accept ONLY the Bearer
// header, so once the button moved to the cookie-based helper every report answered
// 401 — the same outage app/api/checkout/route.ts documents. Cookie or Bearer,
// whichever is present, so neither client can break the other.
async function resolveCaller(req: Request): Promise<{ id: string; email: string | null; viaCookie: boolean } | null> {
  const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(\S+)\s*$/i)?.[1]
  if (bearer) {
    const admin = await createAdminClient()
    const { data: { user } } = await admin.auth.getUser(bearer)
    return user ? { id: user.id, email: user.email ?? null, viaCookie: false } : null
  }
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  return user ? { id: user.id, email: user.email ?? null, viaCookie: true } : null
}

export async function POST(req: Request) {
  try {
    const caller = await resolveCaller(req)
    if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    // A cookie-authenticated, state-changing call must come from our own origin.
    if (caller.viaCookie && isCrossSiteRequest(req)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Per-user throttle (lib/rateLimit.ts) — this route emails staff on every call.
    const throttled = await rateLimitedUser('USER_EMAIL_RATE_LIMITER', caller.id, 'support-report')
    if (throttled) return throttled

    const suspended = await requireActiveUser(caller.id)
    if (suspended) return suspended

    const supabase = await createAdminClient()

    // A body that is not JSON is the caller's mistake (400), not a server error.
    let body: { message?: unknown; page_url?: unknown; report_id?: unknown }
    try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    // Text only: String({}) used to turn an object into the report "[object Object]".
    if (body.message != null && typeof body.message !== 'string') return NextResponse.json({ error: 'Message must be text' }, { status: 400 })
    const trimmed = (body.message ?? '').toString().trim()
    if (!trimmed) return NextResponse.json({ error: 'Message is required' }, { status: 400 })
    if (trimmed.length > 5000) return NextResponse.json({ error: 'Message is too long' }, { status: 400 })
    // Stored AND emailed in the same truncated form.
    const pageUrl = typeof body.page_url === 'string' && body.page_url ? body.page_url.slice(0, 500) : null

    // A follow-up on one of the caller's OWN reports (POST { report_id, message }): kept with that
    // report, which goes back in the queue if it had been marked resolved.
    if (body.report_id != null) {
      if (typeof body.report_id !== 'string' || !UUID_RE.test(body.report_id)) return NextResponse.json({ error: 'Invalid report' }, { status: 400 })
      if (trimmed.length > 2000) return NextResponse.json({ error: 'Message is too long (2000 characters for a follow-up)' }, { status: 400 })
      const { data: own, error: ownErr } = await supabase.from('support_reports')
        .select('id, status, message').eq('id', body.report_id).eq('user_id', caller.id).maybeSingle()
      if (ownErr) throw ownErr
      if (!own) return NextResponse.json({ error: 'Report not found' }, { status: 404 })
      // Bounded per report: a follow-up e-mails staff just like a report does.
      const { count: recentF, error: cErr } = await supabase.from('support_report_replies')
        .select('id', { count: 'exact', head: true }).eq('report_id', own.id).eq('from_customer', true)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      if (cErr) throw cErr
      if ((recentF ?? 0) >= 10) return NextResponse.json({ error: 'You have added a lot to this report today. Please wait for our reply before sending more.' }, { status: 429 })
      const { error: insErr } = await supabase.from('support_report_replies')
        .insert({ report_id: own.id, admin_id: null, from_customer: true, message: trimmed.slice(0, 2000) })
      if (insErr) throw insErr
      if (own.status === 'resolved') {
        await supabase.from('support_reports').update({ status: 'open', resolved_at: null, resolved_by: null }).eq('id', own.id).eq('status', 'resolved')
      }
      const adminTo = process.env.ADMIN_EMAIL
      const notifiedF = adminTo ? await sendEmailSafe({
        to: adminTo,
        replyTo: caller.email ?? undefined,
        subject: `[ISSUE FOLLOW-UP] ${caller.email ?? caller.id}`,
        html: `<p><strong>From:</strong> ${escapeHtml(caller.email)}</p>
               <p><strong>Report ID:</strong> ${escapeHtml(own.id)}${own.status === 'resolved' ? ' (was resolved — reopened)' : ''}</p>
               <p><strong>Original report:</strong></p>
               <blockquote style="color:#555;border-left:3px solid #ddd;margin:8px 0;padding-left:12px;">${escapeHtml(String(own.message ?? '').slice(0, 300))}</blockquote>
               <p><strong>Follow-up:</strong></p>
               <p>${escapeHtml(trimmed).replace(/\n/g, '<br/>')}</p>
               <a href="${appUrl()}/admin/support">Open support reports →</a>`,
      }) : false
      if (!notifiedF) console.error('[support/report] follow-up saved but the staff e-mail was NOT delivered', own.id)
      return NextResponse.json({ ok: true, id: own.id, followUp: true })
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { count: recent, error: countErr } = await supabase.from('support_reports')
      .select('id', { count: 'exact', head: true }).eq('user_id', caller.id).gte('created_at', since)
    if (countErr) throw countErr
    if ((recent ?? 0) >= MAX_REPORTS_PER_DAY) {
      return NextResponse.json({ error: 'You have sent a lot of reports today. Please wait for our reply before sending more.' }, { status: 429 })
    }

    const { data: report, error } = await supabase.from('support_reports').insert({
      user_id: caller.id,
      email: caller.email,
      page_url: pageUrl,
      message: trimmed,
    }).select().single()
    if (error) throw error

    // The report is saved either way (it shows on /admin/support and in the overview's
    // open count); the staff e-mail is the fast path. sendEmail() answers a refused
    // send with a non-OK response instead of throwing, which the old `.catch` never
    // saw — so say so loudly instead of dropping it.
    const adminTo = process.env.ADMIN_EMAIL
    const notified = adminTo ? await sendEmailSafe({
      to: adminTo,
      // Reply goes straight to the customer — the dashboard promises "we'll follow up by email".
      replyTo: caller.email ?? undefined,
      subject: `[ISSUE REPORTED] ${caller.email ?? caller.id}`,
      html: `<p><strong>From:</strong> ${escapeHtml(caller.email)}</p>
             <p><strong>Page:</strong> ${escapeHtml(pageUrl ?? 'not provided')}</p>
             <p><strong>Report ID:</strong> ${escapeHtml(report.id)}</p>
             <p><strong>Message:</strong></p>
             <p>${escapeHtml(trimmed).replace(/\n/g, '<br/>')}</p>
             <p style="color:#666">Hit Reply to answer the customer directly.</p>
             <a href="${appUrl()}/admin/support">Open support reports →</a>`,
    }) : false
    // A receipt for the customer with a reference they can quote. Best-effort: the report is saved.
    if (caller.email) {
      const ref = String(report.id).slice(0, 8).toUpperCase()
      const sentReceipt = await sendEmailSafe({
        to: caller.email,
        replyTo: SUPPORT_ADDRESS,
        subject: `We got your report (ref ${ref})`,
        html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
          <h2 style="color:#111;">We got your report</h2>
          <p style="color:#444;">Reference <strong>${escapeHtml(ref)}</strong>. We'll follow up by email. You can reply to this message (it reaches ${SUPPORT_ADDRESS}) or add to the report from your dashboard.</p>
          <blockquote style="color:#555;border-left:3px solid #ddd;margin:12px 0;padding-left:12px;">${escapeHtml(trimmed.slice(0, 300))}${trimmed.length > 300 ? '…' : ''}</blockquote>
          <p><a href="${appUrl()}/dashboard/support">View your reports →</a></p>
        </div>`,
      })
      if (!sentReceipt) console.error('[support/report] receipt e-mail was not delivered', report.id)
    }
    if (!notified) console.error('[support/report] report saved but the staff e-mail was NOT delivered', report.id, adminTo ? '' : '(ADMIN_EMAIL is not set)')

    return NextResponse.json({ ok: true, id: report.id })
  } catch (err: any) {
    console.error('[support/report] unexpected error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
