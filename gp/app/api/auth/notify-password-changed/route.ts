import { createClient, createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
import { NextResponse } from 'next/server'

// Supabase Auth already sends its own "your password has been changed"
// notification automatically whenever auth.updateUser({ password }) or a
// recovery-link password reset succeeds — that's the one in the bug
// report that shows up looking like plain, unstyled system mail (no
// GlobProxy logo/colors) next to everything else in the inbox. That
// template lives in the Supabase Dashboard (Authentication → Email
// Templates), not in this codebase, so it can't be restyled from here.
//
// This route sends GlobProxy's own branded version of the same notice,
// same pattern as the suspend/reinstate and mfa-reset emails. Call it
// from the client right after a successful updateUser({ password }) —
// both app/auth/update-password (reset-link flow) and
// app/dashboard/settings (change-password-while-signed-in flow) do this.
// Until Supabase's own template is edited or its "password changed"
// notification is turned off in the dashboard, the account owner will end
// up with both emails for one change — this one styled, that one not.
// That's a one-time dashboard edit outside this repo's reach; flagging it
// rather than silently leaving two competing emails.
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = await createAdminClient()
  const { data: profile } = await admin.from('profiles').select('full_name').eq('id', user.id).single()

  await sendEmail({
    to: user.email,
    subject: 'Your GlobProxy password was changed',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
        <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
          style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
        <h2 style="text-align:center;color:#111;">Password changed</h2>
        <p style="color:#444;text-align:center;">
          Hi ${escapeHtml(profile?.full_name) || 'there'}, this confirms the password on your GlobProxy
          account (${escapeHtml(user.email)}) was just changed. If you made this change, no action is needed.
        </p>
        <p style="color:#444;text-align:center;">
          If you didn't request this, contact us immediately — someone else may have access to your account.
        </p>
        <div style="text-align:center;margin:32px 0;">
          <a href="mailto:support@globproxy.com"
             style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
            Contact support →
          </a>
        </div>
        <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
          © 2026 GlobProxy · Residential Proxies That Never Expire
        </p>
      </div>
    `,
  })

  // Best-effort notification — a delivery failure here shouldn't be
  // reported as the password change itself having failed (sendEmail()
  // already logs failures server-side; see lib/email.ts).
  return NextResponse.json({ success: true })
}
