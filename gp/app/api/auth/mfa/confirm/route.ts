import { createClient, createAdminClient } from '@/lib/supabase/server'
import { confirmEnrollment } from '@/lib/mfa'
import { rateLimited } from '@/lib/rateLimit'
import { withMfaCookie } from '../_cookie'
import { sendEmailSafe, securityNoticeHtml, escapeHtml } from '@/lib/email'
import { logSecurityEvent } from '@/lib/securityEvents'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'mfa')
  if (limited) return limited

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { code } = await req.json().catch(() => ({}))
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Enter the 6-digit code from your authenticator app.' }, { status: 400 })
  }

  try {
    const { backup_codes, session_token, session_ttl_s } = await confirmEnrollment(user.id, user.email, code, req)

    await logSecurityEvent({ userId: user.id, event: 'mfa_enabled', req })

    // Security-relevant account change. If this wasn't the account owner,
    // someone else already has the password AND now controls the second
    // factor, so a password reset alone won't lock them out — point to
    // support. Awaited (not fire-and-forget): on Workers an un-awaited
    // fetch can be cancelled when the response returns.
    const admin = await createAdminClient()
    const { data: profile } = await admin.from('profiles').select('full_name').eq('id', user.id).maybeSingle()
    await sendEmailSafe({
      to: user.email,
      subject: 'Two-factor authentication was enabled',
      html: securityNoticeHtml({
        heading: '2FA enabled',
        bodyHtml: `
          <p style="color:#444;text-align:center;">
            Hi ${escapeHtml(profile?.full_name) || 'there'}, this confirms two-factor authentication was just
            turned on for your GlobProxy account (${escapeHtml(user.email)}). If you made this change, no action is needed —
            keep your backup codes somewhere safe.
          </p>
          <p style="color:#444;text-align:center;">
            If you didn't make this change, contact support immediately — someone else may already have both your
            password and control of the authenticator now attached to your account.
          </p>
          <p style="color:#888;font-size:13px;text-align:center;">
            <a href="mailto:support@globproxy.com" style="color:#2563eb;">Contact support</a>.
          </p>`,
      }),
    })
    const res = NextResponse.json({ backup_codes })
    return withMfaCookie(res, session_token, session_ttl_s)
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Could not confirm code.' }, { status: 400 })
  }
}
