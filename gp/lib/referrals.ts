import type { createAdminClient } from '@/lib/supabase/server'
import { dispatchWebhook } from '@/lib/webhooks'
import { cleanReferralCode, cleanSubId } from '@/lib/referralAttribution'
import { sendEmail, escapeHtml } from '@/lib/email'
import { appUrl } from '@/lib/appUrl'
import { formatUsd } from '@/lib/format'

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>

// GB credited to both sides of a standard (non-affiliate) referral, once,
// when the referred user's first order gets credited. Every piece of UI/email
// copy that mentions the amount reads this constant — never hardcode "1 GB".
export const REFERRAL_GB_BONUS = 1

// Orders below this don't trigger the standard GB bonus — stops "buy the
// cheapest possible pack on a second account" farming. Does not apply to
// affiliate commissions (those scale with the order amount anyway).
export const REFERRAL_MIN_ORDER_USD = 5

// Intro commission rate window (kept in sync with the 90-day interval inside
// record_affiliate_commission() in the database).
export const AFFILIATE_INTRO_WINDOW_DAYS = 90

export const AFFILIATE_MIN_PAYOUT_USD = 20
export const AFFILIATE_HOLD_HOURS = 48

import { formatRatePct } from '@/lib/rates'
export { formatRatePct }

export type ReferralSignupResult =
  | 'recorded'
  | 'recorded_flagged'
  | 'already_referred'
  | 'invalid_code'
  | 'self_referral'
  | 'referrer_inactive'
  | 'has_orders'
  | 'ignored'
  | 'error'

// Attribute a new signup to whoever owns `code`, if it's real. Called from
// the signup route right after auth.signUp() returns a user id — never
// allowed to fail the signup itself: EVERYTHING (including a non-string code
// from a hand-rolled API call) is caught, not thrown. A stale/mistyped/missing
// referral code should never be the reason someone can't create an account.
export async function recordReferralSignup(
  admin: AdminClient,
  code: unknown,
  newUserId: string,
  opts: { subId?: unknown; ipHash?: string | null; claim?: boolean } = {}
): Promise<ReferralSignupResult> {
  try {
    const clean = cleanReferralCode(code)
    if (!clean) return 'invalid_code'
    const common = { p_code: clean, p_sub_id: cleanSubId(opts.subId), p_ip_hash: opts.ipHash ?? null }
    const { data, error } = opts.claim
      ? await admin.rpc('claim_referral_code', { ...common, p_user_id: newUserId })
      : await admin.rpc('record_referral_signup', { ...common, p_new_user_id: newUserId })
    if (error) {
      console.error('[referrals] attribution RPC failed — non-fatal', newUserId, error)
      return 'error'
    }
    return (data as ReferralSignupResult) ?? 'ignored'
  } catch (e) {
    console.error('[referrals] attribution threw — non-fatal', newUserId, e)
    return 'error'
  }
}

// Record the address an account signed up from. Every account, referred or not:
// a referrer's OWN address is what a self-referral is compared against.
// Best-effort — never allowed to affect the signup.
export async function recordSignupIp(admin: AdminClient, userId: string, ipHash: string | null): Promise<void> {
  if (!ipHash) return
  try {
    const { error } = await admin.rpc('record_signup_ip', { p_user_id: userId, p_ip_hash: ipHash })
    if (error) console.error('[referrals] record_signup_ip failed — non-fatal', userId, error)
  } catch (e) {
    console.error('[referrals] record_signup_ip threw — non-fatal', userId, e)
  }
}

// Called from activateBandwidth() *after* the buyer's own GB credit has
// already landed via claim_and_credit_order — a pure add-on; every error is
// caught and logged. A broken referral RPC must never turn a successful
// payment into a failed response. A false return is retried through the
// post-credit retry mechanism (lib/bandwidth.ts, migration 0041), which re-runs
// these same idempotent RPCs.
export async function processReferralForOrder(
  admin: AdminClient,
  p: { user_id: string; order_id: string; amount_usd: number }
): Promise<boolean> {
  // Returns true when the referral side-effect is settled (including "nothing
  // to do"), false when a retryable failure occurred — lib/bandwidth.ts uses
  // that to schedule a retry through the post-credit retry mechanism
  // (migration 0041).
  try {
    const { data: referral, error: referralErr } = await admin
      .from('referrals')
      .select('id, referrer_id')
      .eq('referred_user_id', p.user_id)
      .maybeSingle()

    if (referralErr) {
      console.error('[referrals] lookup failed', p.order_id, referralErr)
      return false
    }
    if (!referral) return true // this user wasn't referred — nothing to do

    const { data: referrerProfile, error: profileErr } = await admin
      .from('profiles')
      .select('affiliate_status')
      .eq('id', referral.referrer_id)
      .single()

    if (profileErr) {
      console.error('[referrals] referrer profile lookup failed', p.order_id, profileErr)
      return false
    }

    const status = referrerProfile?.affiliate_status
    if (status === 'approved') {
      // Approved affiliate: every qualifying order earns a commission.
      // record_affiliate_commission checks suspension/deletion and the
      // fraud flag itself and is idempotent per order_id.
      // The 90-day intro rate is judged at the time the ORDER was paid, not
      // when this (possibly retried, possibly days late) call runs.
      const { data: ord } = await admin.from('orders').select('paid_at').eq('id', p.order_id).maybeSingle()
      const { data: rec, error } = await admin.rpc('record_affiliate_commission', {
        p_referral_id: referral.id,
        p_order_id: p.order_id,
        p_gross_amount: p.amount_usd,
        p_earned_at: ord?.paid_at ?? null,
      })
      if (error) { console.error('[referrals] record_affiliate_commission failed', p.order_id, error); return false }
      // First commission on this referral = the referral just converted. Tell
      // the affiliate once (the RPC only reports a row it newly inserted, so a
      // retry never double-sends).
      const r = rec as { commission_usd?: number; rate?: number; first?: boolean } | null
      if (r?.first) {
        await notifyReferrerConverted(admin, referral.referrer_id, { kind: 'commission', usd: Number(r.commission_usd ?? 0), rate: Number(r.rate ?? 0) })
      }
    } else if (status === 'suspended') {
      // A suspended affiliate earns nothing — and must not silently fall
      // back to the standard GB bonus either.
      return true
    } else {
      // Standard referral: one-time GB bonus to both sides. Safe to call on
      // every order — credit_referral_bonus's own row lock + null check makes
      // it a no-op after the first, and it enforces the minimum order amount,
      // the fraud flag and referrer suspension/deletion server-side.
      const { data: credited, error } = await admin.rpc('credit_referral_bonus', {
        p_referral_id: referral.id,
        p_gb: REFERRAL_GB_BONUS,
        p_order_amount_usd: p.amount_usd,
        p_min_order_usd: REFERRAL_MIN_ORDER_USD,
        p_order_id: p.order_id,
      })
      if (error) { console.error('[referrals] credit_referral_bonus failed', p.order_id, error); return false }
      if (credited === true) {
        // Both sides just received GB, so both accounts get the same event a
        // purchase would have produced — this credit used to be invisible to
        // anything reconciling balances from webhooks. Fired once: the RPC only
        // returns true on the call that actually paid the bonus.
        await Promise.all([
          dispatchWebhook(p.user_id, 'bandwidth_credited', { gb_credited: REFERRAL_GB_BONUS, source: 'referral_bonus', role: 'referred' }),
          dispatchWebhook(referral.referrer_id, 'bandwidth_credited', { gb_credited: REFERRAL_GB_BONUS, source: 'referral_bonus', role: 'referrer' }),
        ]).catch((e) => console.error('[referrals] bandwidth_credited webhook failed (bonus already paid)', p.order_id, e))
        await notifyReferrerConverted(admin, referral.referrer_id, { kind: 'bonus', gb: REFERRAL_GB_BONUS })
      }
    }
    return true
  } catch (e) {
    console.error('[referrals] processReferralForOrder threw — order credit already succeeded, this is non-fatal', p.order_id, e)
    return false
  }
}

// Refunds are handled entirely in the database: the triggers on orders
// (reduce_commission_on_refund, reverse_referral_bonus_on_refund) shrink or void
// the commission / claw back the standard GB bonus whenever refunded_usd rises.

// One short "your referral converted" email to the referrer. Best-effort: the
// reward is already recorded, so a mail failure must never fail or retry the
// order. Never names the referred user.
async function notifyReferrerConverted(
  admin: AdminClient,
  referrerId: string,
  what: { kind: 'commission'; usd: number; rate: number } | { kind: 'bonus'; gb: number }
): Promise<void> {
  try {
    const { data: ref } = await admin.from('profiles')
      .select('email, full_name, is_deleted, is_suspended').eq('id', referrerId).single()
    if (!ref?.email || ref.is_deleted || ref.is_suspended || String(ref.email).startsWith('[')) return
    const name = escapeHtml(String(ref.full_name ?? '').split(' ')[0]) || 'there'
    const headline = what.kind === 'commission'
      ? `You earned ${escapeHtml(formatUsd(what.usd))} (${escapeHtml(formatRatePct(what.rate))}) from a referral's first order.`
      : `You and your referral each received ${what.gb} GB of bandwidth.`
    const tail = what.kind === 'commission'
      ? 'Commissions are grouped into biweekly payout cycles — you can follow them on your referrals page.'
      : 'The bonus is already in your balance.'
    await sendEmail({
      to: ref.email,
      subject: what.kind === 'commission' ? 'Your referral just made a purchase' : 'Your referral bonus has landed',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
          <h2 style="text-align:center;color:#111;">A referral converted 🎉</h2>
          <p style="color:#444;text-align:center;">Hi ${name}, ${headline}</p>
          <p style="color:#444;text-align:center;">${tail}</p>
          <p style="text-align:center;"><a href="${appUrl()}/dashboard/referrals" style="color:#0a7;">Open your referrals →</a></p>
        </div>`,
    })
  } catch (e) {
    console.error('[referrals] converted-notify failed — non-fatal', referrerId, e)
  }
}
