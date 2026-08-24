import { createClient, createAdminClient } from '@/lib/supabase/server'
import { confirmEnrollment } from '@/lib/mfa'
import { withMfaCookie } from '../_cookie'
import { sendEmail, securityNoticeHtml, escapeHtml } from '@/lib/email'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { code } = await req.json().catch(() => ({}))
  if (!code || typeof code !== 'string') {
    return NextResponse.json({ error: 'Enter the 6-digit code from your authenticator app.' }, { status: 400 })
  }

  try {
    const { backup_codes, session_token } = await confirmEnrollment(user.id, user.email, code)
    // Security-relevant account change, same family as the disable/
    // password-changed notices — but the remedy differs: if this wasn't
    // the account owner, it means someone else already has both the
    // password AND now controls the second factor (their own
    // authenticator app is what just got enrolled), so a self-service
    // password reset alone won't lock them back out the way it does for
    // "password changed" or "2FA disabled". Point to support instead of
    // a reset link. Fire-and-forget — doesn't block the response.
    const admin = await createAdminClient()
    const { data: profile } = await admin.from('profiles').select('full_name').eq('id', user.id).single()
    sendEmail({
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
    }).catch(() => {})
    const res = NextResponse.json({ backup_codes })
    return withMfaCookie(res, session_token)
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Could not confirm code.' }, { status: 400 })
  }
}
