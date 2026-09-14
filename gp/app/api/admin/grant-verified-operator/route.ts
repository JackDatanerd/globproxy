import { createAdminClient } from '@/lib/supabase/server'
import { sendEmail, escapeHtml } from '@/lib/email'
import { requireMfaVerified } from '@/lib/mfa'
import { NextResponse } from 'next/server'

// Same Bearer-token + MFA-gated admin pattern as approve-affiliate/route.ts.
// Unlike that route, this targets an *already-approved* affiliate — Verified
// Operator is a status on top of an existing affiliate relationship, not a
// replacement for the application flow. Rates are fixed at 0.40/0.20 (double
// the 0.30/0.15 default) rather than admin-supplied, since those numbers are
// the ceiling this exact product's margins were designed around (see
// marketing-plan discussion) — letting an admin type in an arbitrary rate
// here would silently reopen the thing this route exists to prevent.
const VERIFIED_OPERATOR_INTRO_RATE = 0.40
const VERIFIED_OPERATOR_LIFETIME_RATE = 0.20

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

    const { userId, revoke } = await req.json()
    if (!userId) return NextResponse.json({ error: 'User ID missing' }, { status: 400 })

    const { data: existing } = await supabaseAdmin
      .from('profiles')
      .select('affiliate_status, is_verified_operator')
      .eq('id', userId)
      .single()

    if (!existing) return NextResponse.json({ error: 'Profile not found' }, { status: 404 })

    // Revoke path: drop back to the standard affiliate defaults rather than
    // leaving a stale elevated rate in place with the flag off.
    if (revoke) {
      if (!existing.is_verified_operator) {
        return NextResponse.json({ error: 'This affiliate is not a Verified Operator.' }, { status: 409 })
      }
      const { error: revokeErr } = await supabaseAdmin
        .from('profiles')
        .update({
          is_verified_operator: false,
          verified_operator_since: null,
          affiliate_commission_rate: 0.30,
          affiliate_commission_rate_lifetime: 0.15,
        })
        .eq('id', userId)
      if (revokeErr) return NextResponse.json({ error: revokeErr.message }, { status: 500 })
      return NextResponse.json({ success: true, revoked: true })
    }

    if (existing.affiliate_status !== 'approved') {
      return NextResponse.json({ error: 'Only an already-approved affiliate can become a Verified Operator.' }, { status: 409 })
    }
    if (existing.is_verified_operator) {
      return NextResponse.json({ error: 'This affiliate is already a Verified Operator.' }, { status: 409 })
    }

    const { data: operator, error: updateErr } = await supabaseAdmin
      .from('profiles')
      .update({
        is_verified_operator: true,
        verified_operator_since: new Date().toISOString(),
        affiliate_commission_rate: VERIFIED_OPERATOR_INTRO_RATE,
        affiliate_commission_rate_lifetime: VERIFIED_OPERATOR_LIFETIME_RATE,
      })
      .eq('id', userId)
      .select('email, full_name')
      .single()

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 })

    if (operator?.email) {
      await sendEmail({
        to: operator.email,
        subject: "You're a GlobProxy Verified Operator",
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">Verified Operator ✓</h2>
            <p style="color:#444;text-align:center;">
              Hi ${escapeHtml(operator.full_name?.split(' ')[0]) || 'there'}, we've upgraded your affiliate
              account to Verified Operator — double the standard rate. You'll now earn
              ${Math.round(VERIFIED_OPERATOR_INTRO_RATE * 100)}% on your referrals' orders for their first 90
              days, then ${Math.round(VERIFIED_OPERATOR_LIFETIME_RATE * 100)}% for as long as they stay
              active.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/referrals"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                View your dashboard →
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
