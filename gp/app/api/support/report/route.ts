import { appUrl } from '@/lib/appUrl'
import { rateLimitedUser } from '@/lib/rateLimit'
import { createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { sendEmail, escapeHtml } from '@/lib/email'
import { NextResponse } from 'next/server'

// Backs the "Report an issue" button (components/dashboard/ReportIssueButton.tsx).
// Deliberately doesn't depend on the @globproxy inbox being activated — this
// only ever sends via Resend to ADMIN_EMAIL, same as every other alert in
// the app; nothing here needs to *receive* mail. Same auth pattern as
// checkout/route.ts.

// Per account, rolling 24 hours. The per-minute and per-hour limiters below bound the
// RATE; this bounds the VOLUME (6/hour is still ~140 staff emails and rows a day).
const MAX_REPORTS_PER_DAY = 20

export async function POST(req: Request) {
  try {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const supabase = await createAdminClient()
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Per-user throttle (lib/rateLimit.ts) — this route emails staff on every call.
    const throttled = await rateLimitedUser('USER_EMAIL_RATE_LIMITER', user.id, 'support-report')
    if (throttled) return throttled

    const suspended = await requireActiveUser(user.id)
    if (suspended) return suspended

    // A body that is not JSON is the caller's mistake (400), not a server error.
    let body: { message?: unknown; page_url?: unknown }
    try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })

    const trimmed = String(body.message ?? '').trim()
    if (!trimmed) return NextResponse.json({ error: 'Message is required' }, { status: 400 })
    if (trimmed.length > 5000) return NextResponse.json({ error: 'Message is too long' }, { status: 400 })
    // Stored AND emailed in the same truncated form (the email used to echo the raw value).
    const pageUrl = typeof body.page_url === 'string' && body.page_url ? body.page_url.slice(0, 500) : null

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { count: recent, error: countErr } = await supabase.from('support_reports')
      .select('id', { count: 'exact', head: true }).eq('user_id', user.id).gte('created_at', since)
    if (countErr) throw countErr
    if ((recent ?? 0) >= MAX_REPORTS_PER_DAY) {
      return NextResponse.json({ error: 'You have sent a lot of reports today. Please wait for our reply before sending more.' }, { status: 429 })
    }

    const { data: report, error } = await supabase.from('support_reports').insert({
      user_id: user.id,
      email: user.email,
      page_url: pageUrl,
      message: trimmed,
    }).select().single()
    if (error) throw error

    await sendEmail({
      to: process.env.ADMIN_EMAIL!,
      // Reply goes straight to the customer — the dashboard promises "we'll follow up by email".
      replyTo: user.email ?? undefined,
      subject: `[ISSUE REPORTED] ${user.email}`,
      html: `<p><strong>From:</strong> ${escapeHtml(user.email)}</p>
             <p><strong>Page:</strong> ${escapeHtml(pageUrl ?? 'not provided')}</p>
             <p><strong>Report ID:</strong> ${escapeHtml(report.id)}</p>
             <p><strong>Message:</strong></p>
             <p>${escapeHtml(trimmed).replace(/\n/g, '<br/>')}</p>
             <p style="color:#666">Hit Reply to answer the customer directly.</p>
             <a href="${appUrl()}/admin/support">Open support reports →</a>`,
    }).catch((e) => console.error('[support/report] alert email threw', e))

    return NextResponse.json({ ok: true, id: report.id })
  } catch (err: any) {
    console.error('[support/report] unexpected error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
