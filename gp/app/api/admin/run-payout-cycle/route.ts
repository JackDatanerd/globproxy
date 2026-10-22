import { authorizeAdmin, readJson, badRequest, isIsoDate } from '@/lib/adminAuth'
import { logAdminAction } from '@/lib/adminAudit'
import { adminNoticeHtml, appUrl } from '@/lib/adminEmail'
import { sendEmailSafe, escapeHtml } from '@/lib/email'
import { lastCompletedCycle, formatCycleLabel, currentAccruingCycle, cycleIsPayable } from '@/lib/payoutCycle'
import { notifyPayoutQueued } from '@/lib/affiliateNotify'
import { AFFILIATE_MIN_PAYOUT_USD, AFFILIATE_HOLD_HOURS } from '@/lib/referrals'
import { NextResponse } from 'next/server'

// Single source of truth with the Terms page and the affiliate dashboard
// (lib/referrals) — a second copy here could drift from what affiliates are told.
const DEFAULT_MIN_PAYOUT_USD = AFFILIATE_MIN_PAYOUT_USD
const DEFAULT_HOLD_HOURS = AFFILIATE_HOLD_HOURS

type Row = { out_referrer_id: string; out_status: string; out_amount_usd: number; out_payout_id: string | null }

export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const { supabase, adminId } = auth

  const body = (await readJson<{ cycleStart?: unknown; cycleEnd?: unknown; minPayoutUsd?: unknown; holdHours?: unknown; payEarly?: unknown }>(req)) ?? {}
  const fallback = lastCompletedCycle()
  const cycleStart = body.cycleStart ?? fallback.cycleStart
  const cycleEnd = body.cycleEnd ?? fallback.cycleEnd

  // These used to flow into the RPC unvalidated: a negative minimum paid
  // out every dust balance, a negative hold disabled the security hold, and
  // a future cycleEnd paid a cycle that hadn't finished accruing.
  if (!isIsoDate(cycleStart) || !isIsoDate(cycleEnd)) return badRequest('cycleStart and cycleEnd must be valid YYYY-MM-DD dates')
  if (cycleStart > cycleEnd) return badRequest('cycleStart must not be after cycleEnd')
  const today = new Date().toISOString().slice(0, 10)
  if (cycleEnd >= today) return badRequest('That cycle has not finished yet — pick a cycle that ended before today (UTC).')

  // The published schedule is "payable from the 20th / the 5th". Running before
  // that pays affiliates ahead of the date they were promised (and before late
  // refunds can land), so it needs an explicit, audited override.
  const payableFrom = currentAccruingCycle(new Date(`${cycleEnd}T00:00:00Z`)).payableFrom
  const early = !cycleIsPayable({ payableFrom })
  if (early && body.payEarly !== true) {
    return badRequest(`This cycle is not payable until ${payableFrom} (UTC). Confirm "pay early" to run it before then.`)
  }

  const minPayoutUsd = body.minPayoutUsd === undefined ? DEFAULT_MIN_PAYOUT_USD : body.minPayoutUsd
  const holdHours = body.holdHours === undefined ? DEFAULT_HOLD_HOURS : body.holdHours
  if (typeof minPayoutUsd !== 'number' || !Number.isFinite(minPayoutUsd) || minPayoutUsd < 0 || minPayoutUsd > 100000) {
    return badRequest('minPayoutUsd must be a number between 0 and 100000')
  }
  if (typeof holdHours !== 'number' || !Number.isInteger(holdHours) || holdHours < 0 || holdHours > 720) {
    return badRequest('holdHours must be a whole number between 0 and 720')
  }

  // run_affiliate_payout_cycle (migration 0043) does the real work —
  // grouping every unbatched pending commission earned up to the cycle end
  // (so held / below-minimum balances from earlier cycles carry over),
  // applying eligibility, minimum and hold, creating payouts and claiming
  // commissions — in one transaction.
  const { data: results, error: rpcErr } = await supabase.rpc('run_affiliate_payout_cycle', {
    p_cycle_start: cycleStart,
    p_cycle_end: cycleEnd,
    p_min_payout_usd: minPayoutUsd,
    p_hold_hours: holdHours,
  })
  if (rpcErr) {
    console.error('[admin/run-payout-cycle] rpc failed', rpcErr)
    return NextResponse.json({ error: 'Payout cycle failed — nothing was changed. Check the logs and retry.' }, { status: 500 })
  }
  const rows = (results ?? []) as Row[]

  const summary = {
    created: rows.filter(r => r.out_status === 'created').length,
    heldRecentMethod: rows.filter(r => r.out_status === 'held_recent_method').length,
    belowMinimum: rows.filter(r => r.out_status === 'below_minimum').length,
    noPayoutMethod: rows.filter(r => r.out_status === 'no_payout_method').length,
    ineligible: rows.filter(r => r.out_status === 'ineligible').length,
    alreadyRun: rows.filter(r => r.out_status === 'already_run').length,
  }

  await logAdminAction(supabase, {
    adminId, action: 'payout.run_cycle', targetRef: `${cycleStart}..${cycleEnd}`,
    details: { minPayoutUsd, holdHours, paid_early: early, payable_from: payableFrom, ...summary, total_usd: rows.filter(r => r.out_status === 'created').reduce((s, r) => s + Number(r.out_amount_usd), 0) },
  })

  // Best-effort notifications — the cycle has already committed. One profile
  // query for everyone (was one per affiliate), and sends run in small
  // parallel batches (was strictly sequential, which risks a Worker
  // timeout on a big cycle).
  const cycleLabel = formatCycleLabel({ cycle_start: cycleStart, cycle_end: cycleEnd })
  // A net-negative balance (a clawback bigger than the new commissions) isn't
  // "earnings ready" — nothing to tell them yet.
  const allNotify = rows.filter(r => (r.out_status === 'held_recent_method' || r.out_status === 'no_payout_method') && Number(r.out_amount_usd) > 0)
  // One notice per affiliate, cycle and reason: re-running a cycle used to
  // re-send this to everyone still waiting. The primary key on
  // affiliate_rollover_notices decides — only rows that were NEWLY inserted
  // get an email (ignoreDuplicates drops the rest from the result).
  let notify = allNotify
  if (allNotify.length) {
    const { data: fresh, error: noticeErr } = await supabase
      .from('affiliate_rollover_notices')
      .upsert(
        allNotify.map(r => ({ referrer_id: r.out_referrer_id, cycle_end: cycleEnd as string, kind: r.out_status })),
        { onConflict: 'referrer_id,cycle_end,kind', ignoreDuplicates: true }
      )
      .select('referrer_id, kind')
    if (noticeErr) {
      // Can't tell who was already told — skipping is safer than spamming.
      console.error('[run-payout-cycle] rollover notice de-dupe failed; skipping emails', noticeErr)
      notify = []
    } else {
      const freshKeys = new Set((fresh ?? []).map(f => `${f.referrer_id}:${f.kind}`))
      notify = allNotify.filter(r => freshKeys.has(`${r.out_referrer_id}:${r.out_status}`))
    }
  }
  if (notify.length) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, email, full_name')
      .in('id', notify.map(r => r.out_referrer_id))
    const byId = new Map((profiles ?? []).map(p => [p.id, p]))

    const jobs = notify.map(row => async () => {
      const referrer = byId.get(row.out_referrer_id)
      if (!referrer?.email || referrer.email === '[deleted]') return
      const reason = row.out_status === 'held_recent_method'
        ? `your payout method was added or changed too recently to clear our ${holdHours}-hour security hold in time for this cycle`
        : `you don't have a payout method on file yet`
      await sendEmailSafe({
        to: referrer.email,
        subject: 'Your GlobProxy affiliate earnings are rolling to the next payout',
        html: adminNoticeHtml({
          heading: 'Your earnings are still accumulating',
          bodyHtml: `Hi ${escapeHtml(referrer.full_name?.split(' ')[0]) || 'there'}, you have <strong>$${Number(row.out_amount_usd).toFixed(2)}</strong> in commissions ready as of ${escapeHtml(cycleLabel)}, but ${reason}. Nothing is lost — it carries over and will be included in your next payout automatically.`,
          cta: { href: `${appUrl()}/dashboard/referrals`, label: row.out_status === 'no_payout_method' ? 'Add a payout method →' : 'View your referrals →' },
        }),
      })
    })
    for (let i = 0; i < jobs.length; i += 10) {
      await Promise.allSettled(jobs.slice(i, i + 10).map(j => j()))
    }
  }

  // "Payout queued" — they used to hear nothing until it was SENT, so a
  // created payout looked like nothing had happened for days.
  const created = rows.filter(r => r.out_status === 'created' && r.out_payout_id)
  if (created.length) {
    const { data: made } = await supabase
      .from('affiliate_payouts').select('id, referrer_id, amount_usd, cycle_start, cycle_end, payout_method')
      .in('id', created.map(r => r.out_payout_id as string))
    const jobs = (made ?? []).map(m => () => notifyPayoutQueued(supabase, m.referrer_id, {
      amount_usd: Number(m.amount_usd), cycle_start: m.cycle_start, cycle_end: m.cycle_end, method: m.payout_method,
    }))
    for (let i = 0; i < jobs.length; i += 10) {
      await Promise.allSettled(jobs.slice(i, i + 10).map(j => j()))
    }
  }

  return NextResponse.json({ success: true, cycleStart, cycleEnd, minPayoutUsd, holdHours, results: rows, summary })
}
