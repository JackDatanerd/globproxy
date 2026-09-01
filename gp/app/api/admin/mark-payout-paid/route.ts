import { createAdminClient } from '@/lib/supabase/server'
import { requireMfaVerified } from '@/lib/mfa'
import { sendEmail, escapeHtml } from '@/lib/email'
import { formatCycleLabel } from '@/lib/payoutCycle'
import { NextResponse } from 'next/server'

// One action for a whole cycle's payout to one affiliate — not per
// commission, matching how the admin UI presents it. Same Bearer-token +
// MFA-gated admin pattern as every other /api/admin/* route. The actual
// money movement (USDT transfer or bank wire) happens outside the app;
// this route records that it happened and notifies the affiliate.
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

    const { payoutId } = await req.json()
    if (!payoutId) return NextResponse.json({ error: 'Payout ID missing' }, { status: 400 })

    // mark_affiliate_payout_paid is the idempotent, atomic claim (updates
    // the payout row AND mirrors status onto its linked commissions in
    // one transaction) — see migration 0034. Returns false if this
    // payout was already marked paid, which we surface as a 409 rather
    // than silently succeeding, so a double-click doesn't look like it
    // did something the second time.
    const { data: claimed, error: rpcErr } = await supabaseAdmin.rpc('mark_affiliate_payout_paid', { p_payout_id: payoutId })
    if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 })
    if (!claimed) return NextResponse.json({ error: 'This payout is not in a payable state (already paid?)' }, { status: 409 })

    const { data: payout } = await supabaseAdmin
      .from('affiliate_payouts')
      .select('amount_usd, cycle_start, cycle_end, payout_method, referrer:referrer_id(email, full_name)')
      .eq('id', payoutId)
      .single()

    await supabaseAdmin.from('affiliate_payouts').update({ notified_at: new Date().toISOString() }).eq('id', payoutId)

    const referrer = payout?.referrer as any
    if (referrer?.email && payout) {
      await sendEmail({
        to: referrer.email,
        subject: `Your GlobProxy affiliate payout has been sent`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">Payout sent ✓</h2>
            <p style="color:#444;text-align:center;">
              Hi ${escapeHtml(referrer.full_name?.split(' ')[0]) || 'there'}, your affiliate payout of
              <strong>$${Number(payout.amount_usd).toFixed(2)}</strong> for
              ${escapeHtml(formatCycleLabel(payout))} has been sent via
              ${payout.payout_method === 'usdt' ? 'USDT (TRC20)' : 'bank transfer'}.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/referrals"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                View your payout history →
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
