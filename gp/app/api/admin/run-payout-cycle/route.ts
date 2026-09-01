import { createAdminClient } from '@/lib/supabase/server'
import { requireMfaVerified } from '@/lib/mfa'
import { sendEmail, escapeHtml } from '@/lib/email'
import { lastCompletedCycle, formatCycleLabel } from '@/lib/payoutCycle'
import { NextResponse } from 'next/server'

const DEFAULT_MIN_PAYOUT_USD = 20
const DEFAULT_HOLD_HOURS = 48

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

    const body = await req.json().catch(() => ({}))
    const fallback = lastCompletedCycle()
    const cycleStart = body.cycleStart || fallback.cycleStart
    const cycleEnd = body.cycleEnd || fallback.cycleEnd
    const minPayoutUsd = typeof body.minPayoutUsd === 'number' ? body.minPayoutUsd : DEFAULT_MIN_PAYOUT_USD
    const holdHours = typeof body.holdHours === 'number' ? body.holdHours : DEFAULT_HOLD_HOURS

    // run_affiliate_payout_cycle (migration 0034) does all the real work
    // — grouping unbatched commissions by referrer, applying the minimum
    // and the hold, creating payout rows, claiming commissions — in one
    // transaction. This route's job is just to invoke it and turn the
    // result into affiliate-facing notifications + an admin-facing summary.
    const { data: results, error: rpcErr } = await supabaseAdmin.rpc('run_affiliate_payout_cycle', {
      p_cycle_start: cycleStart,
      p_cycle_end: cycleEnd,
      p_min_payout_usd: minPayoutUsd,
      p_hold_hours: holdHours,
    })

    if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 })

    const rows = (results ?? []) as {
      out_referrer_id: string
      out_status: string
      out_amount_usd: number
      out_payout_id: string | null
    }[]

    // Best-effort notifications — never let an email failure affect the
    // response, the cycle already ran and its results are already
    // committed by the time we get here.
    const cycleLabel = formatCycleLabel({ cycle_start: cycleStart, cycle_end: cycleEnd })
    for (const row of rows) {
      if (row.out_status !== 'held_recent_method' && row.out_status !== 'no_payout_method') continue

      const { data: referrer } = await supabaseAdmin
        .from('profiles')
        .select('email, full_name')
        .eq('id', row.out_referrer_id)
        .single()
      if (!referrer?.email) continue

      const reason = row.out_status === 'held_recent_method'
        ? `your payout method was added or changed too recently to clear our ${holdHours}-hour security hold in time for this cycle`
        : `you don't have a payout method on file yet`

      await sendEmail({
        to: referrer.email,
        subject: `Your GlobProxy affiliate earnings are rolling to the next payout`,
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
            <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
              style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
            <h2 style="text-align:center;color:#111;">Your earnings are still accumulating</h2>
            <p style="color:#444;text-align:center;">
              Hi ${escapeHtml(referrer.full_name?.split(' ')[0]) || 'there'}, you earned
              <strong>$${Number(row.out_amount_usd).toFixed(2)}</strong> in commissions for ${escapeHtml(cycleLabel)},
              but ${reason}. Nothing is lost — it carries over and will be included in your next payout automatically.
            </p>
            <div style="text-align:center;margin:32px 0;">
              <a href="${process.env.NEXT_PUBLIC_APP_URL}/dashboard/referrals"
                 style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
                ${row.out_status === 'no_payout_method' ? 'Add a payout method →' : 'View your referrals →'}
              </a>
            </div>
            <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
              © 2026 GlobProxy · Residential Proxies That Never Expire
            </p>
          </div>
        `,
      }).catch(() => {})
    }

    return NextResponse.json({
      success: true,
      cycleStart,
      cycleEnd,
      minPayoutUsd,
      holdHours,
      results: rows,
      summary: {
        created: rows.filter(r => r.out_status === 'created').length,
        heldRecentMethod: rows.filter(r => r.out_status === 'held_recent_method').length,
        belowMinimum: rows.filter(r => r.out_status === 'below_minimum').length,
        noPayoutMethod: rows.filter(r => r.out_status === 'no_payout_method').length,
        alreadyRun: rows.filter(r => r.out_status === 'already_run').length,
      },
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
