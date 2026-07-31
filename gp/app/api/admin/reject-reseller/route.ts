import { createAdminClient, createClient } from '@/lib/supabase/server'
import { sendEmail } from '@/lib/email'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { userId } = body
    if (!userId) return NextResponse.json({ error: 'User ID missing' }, { status: 400 })

    const supabaseAdmin = await createAdminClient()
    
    // Auth Check
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Verify Admin Status
    const { data: adminProfile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single()
    if (adminProfile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    // Reject user - revert status
    const { data: applicant, error: updateErr } = await supabaseAdmin
      .from('profiles')
      .update({ role: 'user', reseller_status: 'rejected' })
      .eq('id', userId)
      .select('email, full_name')
      .single()

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

    if (applicant?.email) {
      await sendEmail({
        to: applicant.email,
        subject: 'Update on your GlobProxy reseller application',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">Reseller application update</h2>
            <p style="color:#444;text-align:center;">
              Hi ${applicant.full_name?.split(' ')[0] ?? 'there'}, we're not able to approve your reseller
              application at this time. You're welcome to continue using GlobProxy as a regular customer,
              or reach out to support if you'd like to discuss reapplying.
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
      }).catch(() => {})
    }

    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}