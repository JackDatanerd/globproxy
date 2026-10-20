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
export async function POST(req: Request) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const supabase = await createAdminClient()
    const { data: { user } } = await supabase.auth.getUser(token)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Per-user throttle (lib/rateLimit.ts) — this route emails staff on every call.
    const throttled = await rateLimitedUser('USER_EMAIL_RATE_LIMITER', user.id, 'support-report')
    if (throttled) return throttled

    const suspended = await requireActiveUser(user.id)
    if (suspended) return suspended

    const { message, page_url } = await req.json()
    const trimmed = String(message ?? '').trim()
    if (!trimmed) return NextResponse.json({ error: 'Message is required' }, { status: 400 })
    if (trimmed.length > 5000) return NextResponse.json({ error: 'Message is too long' }, { status: 400 })

    const { data: report, error } = await supabase.from('support_reports').insert({
      user_id: user.id,
      email: user.email,
      page_url: page_url ? String(page_url).slice(0, 500) : null,
      message: trimmed,
    }).select().single()
    if (error) throw error

    await sendEmail({
      to: process.env.ADMIN_EMAIL!,
      subject: `[ISSUE REPORTED] ${user.email}`,
      html: `<p><strong>From:</strong> ${escapeHtml(user.email)}</p>
             <p><strong>Page:</strong> ${escapeHtml(page_url ?? 'not provided')}</p>
             <p><strong>Message:</strong></p>
             <p>${escapeHtml(trimmed).replace(/\n/g, '<br/>')}</p>
             <a href="${appUrl()}/admin">Open admin panel →</a>`,
    }).catch((e) => console.error('[support/report] alert email threw', e))

    return NextResponse.json({ ok: true, id: report.id })
  } catch (err: any) {
    console.error('Support report error:', err)
    console.error('[support/report] unexpected error:', err)
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 })
  }
}
