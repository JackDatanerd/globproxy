import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { DEFAULT_AFFILIATE_INTRO_RATE, DEFAULT_AFFILIATE_LIFETIME_RATE, validateAffiliateRates } from '@/lib/rates'
import { resolvePendingApplication } from '@/lib/adminApplications'
import { appUrl } from '@/lib/adminEmail'
import { NextResponse } from 'next/server'
import { formatRatePct } from '@/lib/referrals'

// Affiliate status is an independent flag alongside whatever role the
// account already has — approving never touches profiles.role.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const body = await readJson<{ userId?: string; introRate?: unknown; lifetimeRate?: unknown }>(req)
  if (!body || !isUuid(body.userId)) return badRequest('User ID missing or invalid')

  // Same 0-1 range record_affiliate_commission() enforces server-side —
  // validated here too so bad admin input fails with a clear message.
  const rate1 = body.introRate ?? DEFAULT_AFFILIATE_INTRO_RATE
  const rate2 = body.lifetimeRate ?? DEFAULT_AFFILIATE_LIFETIME_RATE
  const rateErr = validateAffiliateRates(rate1, rate2)
  if (rateErr) return badRequest(rateErr)

  const result = await resolvePendingApplication({
    supabase: auth.supabase, adminId: auth.adminId, userId: body.userId,
    statusColumn: 'affiliate_status',
    updates: { affiliate_status: 'approved', affiliate_commission_rate: rate1 as number, affiliate_commission_rate_lifetime: rate2 as number },
    audit: { action: 'affiliate.approve', details: { intro_rate: rate1, lifetime_rate: rate2 } },
    email: {
      subject: 'Your GlobProxy affiliate application was approved',
      heading: 'Affiliate application approved ✓',
      body: (n) => `Hi ${n}, your affiliate application has been approved. You'll earn ${formatRatePct(rate1 as number)} on your referrals' orders for their first 90 days, then ${formatRatePct(rate2 as number)} on all their later orders.`,
      cta: { href: `${appUrl()}/dashboard/referrals`, label: 'Get your referral link →' },
    },
  })
  return result.ok ? NextResponse.json({ success: true }) : result.response
}
