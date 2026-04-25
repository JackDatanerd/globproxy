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

  const { user_id } = await req.json()
  if (!user_id) return NextResponse.json({ error: 'user_id required' }, { status: 400 })

  const { data: tp } = await supabase
    .from('profiles')
    .select('role, email, full_name')
    .eq('id', user_id)
    .single()

  if (tp?.role === 'admin') return NextResponse.json({ error: 'Cannot delete admin accounts' }, { status: 403 })

  // Send deletion email BEFORE deleting so we still have their info
  if (tp?.email) {
    await sendEmail({
      to: tp.email,
      subject: 'Your GlobProxy account has been permanently deleted',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
          <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
            style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
          <h2 style="text-align:center;color:#111;">Account permanently deleted</h2>
          <p style="color:#444;text-align:center;">
            Hi ${tp.full_name ?? 'there'}, your GlobProxy account has been permanently deleted 
            by an administrator. All your data has been removed from our systems.
          </p>
          <p style="color:#444;text-align:center;">
            If you believe this was a mistake, contact us immediately.
          </p>
          <div style="text-align:center;margin:32px 0;">
            <a href="mailto:support@globproxy.com"
               style="background:#dc2626;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
              Contact support →
            </a>
          </div>
          <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
            © 2026 GlobProxy · Residential Proxies That Never Expire
          </p>
        </div>
      `,
    })
  }

// Ban the email so they can't re-register
await supabase.from('banned_emails').upsert({
  email: tp.email.toLowerCase(),
  reason: 'Account deleted by admin',
  banned_by: caller.id,
}, { onConflict: 'email' })

  // Delete the auth user
  const { error } = await supabase.auth.admin.deleteUser(user_id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}