import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
import { requireMfaVerified } from '@/lib/mfa'
import { NextResponse } from 'next/server'

// Mirrors app/api/admin/approve-reseller/route.ts — same auth pattern,
// same "re-check the status is still pending before acting" guard against
// double-submission from two open tabs.
export async function POST(req: Request) {
  try {
    const token = req.headers.get('authorization')?.replace('Bearer ', '')
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const supabaseAdmin = await createAdminClient()
    const { data: { user } } = await supabaseAdmin.auth.getUser(token)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: adminProfile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single()
    if (adminProfile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const mfaCheck = await requireMfaVerified(req, user.id)
    if (mfaCheck) return mfaCheck

    const { userId } = await req.json()
    if (!userId) return NextResponse.json({ error: 'User ID missing' }, { status: 400 })

    const { data: existing } = await supabaseAdmin.from('profiles').select('api_access_status, role').eq('id', userId).single()
    if (existing?.role !== 'reseller') {
      return NextResponse.json({ error: 'API access only applies to reseller accounts.' }, { status: 400 })
    }
    if (existing?.api_access_status !== 'pending') {
      return NextResponse.json({ error: 'This request has already been resolved.' }, { status: 409 })
    }

    const { data: applicant, error: updateErr } = await supabaseAdmin
      .from('profiles')
      .update({ api_access: true, api_access_status: 'approved' })
      .eq('id', userId)
      .select('email, full_name')
      .single()

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

    if (applicant?.email) {
      await sendEmail({
        to: applicant.email,
        subject: 'Your GlobProxy API access request was approved',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">API access approved ✓</h2>
            <p style="color:#444;text-align:center;">
              Hi ${escapeHtml(applicant.full_name?.split(' ')[0]) || 'there'}, your API access request has been approved.
              Head to API Keys in your dashboard to generate a key and get started.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/api-keys"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                Go to API Keys →
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
