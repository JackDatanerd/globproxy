import type { createAdminClient } from '@/lib/supabase/server'

type AdminClient = Awaited<ReturnType<typeof createAdminClient>>

// GB credited to both sides of a standard (non-affiliate) referral, once,
// when the referred user's first order gets credited. Kept as a named
// constant rather than buried in the call site so it's easy to tune
// without hunting through activateBandwidth().
export const REFERRAL_GB_BONUS = 1

// Attribute a new signup to whoever owns `code`, if it's real. Called
// from the signup route right after auth.signUp() returns a user id —
// never allowed to fail the signup itself: every error is caught and
// logged, not thrown. A stale/mistyped/missing referral code should
// never be the reason someone can't create an account.
export async function recordReferralSignup(
  admin: AdminClient,
  code: string | null | undefined,
  newUserId: string
): Promise<void> {
  if (!code || !code.trim()) return
  try {
    const { error } = await admin.rpc('record_referral_signup', {
      p_code: code.trim(),
      p_new_user_id: newUserId,
    })
    if (error) {
      console.error('[referrals] record_referral_signup failed — signup proceeds regardless', newUserId, error)
    }
  } catch (e) {
    console.error('[referrals] record_referral_signup threw — signup proceeds regardless', newUserId, e)
  }
}

// Called from activateBandwidth() *after* the buyer's own GB credit has
// already landed via claim_and_credit_order — this is a pure add-on, and
// every error here is caught and logged, never rethrown. A broken
// referral/commission RPC must never turn an already-successful payment
// into a failed response for the paying customer.
export async function processReferralForOrder(
  admin: AdminClient,
  p: { user_id: string; order_id: string; amount_usd: number }
): Promise<boolean> {
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

    if (referrerProfile?.affiliate_status === 'approved') {
      // Approved affiliate: every qualifying order earns a commission,
      // not just the first. record_affiliate_commission computes the
      // intro-vs-lifetime rate server-side and is idempotent per order_id.
      const { error } = await admin.rpc('record_affiliate_commission', {
        p_referral_id: referral.id,
        p_order_id: p.order_id,
        p_gross_amount: p.amount_usd,
      })
      if (error) { console.error('[referrals] record_affiliate_commission failed', p.order_id, error); return false }
    } else {
      // Standard referral: one-time GB bonus to both sides. Safe to call
      // on every order the referred user ever makes — credit_referral_bonus's
      // own row-lock + null check is what makes it a no-op after the first.
      const { error } = await admin.rpc('credit_referral_bonus', {
        p_referral_id: referral.id,
        p_gb: REFERRAL_GB_BONUS,
      })
      if (error) { console.error('[referrals] credit_referral_bonus failed', p.order_id, error); return false }
    }
    return true
  } catch (e) {
    console.error('[referrals] processReferralForOrder threw — order credit already succeeded, this is non-fatal', p.order_id, e)
    return false
  }
}
