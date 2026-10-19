import type { createAdminClient } from '@/lib/supabase/server'
import { cleanReferralCode, cleanSubId } from '@/lib/referralAttribution'

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

// 30% → "30%", 12.5% → "12.5%" (Math.round(rate*100) used to print 13%).
export function formatRatePct(rate: number | null | undefined): string {
  const pct = Number(rate ?? 0) * 100
  return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(1))}%`
}

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

// Called from activateBandwidth() *after* the buyer's own GB credit has
// already landed via claim_and_credit_order — a pure add-on; every error is
// caught and logged. A broken referral RPC must never turn a successful
// payment into a failed response. Anything it misses is picked up by the
// 'referrals' cron task (reconcile_referral_rewards), which re-runs the same
// idempotent RPCs for recent credited orders.
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
      const { error } = await admin.rpc('record_affiliate_commission', {
        p_referral_id: referral.id,
        p_order_id: p.order_id,
        p_gross_amount: p.amount_usd,
      })
      if (error) { console.error('[referrals] record_affiliate_commission failed', p.order_id, error); return false }
    } else if (status === 'suspended') {
      // A suspended affiliate earns nothing — and must not silently fall
      // back to the standard GB bonus either.
      return true
    } else {
      // Standard referral: one-time GB bonus to both sides. Safe to call on
      // every order — credit_referral_bonus's own row lock + null check makes
      // it a no-op after the first, and it enforces the minimum order amount,
      // the fraud flag and referrer suspension/deletion server-side.
      const { error } = await admin.rpc('credit_referral_bonus', {
        p_referral_id: referral.id,
        p_gb: REFERRAL_GB_BONUS,
        p_order_amount_usd: p.amount_usd,
        p_min_order_usd: REFERRAL_MIN_ORDER_USD,
      })
      if (error) { console.error('[referrals] credit_referral_bonus failed', p.order_id, error); return false }
    }
    return true
  } catch (e) {
    console.error('[referrals] processReferralForOrder threw — order credit already succeeded, this is non-fatal', p.order_id, e)
    return false
  }
}

// Reverse (or claw back) the commission on a refunded order. Idempotent and
// self-healing — it derives the amount from the order's CURRENT refunded_usd.
export async function reverseCommissionForRefund(
  admin: AdminClient,
  orderId: string
): Promise<{ reversed: number } | null> {
  try {
    const { data, error } = await admin.rpc('reverse_affiliate_commission_for_refund', { p_order_id: orderId })
    if (error) {
      console.error('[referrals] reverse_affiliate_commission_for_refund failed', orderId, error)
      return null
    }
    return { reversed: Number((data as any)?.reversed ?? 0) }
  } catch (e) {
    console.error('[referrals] reverseCommissionForRefund threw', orderId, e)
    return null
  }
}
