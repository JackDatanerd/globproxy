import { createAdminClient, createClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/email'
import { NextResponse } from 'next/server'

// Previously "Approve" in the admin resellers panel wrote directly to
// `profiles` from the browser (AdminResellerActions.tsx), relying only on
// RLS with no dedicated server route, no audit point, and no notification
// email to the applicant. This gives that action an actual server endpoint
// to match reject-reseller and suspend-user.
export async function POST(req: Request) {
  try {
    const { userId } = await req.json()
    if (!userId) return NextResponse.json({ error: 'User ID missing' }, { status: 400 })

    const supabaseAdmin = await createAdminClient()

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: adminProfile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single()
    if (adminProfile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: applicant, error: updateErr } = await supabaseAdmin
      .from('profiles')
      .update({ role: 'reseller', reseller_status: 'approved' })
      .eq('id', userId)
      .select('email, full_name')
      .single()

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

    if (applicant?.email) {
      await sendEmail({
        to: applicant.email,
        subject: 'Your GlobProxy reseller application was approved',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">Reseller application approved ✓</h2>
            <p style="color:#444;text-align:center;">
              Hi ${applicant.full_name?.split(' ')[0] ?? 'there'}, your reseller application has been approved.
              You can now allocate bandwidth to your clients from your dashboard.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${process.env.NEXT_PUBLIC_APP_URL}/reseller"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                Go to reseller dashboard →
              </a>
            </div>
            <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
              © 2026 GlobProxy · Residential Proxies That Never Expire
            </p>
          </div>
        `,
      }).catch(() => {})
    }

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
