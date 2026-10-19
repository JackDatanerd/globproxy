import { authorizeAdmin, readJson, badRequest, isUuid } from '@/lib/adminAuth'
import { resolvePendingApplication } from '@/lib/adminApplications'
import { appUrl } from '@/lib/adminEmail'
import { NextResponse } from 'next/server'

// Affiliate status is an independent flag alongside whatever role the
// account already has — approving never touches profiles.role.
export async function POST(req: Request) {
  const auth = await authorizeAdmin(req)
  if (!auth.ok) return auth.response
  const body = await readJson<{ userId?: string; introRate?: unknown; lifetimeRate?: unknown }>(req)
  if (!body || !isUuid(body.userId)) return badRequest('User ID missing or invalid')

  // Same 0-1 range record_affiliate_commission() enforces server-side —
  // validated here too so bad admin input fails with a clear message.
  const rate1 = body.introRate ?? 0.30
  const rate2 = body.lifetimeRate ?? 0.15
  if (typeof rate1 !== 'number' || !Number.isFinite(rate1) || rate1 < 0 || rate1 > 1 ||
      typeof rate2 !== 'number' || !Number.isFinite(rate2) || rate2 < 0 || rate2 > 1) {
    return badRequest('Commission rates must be between 0 and 1')
  }

  const result = await resolvePendingApplication({
    supabase: auth.supabase, adminId: auth.adminId, userId: body.userId,
    statusColumn: 'affiliate_status',
    updates: { affiliate_status: 'approved', affiliate_commission_rate: rate1, affiliate_commission_rate_lifetime: rate2 },
    audit: { action: 'affiliate.approve', details: { intro_rate: rate1, lifetime_rate: rate2 } },
    email: {
      subject: 'Your GlobProxy affiliate application was approved',
      heading: 'Affiliate application approved ✓',
      body: (n) => `Hi ${n}, your affiliate application has been approved. You'll earn ${Math.round(rate1 * 100)}% on your referrals' orders for their first 90 days, then ${Math.round(rate2 * 100)}% for as long as they stay active.`,
      cta: { href: `${appUrl()}/dashboard/referrals`, label: 'Get your referral link →' },
    },
  })
  return result.ok ? NextResponse.json({ success: true }) : result.response
}
