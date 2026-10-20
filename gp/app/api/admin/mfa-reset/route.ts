import { appUrl } from '@/lib/appUrl'
import { createAdminClient } from '@/lib/supabase/server'
import { adminResetMfa, requireMfaVerified, revokeOtherSessions } from '@/lib/mfa'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { logSecurityEvent } from '@/lib/securityEvents'
import { logAdminAction } from '@/lib/adminAudit'
import { NextResponse } from 'next/server'

// Self-service recovery deliberately dead-ends when someone has lost both
// their authenticator and every backup code (see lib/mfa.ts disableMfa
// doc comment) — that's what makes the codes a meaningful second factor
// rather than a formality. This is the intended way back in: an admin,
// after verifying the requester's identity out-of-band (support ticket,
// video call, whatever the team's process is), wipes the factor so the
// account drops back to "MFA not set up". MFA is optional platform-wide, so
// the user can sign in with just their password again; the dashboard's
// recommendation banner (and the email below) point them back to re-enabling
// it. Every reset is recorded in security_events with the acting admin.
export async function POST(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await createAdminClient()
  const { data: { user: caller } } = await supabase.auth.getUser(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: cp } = await supabase.from('profiles').select('role').eq('id', caller.id).single()
  if (cp?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const mfaCheck = await requireMfaVerified(req, caller.id)
  if (mfaCheck) return mfaCheck

  const { user_id } = await req.json().catch(() => ({}))
  if (!user_id) return NextResponse.json({ error: 'Missing user_id' }, { status: 400 })

  // Neither check existed here before — unlike delete-user (which already
  // blocks admin targets) and the self-service disable/regenerate paths
  // (which require the current TOTP or a backup code), this route had no
  // guard at all. That's a real gap: it means an admin's own *session*
  // alone — no TOTP, no backup code — was enough to strip their own MFA
  // through this endpoint, bypassing the entire re-auth model the rest of
  // this system relies on for account-recovery actions. A hijacked admin
  // session could permanently lock the real owner out by resetting their
  // own factor and swapping in an attacker-controlled one. Blocking both
  // self-targeting and any admin target here, matching delete-user.
  if (user_id === caller.id) {
    return NextResponse.json({ error: 'Use Settings to manage your own two-factor authentication.' }, { status: 403 })
  }

  const { data: target } = await supabase.from('profiles').select('email, full_name, role').eq('id', user_id).single()
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (target.role === 'admin') return NextResponse.json({ error: 'Cannot reset MFA on an admin account this way — admins manage their own MFA from Settings.' }, { status: 403 })

  await adminResetMfa(user_id)
  // Whoever else is signed in to that account (the reason for a reset may be a
  // takeover) must sign in again.
  await revokeOtherSessions(user_id)
  await logSecurityEvent({ userId: user_id, actorId: caller.id, event: 'mfa_reset_by_admin', req, admin: supabase })
  await logAdminAction(supabase, { adminId: caller.id, action: 'user.mfa_reset', targetUserId: user_id })

  // Security-relevant account change — notify the owner the same way
  // suspend/unsuspend does, so a reset the account owner didn't request
  // (support impersonation, a compromised support account) is visible to
  // them immediately, not discovered later.
  if (target.email) {
    await sendEmailSafe({
      to: target.email,
      subject: 'Two-factor authentication was reset on your GlobProxy account',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
          <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
            style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
          <h2 style="text-align:center;color:#111;">Two-factor authentication reset</h2>
          <p style="color:#444;text-align:center;">
            Hi ${escapeHtml(target.full_name) || 'there'}, our support team reset two-factor
            authentication on your GlobProxy account, so it is now switched off. We strongly
            recommend turning it back on from Settings. If you didn't request this, sign in now,
            change your password and re-enable two-factor authentication right away — you don't
            need to wait on a reply from us to lock things back down.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${appUrl()}/dashboard/settings"
               style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Go to account settings →
            </a>
          </div>
          <p style="color:#888;font-size:13px;text-align:center;">
            Also worth changing your password if you're not sure how this happened.
            Still concerned, or can't sign in?
            <a href="mailto:support@globproxy.com" style="color:#2563eb;">Contact support</a>.
          </p>
          <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
            © 2026 GlobProxy · Residential Proxies That Never Expire
          </p>
        </div>
      `,
    })
  }

  return NextResponse.json({ success: true })
}
