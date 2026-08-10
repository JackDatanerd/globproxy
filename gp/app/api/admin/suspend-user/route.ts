import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
import { requireMfaVerified } from '@/lib/mfa'
import { NextResponse } from 'next/server'

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

  const { user_id, action } = await req.json() // action: 'suspend' | 'unsuspend'
  if (!user_id || !action) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })

  const { data: tp } = await supabase.from('profiles').select('role, email, full_name').eq('id', user_id).single()
  // Previously a missing target fell through silently: `tp?.role === 'admin'`
  // is `false` when tp is null, so this continued straight to an update that
  // matched 0 rows (Supabase doesn't error on that) and still returned
  // `{ success: true }`, plus signed out a non-existent user_id.
  if (!tp) return NextResponse.json({ error: 'User not found' }, { status: 404 })
  if (tp.role === 'admin') return NextResponse.json({ error: 'Cannot suspend admin' }, { status: 403 })

  const isSuspending = action === 'suspend'

  // Update profile
  const { error } = await supabase.from('profiles').update({
    is_suspended: isSuspending,
    suspended_at: isSuspending ? new Date().toISOString() : null,
    suspension_reason: isSuspending ? 'Suspended by admin' : null,
  }).eq('id', user_id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Kill active sessions. auth.admin.signOut() takes a session JWT, not a
  // user_id (confirmed against @supabase/auth-js's own type signature) — a
  // user_id here always failed, silently, meaning suspended users' existing
  // tokens kept working until natural expiry despite the code comment
  // implying otherwise. There's no simple "kill all sessions for this
  // user_id" call in the admin API, so use ban_duration instead: it blocks
  // new logins and token refreshes immediately, which combined with
  // is_suspended now being checked on every write route (see
  // lib/apiAuth.ts requireActiveUser) means even a still-valid access
  // token can't do anything meaningful until it naturally expires within
  // the hour. Reversible on unsuspend below, unlike the permanent ban used
  // for account deletion.
  if (isSuspending) {
    await supabase.auth.admin.updateUserById(user_id, { ban_duration: '876000h' }).catch(() => {})
  } else {
    await supabase.auth.admin.updateUserById(user_id, { ban_duration: 'none' }).catch(() => {})
  }

  // Send email
  if (tp?.email) {
    await sendEmail({
      to: tp.email,
      subject: isSuspending ? 'Your GlobProxy account has been suspended' : 'Your GlobProxy account has been reinstated',
      html: isSuspending ? `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
          <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
            style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
          <h2 style="text-align:center;color:#111;">Account suspended</h2>
          <p style="color:#444;text-align:center;">
            Hi ${escapeHtml(tp.full_name) || 'there'}, your GlobProxy account has been suspended.
            If you believe this is a mistake, please contact us.
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
      ` : `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
          <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
            style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
          <h2 style="text-align:center;color:#111;">Account reinstated ✓</h2>
          <p style="color:#444;text-align:center;">
            Hi ${escapeHtml(tp.full_name) || 'there'}, your GlobProxy account has been reinstated.
            You can now log back in and continue using our services.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="${process.env.NEXT_PUBLIC_APP_URL}/auth/login"
               style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Sign in →
            </a>
          </div>
          <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
            © 2026 GlobProxy · Residential Proxies That Never Expire
          </p>
        </div>
      `,
    })
  }

  return NextResponse.json({ success: true })
}