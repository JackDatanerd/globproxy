import { requireMfaVerified } from '@/lib/mfa'
import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
import { requireActiveUser } from '@/lib/apiAuth'
import { rateLimited } from '@/lib/rateLimit'
import { recordReferralSignup, REFERRAL_MIN_ORDER_USD } from '@/lib/referrals'
import { cleanReferralCode, hashIp } from '@/lib/referralAttribution'

// Attach a referral code to an EXISTING account — for people who signed up
// without the link. Only allowed before the account has paid for anything
// (claim_referral_code enforces that), so it can't be used to attribute an
// established customer after the fact.
const MESSAGES: Record<string, { status: number; error?: string }> = {
  recorded: { status: 200 },
  recorded_flagged: { status: 200 }, // accepted; flagged for review server-side, not revealed
  already_referred: { status: 409, error: 'This account already has a referral attached.' },
  invalid_code: { status: 404, error: "We couldn't find that referral code." },
  self_referral: { status: 400, error: "You can't use your own referral code." },
  referrer_inactive: { status: 404, error: "We couldn't find that referral code." },
  has_orders: { status: 409, error: `Referral codes can only be added before your first purchase.` },
  ignored: { status: 400, error: 'Enter a referral code.' },
  error: { status: 500, error: 'Something went wrong — please try again.' },
}

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mfaBlock = await requireMfaVerified(req, user.id)
  if (mfaBlock) return mfaBlock
  const limited = await rateLimited(req, 'AUTH_RATE_LIMITER', 'claim-referral')
  if (limited) return limited
  const inactive = await requireActiveUser(user.id)
  if (inactive) return inactive

  let body: any
  try { body = await req.json() } catch { body = null }
  const code = cleanReferralCode(body?.code)
  if (!code) return NextResponse.json({ error: 'Enter a valid referral code.' }, { status: 400 })

  const admin = await createAdminClient()
  const result = await recordReferralSignup(admin, code, user.id, {
    claim: true,
    ipHash: hashIp(req.headers.get('cf-connecting-ip')),
  })
  const m = MESSAGES[result] ?? MESSAGES.error
  if (m.error) return NextResponse.json({ error: m.error }, { status: m.status })
  return NextResponse.json({ success: true, minOrderUsd: REFERRAL_MIN_ORDER_USD })
}
