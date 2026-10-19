import { createAdminClient } from '@/lib/supabase/server'
import { rateLimited } from '@/lib/rateLimit'
import { cleanReferralCode } from '@/lib/referralAttribution'
import { REFERRAL_GB_BONUS, REFERRAL_MIN_ORDER_USD } from '@/lib/referrals'
import { NextResponse } from 'next/server'

// Public, rate-limited. Lets the signup page say something TRUE about a code:
// whether it's valid and whether the referred user actually gets a bonus
// (affiliate referrals pay the referrer cash and give the new user nothing, so
// promising "you both get 1 GB" there was misleading). Deliberately reveals
// nothing about WHO owns the code.
export async function GET(req: Request) {
  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'ref-check')
  if (limited) return limited

  const code = cleanReferralCode(new URL(req.url).searchParams.get('code'))
  if (!code) return NextResponse.json({ valid: false })

  const admin = await createAdminClient()
  const { data } = await admin
    .from('profiles')
    .select('affiliate_status, is_deleted, is_suspended')
    .eq('referral_code', code)
    .maybeSingle()

  if (!data || data.is_deleted || data.is_suspended) return NextResponse.json({ valid: false })

  return NextResponse.json({
    valid: true,
    bonus: data.affiliate_status !== 'approved' && data.affiliate_status !== 'suspended',
    bonusGb: REFERRAL_GB_BONUS,
    minOrderUsd: REFERRAL_MIN_ORDER_USD,
  })
}
