import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
import { requireMfaVerified } from '@/lib/mfa'
import { NextResponse } from 'next/server'

// Same Bearer-token + MFA-gated pattern as approve-reseller/route.ts.
// Unlike reseller approval, this never touches profiles.role — affiliate
// status is an independent flag alongside whatever role the account
// already has, not a role change of its own.
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

    const { userId, introRate, lifetimeRate } = await req.json()
    if (!userId) return NextResponse.json({ error: 'User ID missing' }, { status: 400 })

    // Same 0-1 range record_affiliate_commission() enforces server-side —
    // validated here too so a bad admin-panel input fails with a clear
    // error instead of tripping the DB constraint on the update below.
    const rate1 = introRate ?? 0.30
    const rate2 = lifetimeRate ?? 0.15
    if (typeof rate1 !== 'number' || rate1 < 0 || rate1 > 1 || typeof rate2 !== 'number' || rate2 < 0 || rate2 > 1) {
      return NextResponse.json({ error: 'Commission rates must be between 0 and 1' }, { status: 400 })
    }

    const { data: existing } = await supabaseAdmin.from('profiles').select('affiliate_status').eq('id', userId).single()
    if (existing?.affiliate_status !== 'pending') {
      return NextResponse.json({ error: 'This application has already been resolved.' }, { status: 409 })
    }

    const { data: applicant, error: updateErr } = await supabaseAdmin
      .from('profiles')
      .update({
        affiliate_status: 'approved',
        affiliate_commission_rate: rate1,
        affiliate_commission_rate_lifetime: rate2,
      })
      .eq('id', userId)
      .select('email, full_name')
      .single()

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

    if (applicant?.email) {
      await sendEmail({
        to: applicant.email,
        subject: 'Your GlobProxy affiliate application was approved',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">Affiliate application approved ✓</h2>
            <p style="color:#444;text-align:center;">
              Hi ${escapeHtml(applicant.full_name?.split(' ')[0]) || 'there'}, your affiliate application has
              been approved. You'll earn ${Math.round(rate1 * 100)}% on your referrals' orders for their
              first 90 days, then ${Math.round(rate2 * 100)}% for as long as they stay active.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/referrals"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                Get your referral link →
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
