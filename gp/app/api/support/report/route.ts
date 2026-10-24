import { appUrl, isCrossSiteRequest } from '@/lib/appUrl'
import { rateLimitedUser } from '@/lib/rateLimit'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { NextResponse } from 'next/server'

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
    let body: { message?: unknown; page_url?: unknown }
    try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    // Text only: String({}) used to turn an object into the report "[object Object]".
    if (body.message != null && typeof body.message !== 'string') return NextResponse.json({ error: 'Message must be text' }, { status: 400 })
    const trimmed = (body.message ?? '').toString().trim()
    if (!trimmed) return NextResponse.json({ error: 'Message is required' }, { status: 400 })
    if (trimmed.length > 5000) return NextResponse.json({ error: 'Message is too long' }, { status: 400 })
    // Stored AND emailed in the same truncated form.
    const pageUrl = typeof body.page_url === 'string' && body.page_url ? body.page_url.slice(0, 500) : null

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
    if (!notified) console.error('[support/report] report saved but the staff e-mail was NOT delivered', report.id, adminTo ? '' : '(ADMIN_EMAIL is not set)')

    return NextResponse.json({ ok: true, id: report.id })
  } catch (err: any) {
    console.error('[support/report] unexpected error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
