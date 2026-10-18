import { createClient, createAdminClient } from '@/lib/supabase/server'
import { disableMfa } from '@/lib/mfa'
import { rateLimited } from '@/lib/rateLimit'
import { clearMfaCookie } from '../_cookie'
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
    return NextResponse.json({ error: 'Enter your current code to confirm.' }, { status: 400 })
  }

  try {
    await disableMfa(user.id, user.email, code, req)
    await logSecurityEvent({ userId: user.id, event: 'mfa_disabled', req })

    // The exact move an attacker with password access makes right before
    // locking the real owner out, so the owner needs a trip-wire. Awaited so
    // the Workers runtime can't cancel it after the response goes out.
    const admin = await createAdminClient()
    const { data: profile } = await admin.from('profiles').select('full_name').eq('id', user.id).maybeSingle()
    await sendEmailSafe({
      to: user.email,
      subject: 'Two-factor authentication was turned off',
      html: securityNoticeHtml({
        heading: '2FA disabled',
        bodyHtml: `
          <p style="color:#444;text-align:center;">
            Hi ${escapeHtml(profile?.full_name) || 'there'}, this confirms two-factor authentication was just
            turned off on your GlobProxy account (${escapeHtml(user.email)}). If you made this change, no action is needed.
          </p>
          <p style="color:#444;text-align:center;">
            If you didn't make this change, reset your password right away and turn two-factor authentication
            back on — that is faster than waiting on a reply from us.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/auth/reset"
               style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Reset your password →
            </a>
          </div>
          <p style="color:#888;font-size:13px;text-align:center;">
            Still locked out, or think something else is wrong?
            <a href="mailto:support@globproxy.com" style="color:#2563eb;">Contact support</a>.
          </p>`,
      }),
    })
    const res = NextResponse.json({ success: true })
    return clearMfaCookie(res)
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? 'Could not disable MFA.' }, { status: 400 })
  }
}
