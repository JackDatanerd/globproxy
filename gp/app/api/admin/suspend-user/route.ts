import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/email'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = await createAdminClient()
  const { data: { user: caller } } = await supabase.auth.getUser(token)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: cp } = await supabase.from('profiles').select('role').eq('id', caller.id).single()
  if (cp?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { user_id, action } = await req.json() // action: 'suspend' | 'unsuspend'
  if (!user_id || !action) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })

  const { data: tp } = await supabase.from('profiles').select('role, email, full_name').eq('id', user_id).single()
  if (tp?.role === 'admin') return NextResponse.json({ error: 'Cannot suspend admin' }, { status: 403 })

  const isSuspending = action === 'suspend'

  // Update profile
  const { error } = await supabase.from('profiles').update({
    is_suspended: isSuspending,
    suspended_at: isSuspending ? new Date().toISOString() : null,
    suspension_reason: isSuspending ? 'Suspended by admin' : null,
  }).eq('id', user_id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Kill active sessions
  if (isSuspending) {
    await supabase.auth.admin.signOut(user_id, 'others')
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
            Hi ${tp.full_name ?? 'there'}, your GlobProxy account has been suspended.
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
            Hi ${tp.full_name ?? 'there'}, your GlobProxy account has been reinstated.
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